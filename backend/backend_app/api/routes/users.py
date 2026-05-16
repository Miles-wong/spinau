"""Authenticated user profile routes."""

from flask import Blueprint, g, jsonify, request
from firebase_admin import firestore

from backend_app.api.middleware.auth import require_auth
from backend_app.core.logger import get_logger
from backend_app.services.firestore_service import get_firestore_db

logger = get_logger(__name__)
bp = Blueprint("users", __name__)


@bp.post("/api/users/ensure-profile")
@require_auth
def ensure_user_profile_endpoint():
    """Ensure users/{email} exists without overwriting an assigned role."""
    try:
        email = str(g.email or "").strip().lower()
        if not email:
            return jsonify({"error": "Authenticated account is missing an email"}), 400

        data = request.get_json(silent=True) or {}
        display_name = str(data.get("display_name") or email.split("@")[0]).strip()
        provider = str(data.get("provider") or "").strip()

        db = get_firestore_db()
        user_ref = db.collection("users").document(email)
        snapshot = user_ref.get()

        if snapshot.exists:
            existing = snapshot.to_dict() or {}
            payload = {
                "email": email,
                "display_name": existing.get("display_name") or display_name,
                "is_active": existing.get("is_active", True),
                "updated_at": firestore.SERVER_TIMESTAMP,
            }
            if provider:
                payload["provider"] = provider
            user_ref.set(payload, merge=True)
            role = str(existing.get("role") or "")
        else:
            role = "reporter"
            payload = {
                "email": email,
                "display_name": display_name,
                "role": role,
                "is_active": True,
                "provider": provider,
                "created_at": firestore.SERVER_TIMESTAMP,
                "updated_at": firestore.SERVER_TIMESTAMP,
            }
            user_ref.set(payload)

        return jsonify({"ok": True, "email": email, "role": role}), 200
    except Exception as exc:
        logger.error("ensure_user_profile_endpoint error", exc_info=exc)
        return jsonify({"error": "Unable to ensure user profile"}), 500
