"""Ticket-related API routes.

Endpoints
---------
POST /api/validate-and-classify
    Validate ticket data before the frontend creates the Firestore document.

POST /api/log-ticket-created
    Write an audit-log entry after the Firestore document is successfully created.
"""

from flask import Blueprint, g, jsonify, request
from firebase_admin import firestore

from backend_app.services.firestore_service import get_firestore_db, log_action, validate_ticket_data
from backend_app.core.logger import get_logger
from backend_app.api.middleware.auth import require_auth
from backend_app.services.permissions import can_create_ticket, can_update_ticket, can_view_ticket, enforce_rate_limit
from backend_app.services.notification_service import create_ticket_event_notifications, get_user_display_name
from rag import build_suggested_action, search_similar_tickets
from constants.validation_limits import (
    MIN_DESCRIPTION_LENGTH,
    RAG_SEARCH_TOP_K_VALIDATE,
    RAG_SEARCH_TOP_K_ADMIN,
    RAG_SIMILAR_TICKETS_DISPLAY_LIMIT,
    AI_SUMMARY_DESCRIPTION_MAX_LENGTH,
    AI_SUMMARY_RESOLUTION_MAX_LENGTH,
    RATE_LIMIT_CREATE_TICKET_PER_WINDOW,
    RATE_LIMIT_WINDOW_SECONDS,
    get_validation_errors,
)

logger = get_logger(__name__)
bp = Blueprint("tickets", __name__)


def _build_ai_ready_summary(cleaned_data, similar_tickets):
    """Build a compact AI summary for triage (truncates description and resolution)."""
    issue_type = cleaned_data.get("issue_type") or "unknown"
    category = cleaned_data.get("category") or "other"
    severity = cleaned_data.get("severity") or "medium"
    description = (cleaned_data.get("description") or "").strip()

    summary_parts = [
        f"Issue type: {issue_type}",
        f"Category: {category}",
        f"Severity: {severity}",
    ]

    if description:
        summary_parts.append(f"Description: {description[:AI_SUMMARY_DESCRIPTION_MAX_LENGTH]}")

    if similar_tickets:
        top_match = similar_tickets[0]
        summary_parts.append(
            "Most similar previous ticket: "
            f"{top_match.get('ticket_id')} ({top_match.get('category') or 'unknown'}, score={top_match.get('score')})"
        )
        if top_match.get("resolution"):
            summary_parts.append(f"Reference resolution: {top_match['resolution'][:AI_SUMMARY_RESOLUTION_MAX_LENGTH]}")

    return " | ".join(summary_parts)


def _serialize_ticket_snapshot(ticket_data, similar_tickets):
    return {
        "similar_tickets": similar_tickets,
        "suggested_action": build_suggested_action(similar_tickets),
        "ai_summary": _build_ai_ready_summary(ticket_data, similar_tickets),
    }


class TicketAlreadyAssignedError(Exception):
    """Raised when an admin tries to claim a ticket already assigned."""

    def __init__(self, assigned_to_uid: str, assigned_to_name: str):
        super().__init__("Ticket is already assigned")
        self.assigned_to_uid = assigned_to_uid
        self.assigned_to_name = assigned_to_name


class TicketNotFoundError(Exception):
    """Raised when the requested ticket does not exist."""


@bp.post("/api/validate-and-classify")
@require_auth
def validate_and_classify_endpoint():
    """Validate ticket data and return RAG suggestions before frontend creates document.
    
    Permission check + rate limit + data validation + RAG search (for category hints).
    """
    try:
        uid = g.uid
        logger.info("validate-and-classify request", uid=uid)

        if not can_create_ticket(uid):
            logger.warning("Permission denied", uid=uid, route="validate-and-classify")
            return jsonify({"valid": False, "error": get_validation_errors()["insufficient_permissions"]}), 403

        try:
            enforce_rate_limit(uid, "create_ticket", limit=RATE_LIMIT_CREATE_TICKET_PER_WINDOW, window=RATE_LIMIT_WINDOW_SECONDS)
        except Exception as exc:
            logger.warning("Rate limit exceeded", uid=uid, error=str(exc))
            return jsonify({"valid": False, "error": str(exc)}), 429

        data = request.get_json()
        if not data:
            return jsonify({"valid": False, "error": get_validation_errors()["empty_request"]}), 400

        try:
            cleaned_data = validate_ticket_data(data)
        except ValueError as exc:
            return jsonify({"valid": False, "error": str(exc)}), 400

        # RAG search for category/severity hints only (not displayed to reporter)
        description = cleaned_data.get("description", "").strip()
        similar_tickets = search_similar_tickets(
            description,
            top_k=RAG_SEARCH_TOP_K_VALIDATE,
            issue_type=cleaned_data.get("issue_type"),
        )

        return jsonify({
            "valid": True,
            "message": "Data is valid, ticket can be created",
            "ticket_data": cleaned_data,
            **_serialize_ticket_snapshot(cleaned_data, similar_tickets),
        }), 200

    except Exception as exc:
        logger.error("validate_and_classify_endpoint error", exc_info=exc)
        return jsonify({"valid": False, "error": "Internal server error"}), 500


@bp.get("/api/tickets/<ticket_id>/similar")
@require_auth
def get_similar_tickets_for_ticket(ticket_id: str):
    """Retrieve similar historical tickets for admin triage review (permission-gated).
    
    Used only in TicketDetailView when canEdit=true (admin). Filters out self-references.
    """
    try:
        uid = g.uid
        db = get_firestore_db()
        ticket_ref = db.collection("tickets").document(ticket_id)
        snapshot = ticket_ref.get()

        if not snapshot.exists:
            return jsonify({"error": "Ticket not found"}), 404

        ticket_data = snapshot.to_dict() or {}
        created_by_uid = str(ticket_data.get("created_by_uid") or ticket_data.get("created_by") or "")
        if not can_view_ticket(uid, created_by_uid):
            return jsonify({"error": "Permission denied"}), 403

        description = str(ticket_data.get("description") or "").strip()
        if len(description) < MIN_DESCRIPTION_LENGTH:
            return jsonify({"similar_tickets": [], "suggested_action": "", "ai_summary": ""}), 200

        # Fetch more similar tickets, filter out self-reference, limit display
        similar_tickets = [
            item for item in search_similar_tickets(
                description,
                top_k=RAG_SEARCH_TOP_K_ADMIN,
                issue_type=ticket_data.get("issue_type"),
            )
            if str(item.get("doc_id") or "") != ticket_id
        ][:RAG_SIMILAR_TICKETS_DISPLAY_LIMIT]

        return jsonify(_serialize_ticket_snapshot(ticket_data, similar_tickets)), 200

    except Exception as exc:
        logger.error("get_similar_tickets_for_ticket error", ticket_id=ticket_id, exc_info=exc)
        return jsonify({"error": "Internal server error"}), 500


@bp.post("/api/tickets/<ticket_id>/claim")
@require_auth
def claim_ticket_endpoint(ticket_id: str):
    """Atomically assign an unassigned ticket to the current admin."""
    try:
        uid = g.uid
        if not can_update_ticket(uid):
            return jsonify({"error": "Insufficient permissions: cannot claim ticket"}), 403

        db = get_firestore_db()
        ticket_ref = db.collection("tickets").document(ticket_id)
        assignee_name = get_user_display_name(uid)
        transaction = db.transaction()

        @firestore.transactional
        def _claim_in_transaction(txn):
            snapshot = ticket_ref.get(transaction=txn)
            if not snapshot.exists:
                raise TicketNotFoundError()

            ticket_data = snapshot.to_dict() or {}
            existing_assignee = str(ticket_data.get("assigned_to_uid") or "").strip()
            if existing_assignee:
                raise TicketAlreadyAssignedError(
                    existing_assignee,
                    str(ticket_data.get("assigned_to_name") or existing_assignee),
                )

            current_status = str(ticket_data.get("status") or "").strip().lower()
            next_status = "assigned" if current_status in {"", "open"} else current_status

            txn.update(ticket_ref, {
                "assigned_to_uid": uid,
                "assigned_to_name": assignee_name,
                "status": next_status,
                "updated_at": firestore.SERVER_TIMESTAMP,
                "updated_by_uid": uid,
                "last_update_hint": f"assigned to {assignee_name}",
            })

            return {
                "ticket_id": str(ticket_data.get("ticket_id") or ticket_id),
                "previous_status": current_status,
                "status": next_status,
            }

        result = _claim_in_transaction(transaction)

        log_action(
            uid=uid,
            action="claim_ticket",
            resource_type="ticket",
            resource_id=ticket_id,
            details={
                "assigned_to_uid": uid,
                "assigned_to_name": assignee_name,
                "previous_status": result.get("previous_status"),
                "status": result.get("status"),
            },
            status="success",
        )

        try:
            create_ticket_event_notifications(
                actor_uid=uid,
                event_type="ticket_assigned",
                ticket_doc_id=ticket_id,
                metadata={
                    "assigned_to_uid": uid,
                    "assigned_to_name": assignee_name,
                },
            )
        except Exception as exc:
            logger.warning("claim ticket notification failed", ticket_id=ticket_id, exc_info=exc)

        return jsonify({
            "claimed": True,
            "ticket_id": result.get("ticket_id"),
            "assigned_to_uid": uid,
            "assigned_to_name": assignee_name,
            "status": result.get("status"),
        }), 200

    except TicketAlreadyAssignedError as exc:
        return jsonify({
            "claimed": False,
            "error": "Ticket is already assigned",
            "assigned_to_uid": exc.assigned_to_uid,
            "assigned_to_name": exc.assigned_to_name,
        }), 409
    except TicketNotFoundError:
        return jsonify({"claimed": False, "error": "Ticket not found"}), 404
    except Exception as exc:
        logger.error("claim_ticket_endpoint error", ticket_id=ticket_id, exc_info=exc)
        return jsonify({"claimed": False, "error": "Internal server error"}), 500


@bp.post("/api/log-ticket-created")
@require_auth
def log_ticket_created_endpoint():
    """Write an audit-log entry after the frontend creates the Firestore document."""
    try:
        uid = g.uid
        data = request.get_json() or {}

        log_action(
            uid=uid,
            action="create_ticket",
            resource_type="ticket",
            resource_id=data.get("doc_id", ""),
            details={
                "ticket_id": data.get("ticket_id"),
                "category":  data.get("category"),
                "severity":  data.get("severity"),
            },
            status="success",
        )

        return jsonify({"logged": True}), 200

    except Exception as exc:
        logger.warning("Audit log failed for log-ticket-created", exc_info=exc)
        return jsonify({"logged": False}), 500
