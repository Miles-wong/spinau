"""Firestore-backed conversation state persistence helpers."""

import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from firebase_admin import firestore

from backend_app.core.logger import get_logger
from backend_app.services.firestore_service import get_firestore_db

logger = get_logger(__name__)

_COLLECTION = "conversation_states"
_DEFAULT_TTL_HOURS = 24


def _conversation_ttl_hours() -> int:
    """Read conversation TTL in hours from env with safe fallback."""
    raw = str(os.getenv("CONVERSATION_TTL_HOURS", _DEFAULT_TTL_HOURS)).strip()
    try:
        value = int(raw)
        return value if value > 0 else _DEFAULT_TTL_HOURS
    except Exception:
        return _DEFAULT_TTL_HOURS


def _expires_at() -> datetime:
    """Compute per-document expiry timestamp (UTC)."""
    return datetime.now(timezone.utc) + timedelta(hours=_conversation_ttl_hours())


def _is_expired(value: Any) -> bool:
    """Return whether a Firestore timestamp/datetime is already expired."""
    if value is None:
        return False
    try:
        dt = value if isinstance(value, datetime) else value.datetime()
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt <= datetime.now(timezone.utc)
    except Exception:
        return False


def create_conversation_state(conversation_id: str, owner_email: str, state: Dict[str, Any]) -> None:
    """Create a new conversation state document."""
    db = get_firestore_db()
    doc_ref = db.collection(_COLLECTION).document(conversation_id)
    doc_ref.set(
        {
            "owner_email": owner_email,
            "state": state,
            "created_at": firestore.SERVER_TIMESTAMP,
            "updated_at": firestore.SERVER_TIMESTAMP,
            "expires_at": _expires_at(),
        }
    )


def get_conversation_record(conversation_id: str) -> Optional[Dict[str, Any]]:
    """Return full conversation record including owner and state."""
    db = get_firestore_db()
    snapshot = db.collection(_COLLECTION).document(conversation_id).get()
    if not snapshot.exists:
        return None
    data = snapshot.to_dict() or {}
    if _is_expired(data.get("expires_at")):
        try:
            snapshot.reference.delete()
        except Exception:
            logger.warning("Failed deleting expired conversation state", conversation_id=conversation_id)
        return None
    return {
        "id": snapshot.id,
        "owner_email": data.get("owner_email", ""),
        "state": data.get("state") or {},
    }


def update_conversation_state(conversation_id: str, state: Dict[str, Any]) -> None:
    """Upsert state for an existing conversation document."""
    db = get_firestore_db()
    doc_ref = db.collection(_COLLECTION).document(conversation_id)
    doc_ref.set(
        {
            "state": state,
            "updated_at": firestore.SERVER_TIMESTAMP,
            "expires_at": _expires_at(),
        },
        merge=True,
    )


def delete_conversation_state(conversation_id: str) -> None:
    """Delete a conversation state document."""
    db = get_firestore_db()
    db.collection(_COLLECTION).document(conversation_id).delete()
