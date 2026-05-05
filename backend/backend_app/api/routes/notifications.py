"""Notification API routes."""

from flask import Blueprint, g, jsonify, request

from backend_app.api.middleware.auth import require_auth
from backend_app.core.logger import get_logger
from backend_app.services.notification_service import (
    create_ticket_event_notifications,
    list_user_notifications,
    mark_user_notifications_read,
)

logger = get_logger(__name__)
bp = Blueprint("notifications", __name__)


@bp.get("/api/notifications")
@require_auth
def list_notifications_endpoint():
    """Return current user's recent notifications."""
    try:
        raw_limit = request.args.get("limit", "20")
        try:
            limit = max(1, min(100, int(raw_limit)))
        except ValueError:
            limit = 20

        notifications = list_user_notifications(g.uid, limit=limit)
        return jsonify({"notifications": notifications}), 200
    except Exception as exc:
        logger.error("list_notifications_endpoint error", exc_info=exc)
        return jsonify({"error": "Internal server error"}), 500


@bp.post("/api/notifications/mark-read")
@require_auth
def mark_notifications_read_endpoint():
    """Mark current user's notifications as read."""
    try:
        data = request.get_json() or {}
        notification_ids = data.get("notification_ids")
        if notification_ids is not None and not isinstance(notification_ids, list):
            return jsonify({"error": "notification_ids must be a list"}), 400

        updated = mark_user_notifications_read(
            g.uid,
            notification_ids=[str(item) for item in notification_ids] if notification_ids else None,
        )
        return jsonify({"updated": updated}), 200
    except Exception as exc:
        logger.error("mark_notifications_read_endpoint error", exc_info=exc)
        return jsonify({"error": "Internal server error"}), 500


@bp.post("/api/notifications/ticket-event")
@require_auth
def create_ticket_event_notification_endpoint():
    """Create durable notification documents for a ticket event."""
    try:
        data = request.get_json() or {}
        event_type = str(data.get("event_type") or "").strip()
        ticket_id = str(data.get("ticket_id") or "").strip()
        metadata = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}

        if not event_type or not ticket_id:
            return jsonify({"error": "event_type and ticket_id are required"}), 400

        notification_ids = create_ticket_event_notifications(
            actor_uid=g.uid,
            event_type=event_type,
            ticket_doc_id=ticket_id,
            metadata=metadata,
        )

        return jsonify({"created": len(notification_ids), "notification_ids": notification_ids}), 200

    except PermissionError as exc:
        return jsonify({"error": str(exc)}), 403
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.error("create_ticket_event_notification_endpoint error", exc_info=exc)
        return jsonify({"error": "Internal server error"}), 500
