"""Conversational form API routes.

All live conversation state is kept in the module-level ``CONVERSATION_STATES``
dict. For production deployments with multiple workers, replace this with a
Redis or database-backed store.

Endpoints
---------
POST /api/conversation/init
POST /api/conversation/<id>/suggestions
POST /api/conversation/<id>/skip
POST /api/conversation/<id>/message
POST /api/conversation/<id>/message/stream
GET  /api/conversation/<id>/data
"""

import json
import time
import uuid
from collections import defaultdict, deque
from threading import Lock

from flask import Blueprint, Response, g, jsonify, request, stream_with_context

from backend_app.ai import (
    _ai_tracker,
    create_initial_state,
    generate_ai_suggestion_tip,
    generate_next_question_with_ai,
    get_pending_prompt,
    get_next_question,
    is_complete,
    process_user_message,
    process_user_message_stream,
)
from backend_app.ai.ai import MODEL_PROVIDER
from backend_app.core.logger import get_logger
from backend_app.api.middleware.auth import require_auth
from backend_app.services.permissions import can_create_ticket
from rag import build_suggested_action, search_similar_tickets

logger = get_logger(__name__)
bp = Blueprint("conversation", __name__)

# In-memory conversation store.
# Replace with Redis / DB for multi-worker / persistent deployments.
CONVERSATION_STATES: dict = {}

# Lightweight per-process limiter for session creation. The previous path used
# a Firestore audit-log query for every init request even though init events are
# not audit-logged, which added latency without enforcing a useful limit.
INIT_RATE_LIMIT_EVENTS: defaultdict[str, deque[float]] = defaultdict(deque)
INIT_RATE_LIMIT_LOCK = Lock()


def _enforce_init_rate_limit(uid: str, limit: int = 10, window: int = 60) -> None:
    now = time.monotonic()
    with INIT_RATE_LIMIT_LOCK:
        events = INIT_RATE_LIMIT_EVENTS[uid]
        cutoff = now - window

        while events and events[0] < cutoff:
            events.popleft()

        if len(events) >= limit:
            raise ValueError(
                f"Rate limit exceeded: maximum {limit} init_conversation per {window} seconds"
            )

        events.append(now)


# ── helpers ────────────────────────────────────────────────────────────────────

def _resolve_question(
    collected: dict,
    missing: list,
) -> tuple:
    """Return (next_field, next_question, next_hints).

    Always uses template-based questions for speed and consistency.
    The field order and hints are determined by the deterministic flow engine.
    """
    next_field, template_question, next_hints = get_next_question(collected, missing)
    return next_field, template_question, next_hints


def _verify_conversation(uid: str, conversation_id: str):
    """Return (state, None) or (None, error_response).

    Consolidates the repetitive ownership + existence checks.
    """
    if not conversation_id.startswith(uid):
        return None, (jsonify({"error": "Conversation not found"}), 404)
    state = CONVERSATION_STATES.get(conversation_id)
    if not state:
        return None, (jsonify({"error": "Conversation not found"}), 404)
    return state, None


# ── routes ─────────────────────────────────────────────────────────────────────

@bp.post("/api/conversation/init")
@require_auth
def init_conversation():
    """Initialise a new conversational-form session."""
    try:
        uid = g.uid
        logger.info("Initialising conversation", uid=uid)

        if not can_create_ticket(uid):
            return jsonify({"error": "Permission denied"}), 403

        try:
            _enforce_init_rate_limit(uid, limit=10, window=60)
        except Exception as exc:
            return jsonify({"error": str(exc)}), 429

        conversation_id = f"{uid}_{str(uuid.uuid4())[:8]}"
        state = create_initial_state()
        CONVERSATION_STATES[conversation_id] = state
        _ai_tracker.start_session(conversation_id)

        next_field, next_question, next_hints = get_pending_prompt(state)
        if not next_field:
            next_field, next_question, next_hints = _resolve_question(
                state["collected"], state["missing"]
            )

        return jsonify({
            "conversation_id":  conversation_id,
            "initial_message":  state["messages"][0]["content"],
            "collected":        state["collected"],
            "missing":          state["missing"],
            "is_complete":      is_complete(state),
            "turn":             state["turn"],
            "next_field":       next_field,
            "next_question":    next_question,
            "next_hints":       next_hints,
        }), 200

    except Exception as exc:
        logger.error("init_conversation error", exc_info=exc)
        return jsonify({"error": str(exc)}), 500


@bp.post("/api/conversation/<conversation_id>/suggestions")
@require_auth
def get_field_suggestions(conversation_id: str):
    """Generate AI tips for category and severity from collected data so far."""
    try:
        uid = g.uid
        state, err = _verify_conversation(uid, conversation_id)
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
        if category_tip: suggestions["category"] = category_tip
        if severity_tip: suggestions["severity"] = severity_tip

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
    """Mark optional fields as skipped when the reporter has no more information."""
    try:
        uid = g.uid
        state, err = _verify_conversation(uid, conversation_id)
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
            if isinstance(value, bool):  return True
            if isinstance(value, str):   return value.strip() != ""
            if isinstance(value, list):  return len(value) > 0
            return value is not None

        missing_required = [f for f in required_fields if not _has_value(f)]
        if missing_required:
            return jsonify({"error": "Required fields missing", "missing_required": missing_required}), 400

        state["missing"] = []
        CONVERSATION_STATES[conversation_id] = state

        return jsonify({
            "success":    True,
            "message":    "Optional fields skipped. Report is ready to submit.",
            "collected":  state["collected"],
            "missing":    state["missing"],
            "is_complete": True,
            "turn":       state["turn"],
        }), 200

    except Exception as exc:
        logger.error("skip_remaining_fields error", conversation_id=conversation_id, exc_info=exc)
        return jsonify({"error": str(exc)}), 500


@bp.post("/api/conversation/<conversation_id>/message")
@require_auth
def send_message(conversation_id: str):
    """Send a message to the conversational form (non-streaming)."""
    try:
        uid = g.uid
        state, err = _verify_conversation(uid, conversation_id)
        if err:
            return err

        data = request.get_json(silent=True) or {}
        user_message = (data.get("message") or "").strip()
        if not user_message:
            return jsonify({"error": "Message is required"}), 400

        updated_state, assistant_message, extracted_fields = process_user_message(
            user_message, state
        )
        CONVERSATION_STATES[conversation_id] = updated_state

        next_field, next_question, next_hints = get_pending_prompt(updated_state)
        if not next_field:
            next_field, next_question, next_hints = _resolve_question(
                updated_state["collected"], updated_state["missing"]
            )

        if is_complete(updated_state):
            _ai_tracker.print_summary()

        return jsonify({
            "extracted_fields":  extracted_fields,
            "assistant_message": assistant_message,
            "collected":         updated_state["collected"],
            "missing":           updated_state["missing"],
            "is_complete":       is_complete(updated_state),
            "turn":              updated_state["turn"],
            "next_field":        next_field,
            "next_question":     next_question,
            "next_hints":        next_hints,
        }), 200

    except Exception as exc:
        logger.error("send_message error", conversation_id=conversation_id, exc_info=exc)
        return jsonify({"error": str(exc)}), 500


@bp.post("/api/conversation/<conversation_id>/message/stream")
@require_auth
def send_message_stream(conversation_id: str):
    """Send a message with a streaming Server-Sent Events response."""
    try:
        uid = g.uid
        state, err = _verify_conversation(uid, conversation_id)
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
                            "type":  "field_update",
                            "field": event.get("field", ""),
                            "value": event.get("value"),
                        }

                    elif event_type == "chunk":
                        payload = {"type": "chunk", "content": event.get("content", "")}

                    elif event_type == "done":
                        final_state = event["state"]
                        CONVERSATION_STATES[conversation_id] = final_state
                        next_field, next_question, next_hints = get_pending_prompt(final_state)
                        if not next_field:
                            next_field, next_question, next_hints = _resolve_question(
                                final_state["collected"], final_state["missing"]
                            )
                        if is_complete(final_state):
                            _ai_tracker.print_summary()

                        payload = {
                            "type":              "done",
                            "assistant_message": event.get("assistant_message", ""),
                            "collected":         final_state["collected"],
                            "missing":           final_state["missing"],
                            "is_complete":       is_complete(final_state),
                            "turn":              final_state["turn"],
                            "next_field":        next_field,
                            "next_question":     next_question,
                            "next_hints":        next_hints,
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
    """Return the current collected data for a conversation."""
    try:
        uid = g.uid
        state, err = _verify_conversation(uid, conversation_id)
        if err:
            return err

        return jsonify({
            "collected":   state["collected"],
            "missing":     state["missing"],
            "is_complete": is_complete(state),
        }), 200

    except Exception as exc:
        logger.error("get_conversation_data error", conversation_id=conversation_id, exc_info=exc)
        return jsonify({"error": str(exc)}), 500
