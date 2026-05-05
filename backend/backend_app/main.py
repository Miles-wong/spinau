"""Cyber Incident Platform Flask application entry point (backend_app)."""

import os

from dotenv import load_dotenv
from flask import Flask, jsonify
from flask_cors import CORS

from backend_app.core.config import (
    get_allowed_origins,
    get_api_port,
    get_config_status,
    get_model_provider,
    get_required_ai_env_var,
    validate_config,
)
from backend_app.services.firebase_admin_utils import (
    get_firebase_status,
    init_firebase_admin,
)
from backend_app.core.logger import get_logger

load_dotenv()

logger = get_logger(__name__)

try:
    logger.info("Validating configuration...")
    validate_config()
    logger.info("Configuration valid")
except Exception as e:
    logger.error(f"Configuration validation failed: {e}")
    raise

try:
    logger.info("Initialising Firebase Admin SDK")
    init_firebase_admin()
    logger.info("Firebase Admin SDK ready")
except Exception as e:
    logger.error(f"Firebase initialization failed: {e}")
    raise

app = Flask(__name__)

allowed_origins = get_allowed_origins()

CORS(
    app,
    resources={
        r"/api/*": {
            "origins": allowed_origins,
            "supports_credentials": True,
        }
    },
)

from backend_app.api.routes.attachments import bp as attachments_bp
from backend_app.api.routes.admin_exports import bp as admin_exports_bp
from backend_app.api.routes.conversation import bp as conversation_bp
from backend_app.api.routes.notifications import bp as notifications_bp
from backend_app.api.routes.tickets import bp as tickets_bp

app.register_blueprint(tickets_bp)
app.register_blueprint(attachments_bp)
app.register_blueprint(conversation_bp)
app.register_blueprint(admin_exports_bp)
app.register_blueprint(notifications_bp)


@app.get("/api/health")
def health_check():
    """Return detailed health status including Firebase and AI provider status."""
    firebase_status = get_firebase_status()
    model_provider = get_model_provider()
    ai_key_name = get_required_ai_env_var(model_provider)
    ai_configured = bool(os.getenv(ai_key_name, "").strip())

    config_status = get_config_status()
    has_warnings = config_status["status"] == "warning"
    has_errors = config_status["status"] == "error"
    overall_status = "error" if has_errors else ("warning" if has_warnings else "ok")

    return jsonify(
        {
            "status": overall_status,
            "message": (
                "Backend is running"
                if overall_status == "ok"
                else f"Backend running with {overall_status}"
            ),
            "backend": {
                "running": True,
                "port": get_api_port(),
            },
            "firebase": firebase_status,
            "ai_provider": {
                "configured": ai_configured,
                "provider": model_provider if ai_configured else "none",
            },
            "config": {
                "warnings": config_status["warnings"],
                "errors": config_status["errors"],
            },
        }
    ), 200


@app.errorhandler(404)
def not_found(_error):
    return jsonify({"error": "Endpoint not found"}), 404


@app.errorhandler(500)
def internal_error(_error):
    return jsonify({"error": "Internal server error"}), 500


if __name__ == "__main__":
    port = get_api_port()
    logger.info(f"Starting dev server on http://127.0.0.1:{port}")
    app.run(debug=True, host="127.0.0.1", port=port)
