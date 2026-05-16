"""Authentication middleware.

Provides the ``require_auth`` decorator that verifies Firebase ID Tokens
from the ``Authorization: Bearer <token>`` header and injects ``g.email``
(normalized lowercase) into the Flask request context.
"""

from functools import wraps

from flask import g, jsonify, request

from backend_app.services.firebase_admin_utils import verify_id_token
from backend_app.core.logger import get_logger

logger = get_logger(__name__)


def require_auth(fn):
    """Decorator: verify a Firebase ID Token on every request."""

    @wraps(fn)
    def wrapper(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")

        if not auth_header.startswith("Bearer "):
            return jsonify({"error": "Missing or invalid Authorization header"}), 401

        try:
            token = auth_header.split(" ", 1)[1].strip()
            claims = verify_id_token(token)
            g.email = str(claims.get("email", "")).strip().lower()
            if not g.email:
                return jsonify({"error": "Authenticated account is missing an email"}), 401
        except Exception as exc:
            logger.warning("Token verification failed", exc_info=exc)
            return jsonify({"error": "Token verification failed"}), 401

        return fn(*args, **kwargs)

    return wrapper
