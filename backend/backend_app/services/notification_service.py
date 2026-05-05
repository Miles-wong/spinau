"""Notification persistence helpers.

Notifications are stored as durable per-user documents under:
    users/{uid}/notifications/{notification_id}

The frontend may still perform some ticket writes directly during the current
transition, but notification creation is centralized here so future FCM/email
delivery can listen to one stable data shape.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Set

from firebase_admin import firestore
from google.cloud.firestore_v1.base_query import FieldFilter

from backend_app.core.logger import get_logger
from backend_app.services.firestore_service import get_firestore_db, get_user_role

logger = get_logger(__name__)


NOTIFICATION_CHANNELS = ["in_app"]
NOTIFICATION_TTL_DAYS = 90

EVENT_TYPES = {
    "ticket_created",
    "ticket_comment",
    "ticket_status_changed",
    "ticket_admin_updated",
    "ticket_assigned",
    "reporter_completed_fields",
}


def _as_text(value: Any, fallback: str = "") -> str:
    text = str(value or "").strip()
    return text or fallback


def _display_ticket_id(ticket_id: str, ticket_data: Dict[str, Any]) -> str:
    return _as_text(ticket_data.get("ticket_id"), ticket_id)


def list_admin_uids(limit: int = 200) -> List[str]:
    """Return known admin UIDs from the users collection."""
    db = get_firestore_db()
    docs = (
        db.collection("users")
        .where(filter=FieldFilter("role", "==", "admin"))
        .limit(limit)
        .stream()
    )
    return [doc.id for doc in docs]


def get_user_display_name(uid: str) -> str:
    """Resolve a user-facing display label from users/{uid}."""
    if not uid:
        return "Someone"

    try:
        db = get_firestore_db()
        doc = db.collection("users").document(uid).get()
        if not doc.exists:
            return uid

        data = doc.to_dict() or {}
        return (
            _as_text(data.get("display_name"))
            or _as_text(data.get("name"))
            or _as_text(data.get("email"))
            or uid
        )
    except Exception:
        logger.warning("Failed to resolve user display name", uid=uid)
        return uid


def create_notification(
    *,
    recipient_uid: str,
    notification_type: str,
    ticket_id: str,
    actor_uid: str,
    actor_display_name: Optional[str] = None,
    title: str,
    body: str,
    channels: Optional[List[str]] = None,
    metadata: Optional[Dict[str, Any]] = None,
    dedupe_key: Optional[str] = None,
) -> str:
    """Create one notification document and return its id."""
    db = get_firestore_db()
    payload = {
        "recipient_uid": recipient_uid,
        "type": notification_type,
        "ticket_id": ticket_id,
        "actor_uid": actor_uid,
        "actor_display_name": actor_display_name or get_user_display_name(actor_uid),
        "title": title,
        "body": body,
        "created_at": firestore.SERVER_TIMESTAMP,
        "read_at": None,
        "expires_at": datetime.now(timezone.utc) + timedelta(days=NOTIFICATION_TTL_DAYS),
        "channels": channels or NOTIFICATION_CHANNELS,
        "delivery_status": {
            "in_app": "created",
            "push": "not_requested",
            "email": "not_requested",
        },
        "metadata": metadata or {},
    }
    if dedupe_key:
        payload["dedupe_key"] = dedupe_key

    _write_time, doc_ref = (
        db.collection("users")
        .document(recipient_uid)
        .collection("notifications")
        .add(payload)
    )
    logger.info(
        "Created notification",
        recipient_uid=recipient_uid,
        notification_id=doc_ref.id,
        notification_type=notification_type,
        ticket_id=ticket_id,
    )
    return doc_ref.id


def _serialize_notification(doc) -> Dict[str, Any]:
    data = doc.to_dict() or {}
    created_at = data.get("created_at")
    read_at = data.get("read_at")
    return {
        "id": doc.id,
        **data,
        "created_at": created_at.isoformat() if hasattr(created_at, "isoformat") else created_at,
        "read_at": read_at.isoformat() if hasattr(read_at, "isoformat") else read_at,
    }


def list_user_notifications(uid: str, limit: int = 20) -> List[Dict[str, Any]]:
    """Return recent notifications for one user."""
    db = get_firestore_db()
    docs = (
        db.collection("users")
        .document(uid)
        .collection("notifications")
        .order_by("created_at", direction=firestore.Query.DESCENDING)
        .limit(limit)
        .stream()
    )
    return [_serialize_notification(doc) for doc in docs]


def mark_user_notifications_read(uid: str, notification_ids: Optional[List[str]] = None) -> int:
    """Mark selected notifications, or all recent unread notifications, as read."""
    db = get_firestore_db()
    collection_ref = db.collection("users").document(uid).collection("notifications")
    now = firestore.SERVER_TIMESTAMP

    if notification_ids:
        count = 0
        batch = db.batch()
        for notification_id in notification_ids:
            if not notification_id:
                continue
            batch.update(collection_ref.document(notification_id), {"read_at": now})
            count += 1
        if count:
            batch.commit()
        return count

    docs = collection_ref.where(filter=FieldFilter("read_at", "==", None)).limit(100).stream()
    count = 0
    batch = db.batch()
    for doc in docs:
        batch.update(doc.reference, {"read_at": now})
        count += 1
    if count:
        batch.commit()
    return count


def _format_changed_fields(fields: Any) -> str:
    if not isinstance(fields, list):
        return "ticket details"

    labels = {
        "issue_type": "issue type",
        "status": "status",
        "assigned_to_uid": "assignee",
        "assigned_to_name": "assignee",
        "category": "category",
        "severity": "severity",
        "closure_summary": "closure summary",
        "lessons_learned": "lessons learned",
        "duplicate_of_ticket_id": "duplicate link",
        "related_ticket_ids": "related tickets",
    }
    readable = [labels.get(str(field), str(field).replace("_", " ")) for field in fields if field]
    if not readable:
        return "ticket details"
    if len(readable) == 1:
        return readable[0]
    if len(readable) == 2:
        return f"{readable[0]} and {readable[1]}"
    return f"{', '.join(readable[:-1])}, and {readable[-1]}"


def _build_message(
    event_type: str,
    ticket_id: str,
    ticket_data: Dict[str, Any],
    metadata: Dict[str, Any],
    actor_display_name: str,
) -> tuple[str, str]:
    display_id = _display_ticket_id(ticket_id, ticket_data)
    status = _as_text(metadata.get("status") or ticket_data.get("status"))
    assigned_to_name = _as_text(metadata.get("assigned_to_name") or ticket_data.get("assigned_to_name"))

    if event_type == "ticket_created":
        return "Ticket needs triage", f"{actor_display_name} submitted unassigned ticket {display_id}."
    if event_type == "ticket_comment":
        return "New comment", f"{actor_display_name} commented on ticket {display_id}."
    if event_type == "ticket_status_changed":
        pretty_status = status.replace("_", " ").title() if status else "updated"
        return "Ticket status updated", f"{actor_display_name} changed ticket {display_id} status to {pretty_status}."
    if event_type == "ticket_assigned":
        assignee = assigned_to_name or "a team member"
        return "Ticket assigned", f"{actor_display_name} assigned ticket {display_id} to {assignee}."
    if event_type == "reporter_completed_fields":
        changed = _format_changed_fields(metadata.get("changed_fields"))
        return "Reporter added details", f"{actor_display_name} added {changed} to ticket {display_id}."
    if event_type == "ticket_admin_updated":
        changed = _format_changed_fields(metadata.get("changed_fields"))
        return "Assigned ticket updated", f"{actor_display_name} updated {changed} on ticket {display_id}."
    return "Ticket updated", f"{actor_display_name} updated ticket {display_id}."


def _unique_recipients(candidates: Iterable[str], actor_uid: str) -> List[str]:
    seen: Set[str] = set()
    recipients: List[str] = []
    for uid in candidates:
        uid = _as_text(uid)
        if not uid or uid == actor_uid or uid in seen:
            continue
        seen.add(uid)
        recipients.append(uid)
    return recipients


def create_ticket_event_notifications(
    *,
    actor_uid: str,
    event_type: str,
    ticket_doc_id: str,
    metadata: Optional[Dict[str, Any]] = None,
) -> List[str]:
    """Create notifications for a ticket event after validating recipients."""
    if event_type not in EVENT_TYPES:
        raise ValueError(f"Unsupported notification event type: {event_type}")

    db = get_firestore_db()
    ticket_ref = db.collection("tickets").document(ticket_doc_id)
    snapshot = ticket_ref.get()
    if not snapshot.exists:
        raise ValueError("Ticket not found")

    ticket_data = snapshot.to_dict() or {}
    owner_uid = _as_text(ticket_data.get("created_by_uid"))
    assigned_to_uid = _as_text(ticket_data.get("assigned_to_uid"))
    actor_role = get_user_role(actor_uid)
    metadata = metadata or {}

    if event_type == "ticket_created":
        if actor_uid != owner_uid:
            raise PermissionError("Only the ticket owner can send this notification")
        # New unassigned tickets are broadcast to the admin triage pool. If a
        # ticket is ever created pre-assigned, notify only that assignee.
        recipients = [assigned_to_uid] if assigned_to_uid else list_admin_uids()
    elif event_type == "reporter_completed_fields":
        if actor_uid != owner_uid:
            raise PermissionError("Only the ticket owner can send this notification")
        # Reporter-side updates after assignment belong to the assigned admin.
        # If still unassigned, all admins remain responsible for triage.
        recipients = [assigned_to_uid] if assigned_to_uid else list_admin_uids()
    elif event_type == "ticket_comment":
        if actor_role == "admin":
            # Admin comments are user-facing; notify the reporter.
            recipients = [owner_uid]
        elif actor_uid == owner_uid:
            # Reporter comments go to the assignee, or to the triage pool while
            # the ticket is still unassigned.
            recipients = [assigned_to_uid] if assigned_to_uid else list_admin_uids()
        else:
            raise PermissionError("You cannot notify for this ticket")
    elif event_type in {"ticket_status_changed", "ticket_admin_updated"}:
        if actor_role != "admin":
            raise PermissionError("Only admins can send this notification")
        # Admin-origin updates are user-facing for the reporter. If another
        # admin edits a ticket owned by an assigned admin, also notify the
        # assignee as an internal handoff signal. The actor never receives
        # their own notification.
        recipients = [owner_uid]
        if assigned_to_uid and actor_uid != assigned_to_uid:
            recipients.append(assigned_to_uid)
    elif event_type == "ticket_assigned":
        if actor_role != "admin":
            raise PermissionError("Only admins can send this notification")
        next_assignee = _as_text(metadata.get("assigned_to_uid") or assigned_to_uid)
        recipients = [owner_uid]
        if next_assignee and next_assignee != actor_uid:
            recipients.append(next_assignee)
    else:
        if actor_role != "admin":
            raise PermissionError("Only admins can send this notification")
        recipients = []

    recipients = _unique_recipients(recipients, actor_uid)
    if not recipients:
        return []

    actor_display_name = get_user_display_name(actor_uid)
    title, body = _build_message(event_type, ticket_doc_id, ticket_data, metadata, actor_display_name)
    notification_ids: List[str] = []
    for recipient_uid in recipients:
        notification_ids.append(
            create_notification(
                recipient_uid=recipient_uid,
                notification_type=event_type,
                ticket_id=ticket_doc_id,
                actor_uid=actor_uid,
                actor_display_name=actor_display_name,
                title=title,
                body=body,
                metadata={
                    **metadata,
                    "actor_display_name": actor_display_name,
                    "ticket_display_id": _display_ticket_id(ticket_doc_id, ticket_data),
                    "assigned_to_uid": assigned_to_uid,
                    "ticket_status": _as_text(ticket_data.get("status")),
                    "issue_type": _as_text(ticket_data.get("issue_type")),
                    "category": _as_text(ticket_data.get("category")),
                    "severity": _as_text(ticket_data.get("severity")),
                },
            )
        )
    return notification_ids
