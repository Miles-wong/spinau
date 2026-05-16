"""Conversational form API routes.

Conversation state is persisted in Firestore by ``conversation_id`` so the
session survives page refreshes and process restarts.

Endpoints
---------
POST /api/conversation/init
POST /api/conversation/<id>/suggestions
POST /api/conversation/<id>/skip
POST /api/conversation/<id>/message
POST /api/conversation/<id>/message/stream
GET  /api/conversation/<id>/data
DELETE /api/conversation/<id>
"""

import json
import time
import uuid
from collections import defaultdict, deque
from threading import Lock, Thread

from flask import Blueprint, Response, g, jsonify, request, stream_with_context

from backend_app.ai import (
    _ai_tracker,
    create_initial_state,
    generate_ai_suggestion_tip,
    get_pending_prompt,
    get_next_question,
    is_complete,
    process_user_message,
    process_user_message_stream,
)
from backend_app.ai.classification import classify_issue_type_conflict_with_strong_model
from backend_app.ai.conversation import apply_issue_type_arbitration_result
from backend_app.core.logger import get_logger
from backend_app.api.middleware.auth import require_auth
from backend_app.services.permissions import can_create_ticket
from backend_app.services.conversation_store import (
    create_conversation_state,
    delete_conversation_state,
    get_conversation_record,
    update_conversation_state,
)
from rag import build_suggested_action, search_similar_tickets

logger = get_logger(__name__)
bp = Blueprint("conversation", __name__)

INIT_RATE_LIMIT_EVENTS: defaultdict[str, deque[float]] = defaultdict(deque)
INIT_RATE_LIMIT_LOCK = Lock()


def _enforce_init_rate_limit(email: str, limit: int = 10, window: int = 60) -> None:
    now = time.monotonic()
    with INIT_RATE_LIMIT_LOCK:
        events = INIT_RATE_LIMIT_EVENTS[email]
        cutoff = now - window

        while events and events[0] < cutoff:
            events.popleft()

        if len(events) >= limit:
            raise ValueError(
                f"Rate limit exceeded: maximum {limit} init_conversation per {window} seconds"
            )

        events.append(now)


def _resolve_question(collected: dict, missing: list) -> tuple:
    next_field, template_question, next_hints = get_next_question(collected, missing)
    return next_field, template_question, next_hints


def _verify_conversation(email: str, conversation_id: str):
    if not conversation_id.startswith(email):
        return None, (jsonify({"error": "Conversation not found"}), 404)
    record = get_conversation_record(conversation_id)
    if not record:
        return None, (jsonify({"error": "Conversation not found"}), 404)
    owner_email = str(record.get("owner_email") or "")
    if owner_email != email:
        return None, (jsonify({"error": "Conversation not found"}), 404)
    state = record.get("state") or {}
    return state, None


def _maybe_start_issue_type_arbitration(conversation_id: str, state: dict) -> None:
    pending = state.get("pending_issue_type_arbitration")
    if not isinstance(pending, dict) or pending.get("status") != "pending":
        return

    running_state = {
        **state,
        "pending_issue_type_arbitration": {**pending, "status": "running"},
    }
    update_conversation_state(conversation_id, running_state)

    def _worker() -> None:
        try:
            record = get_conversation_record(conversation_id)
            if not record:
                return
            latest_state = record.get("state") or {}
            latest_pending = latest_state.get("pending_issue_type_arbitration") or {}
            if latest_pending.get("status") != "running":
                return

            collected_snapshot = latest_pending.get("collected_snapshot") or latest_state.get("collected", {})
            result = classify_issue_type_conflict_with_strong_model(
                collected=collected_snapshot,
                direct_issue_type=latest_pending.get("direct_issue_type") or {},
                local_issue_type=str(latest_pending.get("local_issue_type") or ""),
            )

            record = get_conversation_record(conversation_id)
            if not record:
                return
            latest_state = record.get("state") or {}
            if result:
                updated_state = apply_issue_type_arbitration_result(latest_state, result)
            else:
                failed_pending = dict(latest_state.get("pending_issue_type_arbitration") or {})
                failed_pending["status"] = "failed"
                updated_state = {
                    **latest_state,
                    "pending_issue_type_arbitration": failed_pending,
                }
            update_conversation_state(conversation_id, updated_state)
        except Exception as exc:
            logger.error("issue_type_arbitration_worker error", conversation_id=conversation_id, exc_info=exc)

    Thread(target=_worker, daemon=True).start()


@bp.post("/api/conversation/init")
@require_auth
def init_conversation():
    try:
        email = g.email
        logger.info("Initialising conversation", email=email)

        if not can_create_ticket(email):
            return jsonify({"error": "Permission denied"}), 403

        try:
            _enforce_init_rate_limit(email, limit=10, window=60)
        except Exception as exc:
            return jsonify({"error": str(exc)}), 429

        data = request.get_json(silent=True) or {}
        requested_conversation_id = str(data.get("conversation_id") or "").strip()

        conversation_id = requested_conversation_id
        state = None
        if requested_conversation_id and requested_conversation_id.startswith(email):
            existing_record = get_conversation_record(requested_conversation_id)
            if existing_record and str(existing_record.get("owner_email") or "") == email:
                state = existing_record.get("state") or {}

        if not state:
            conversation_id = f"{email}_{str(uuid.uuid4())[:8]}"
            state = create_initial_state()
            create_conversation_state(conversation_id, email, state)
            _ai_tracker.start_session(conversation_id)

        next_field, next_question, next_hints = get_pending_prompt(state)
        if not next_field:
            next_field, next_question, next_hints = _resolve_question(
                state["collected"], state["missing"]
            )

        return jsonify({
            "conversation_id": conversation_id,
            "initial_message": state["messages"][0]["content"],
            "messages": state.get("messages", []),
            "collected": state["collected"],
            "missing": state["missing"],
            "is_complete": is_complete(state),
            "turn": state["turn"],
            "next_field": next_field,
            "next_question": next_question,
            "next_hints": next_hints,
        }), 200

    except Exception as exc:
        logger.error("init_conversation error", exc_info=exc)
        return jsonify({"error": str(exc)}), 500


@bp.post("/api/conversation/<conversation_id>/suggestions")
@require_auth
def get_field_suggestions(conversation_id: str):
    try:
        email = g.email
        state, err = _verify_conversation(email, conversation_id)
        if err:
            return err

        description = str(state["collected"].get("description", "")).strip()
        if len(description) < 10:
            return jsonify({"suggestions": {}, "similar_tickets": [], "suggested_action": ""}), 200

        category_tip = generate_ai_suggestion_tip(state["collected"], "category")
        severity_tip = generate_ai_suggestion_tip(state["collected"], "severity")
        similar_tickets = search_similar_tickets(
            description,
            top_k=3,
            issue_type=state["collected"].get("issue_type"),
        )
        suggested_action = build_suggested_action(similar_tickets)

        suggestions = {}
        if category_tip:
            suggestions["category"] = category_tip
        if severity_tip:
            suggestions["severity"] = severity_tip

        return jsonify({
            "suggestions": suggestions,
            "similar_tickets": similar_tickets,
            "suggested_action": suggested_action,
        }), 200

    except Exception as exc:
        logger.error("get_field_suggestions error", conversation_id=conversation_id, exc_info=exc)
        return jsonify({"error": str(exc)}), 500


@bp.post("/api/conversation/<conversation_id>/skip")
@require_auth
def skip_remaining_fields(conversation_id: str):
    try:
        email = g.email
        state, err = _verify_conversation(email, conversation_id)
        if err:
            return err

        issue_type = str(state["collected"].get("issue_type", "")).strip().lower() or "cyber"

        required_fields = [
            "issue_type", "description", "noticed_time", "incident_active", "response_taken",
            "impact_scope", "work_continuity",
            "preferred_contact_method", "category", "severity",
        ]
        if issue_type == "cyber":
            required_fields.extend([
                "data_involved_flag",
                "external_party_involved",
                "already_reported_to_it",
            ])

        def _has_value(field_name: str) -> bool:
            value = state["collected"].get(field_name)
            if isinstance(value, bool):
                return True
            if isinstance(value, str):
                return value.strip() != ""
            if isinstance(value, list):
                return len(value) > 0
            return value is not None

        missing_required = [f for f in required_fields if not _has_value(f)]
        if missing_required:
            return jsonify({"error": "Required fields missing", "missing_required": missing_required}), 400

        state["missing"] = []
        update_conversation_state(conversation_id, state)

        return jsonify({
            "success": True,
            "message": "Optional fields skipped. Report is ready to submit.",
            "collected": state["collected"],
            "missing": state["missing"],
            "is_complete": True,
            "turn": state["turn"],
        }), 200

    except Exception as exc:
        logger.error("skip_remaining_fields error", conversation_id=conversation_id, exc_info=exc)
        return jsonify({"error": str(exc)}), 500


@bp.post("/api/conversation/<conversation_id>/message")
@require_auth
def send_message(conversation_id: str):
    try:
        email = g.email
        state, err = _verify_conversation(email, conversation_id)
        if err:
            return err

        data = request.get_json(silent=True) or {}
        user_message = (data.get("message") or "").strip()
        if not user_message:
            return jsonify({"error": "Message is required"}), 400

        updated_state, assistant_message, extracted_fields = process_user_message(
            user_message, state
        )
        update_conversation_state(conversation_id, updated_state)
        _maybe_start_issue_type_arbitration(conversation_id, updated_state)

        next_field, next_question, next_hints = get_pending_prompt(updated_state)
        if not next_field:
            next_field, next_question, next_hints = _resolve_question(
                updated_state["collected"], updated_state["missing"]
            )

        if is_complete(updated_state):
            _ai_tracker.print_summary()

        return jsonify({
            "extracted_fields": extracted_fields,
            "assistant_message": assistant_message,
            "collected": updated_state["collected"],
            "missing": updated_state["missing"],
            "is_complete": is_complete(updated_state),
            "turn": updated_state["turn"],
            "next_field": next_field,
            "next_question": next_question,
            "next_hints": next_hints,
        }), 200

    except Exception as exc:
        logger.error("send_message error", conversation_id=conversation_id, exc_info=exc)
        return jsonify({"error": str(exc)}), 500


@bp.post("/api/conversation/<conversation_id>/message/stream")
@require_auth
def send_message_stream(conversation_id: str):
    try:
        email = g.email
        state, err = _verify_conversation(email, conversation_id)
        if err:
            return err

        data = request.get_json(silent=True) or {}
        user_message = (data.get("message") or "").strip()
        if not user_message:
            return jsonify({"error": "Message is required"}), 400

        def event_stream():
            logger.info("Stream started", conversation_id=conversation_id)
            try:
                for event in process_user_message_stream(user_message, state):
                    event_type = event.get("type")

                    if event_type == "status":
                        payload = {"type": "status", "message": event.get("message", "")}

                    elif event_type == "field_update":
                        payload = {
                            "type": "field_update",
                            "field": event.get("field", ""),
                            "value": event.get("value"),
                        }

                    elif event_type == "chunk":
                        payload = {"type": "chunk", "content": event.get("content", "")}

                    elif event_type == "done":
                        final_state = event["state"]
                        update_conversation_state(conversation_id, final_state)
                        _maybe_start_issue_type_arbitration(conversation_id, final_state)
                        next_field, next_question, next_hints = get_pending_prompt(final_state)
                        if not next_field:
                            next_field, next_question, next_hints = _resolve_question(
                                final_state["collected"], final_state["missing"]
                            )
                        if is_complete(final_state):
                            _ai_tracker.print_summary()

                        payload = {
                            "type": "done",
                            "assistant_message": event.get("assistant_message", ""),
                            "collected": final_state["collected"],
                            "missing": final_state["missing"],
                            "is_complete": is_complete(final_state),
                            "turn": final_state["turn"],
                            "next_field": next_field,
                            "next_question": next_question,
                            "next_hints": next_hints,
                        }

                    elif event_type == "error":
                        payload = {"type": "error", "message": event.get("message", "Unknown error")}

                    else:
                        continue

                    yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

            except Exception as exc:
                logger.error("event_stream error", conversation_id=conversation_id, exc_info=exc)
                yield f"data: {json.dumps({'type': 'error', 'message': str(exc)}, ensure_ascii=False)}\n\n"

        return Response(
            stream_with_context(event_stream()),
            mimetype="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    except Exception as exc:
        logger.error("send_message_stream error", conversation_id=conversation_id, exc_info=exc)
        return jsonify({"error": str(exc)}), 500


@bp.get("/api/conversation/<conversation_id>/data")
@require_auth
def get_conversation_data(conversation_id: str):
    try:
        email = g.email
        state, err = _verify_conversation(email, conversation_id)
        if err:
            return err

        return jsonify({
            "collected": state["collected"],
            "missing": state["missing"],
            "is_complete": is_complete(state),
            "messages": state.get("messages", []),
            "turn": state.get("turn", 0),
        }), 200

    except Exception as exc:
        logger.error("get_conversation_data error", conversation_id=conversation_id, exc_info=exc)
        return jsonify({"error": str(exc)}), 500


@bp.delete("/api/conversation/<conversation_id>")
@require_auth
def delete_conversation(conversation_id: str):
    try:
        email = g.email
        _state, err = _verify_conversation(email, conversation_id)
        if err:
            return err

        delete_conversation_state(conversation_id)
        return jsonify({"deleted": True}), 200

    except Exception as exc:
        logger.error("delete_conversation error", conversation_id=conversation_id, exc_info=exc)
        return jsonify({"error": str(exc)}), 500
