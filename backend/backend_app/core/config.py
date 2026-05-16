"""
Configuration management and validation for Cyber Incident Platform.

This module:
  1. Loads environment variables
  2. Validates required configuration items on startup
  3. Provides a clean status report of missing or invalid config

To check config without running the app:
    from config import validate_config
    validate_config()
"""

import os
from typing import Dict, List, Tuple

from dotenv import load_dotenv


load_dotenv()


def _get_backend_root() -> str:
    """Return backend project root regardless of current module location."""
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


class ConfigError(Exception):
    """Raised when configuration validation fails."""


def uses_firebase_application_default() -> bool:
    """True when no service-account JSON path is set (e.g. Cloud Run workload identity)."""
    return not os.getenv("FIREBASE_SERVICE_ACCOUNT", "").strip()


def _check_file_exists(env_var: str, description: str) -> Tuple[bool, str]:
    """Check if a file referenced by env var exists."""
    path = os.getenv(env_var, "").strip()
    if not path:
        return False, f"missing {env_var}"

    if not os.path.isabs(path):
        path = os.path.join(_get_backend_root(), path)

    if not os.path.exists(path):
        return False, f"{env_var} file not found: {path}"

    return True, f"ok {description}"


def _check_env_var(env_var: str, description: str) -> Tuple[bool, str]:
    """Check if an environment variable is set and non-empty."""
    value = os.getenv(env_var, "").strip()
    if not value:
        return False, f"missing {env_var}"
    return True, f"ok {description}"


def get_model_provider() -> str:
    """Get the configured AI provider."""
    return os.getenv("MODEL_PROVIDER", "openai").strip().lower() or "openai"


def get_required_ai_env_var(provider: str) -> str:
    """Return the API key env var name required by the configured provider."""
    provider_key_map = {
        "openai": "OPENAI_API_KEY",
        "deepseek": "DEEPSEEK_API_KEY",
        "gemini": "GEMINI_API_KEY",
    }
    return provider_key_map.get(provider, "OPENAI_API_KEY")


def _default_allowed_origins() -> str:
    return "http://localhost:5173,http://127.0.0.1:5173"


def get_config_status() -> Dict:
    """
    Validate all critical configuration items.
    Returns a status dict with 'status', 'errors', and 'warnings'.
    """
    errors: List[str] = []
    warnings: List[str] = []
    checks: Dict[str, Tuple[bool, str]] = {}

    if uses_firebase_application_default():
        is_valid, msg = _check_env_var(
            "FIREBASE_PROJECT_ID",
            "Firebase project ID (required with Application Default Credentials)",
        )
        checks["firebase_key"] = (is_valid, f"ADC mode: {msg}")
        if not is_valid:
            errors.append(
                "missing FIREBASE_PROJECT_ID (required when FIREBASE_SERVICE_ACCOUNT is unset for ADC)",
            )
    else:
        is_valid, msg = _check_file_exists(
            "FIREBASE_SERVICE_ACCOUNT",
            "Firebase service account key",
        )
        checks["firebase_key"] = (is_valid, msg)
        if not is_valid:
            errors.append(msg)

    is_valid, msg = _check_env_var("MODEL_NAME", "LLM model id (EXTRACTION_MODEL / ASSISTANT_MODEL)")
    checks["model_name"] = (is_valid, msg)
    if not is_valid:
        errors.append(
            "missing MODEL_NAME (required — same variable read at import in backend_app.ai.ai)",
        )

    if os.getenv("PORT", "").strip():
        checks["api_port"] = (True, "ok API port (from PORT)")
    else:
        is_valid, msg = _check_env_var("API_PORT", "API port")
        checks["api_port"] = (is_valid, msg)
        if not is_valid:
            warnings.append(f"{msg} (using default 5000)")

    is_valid, msg = _check_env_var("ALLOWED_ORIGINS", "CORS allowed origins")
    checks["cors"] = (is_valid, msg)
    cors_raw = os.getenv("ALLOWED_ORIGINS", "").strip()
    default_cors = _default_allowed_origins()
    if not is_valid:
        warnings.append(f"{msg} (using default)")
    elif os.getenv("PORT", "").strip() and cors_raw == default_cors:
        warnings.append(
            "ALLOWED_ORIGINS is still localhost-only; set it to your production frontend "
            "(e.g. https://YOUR_PROJECT.web.app) or browsers on Hosting will hit CORS errors",
        )

    provider = get_model_provider()
    required_ai_env_var = get_required_ai_env_var(provider)
    is_valid, msg = _check_env_var(required_ai_env_var, f"{provider} API key")
    checks["ai_provider_key"] = (is_valid, msg)
    if not is_valid:
        warnings.append(f"{msg} (AI features disabled for provider '{provider}')")

    if not uses_firebase_application_default():
        is_valid, msg = _check_env_var("FIREBASE_PROJECT_ID", "Firebase project ID")
        checks["firebase_project"] = (is_valid, msg)
        if not is_valid:
            warnings.append(f"{msg} (may fail at runtime)")
    else:
        checks["firebase_project"] = (True, "ok Firebase project ID (required for ADC)")

    return {
        "status": "error" if errors else ("warning" if warnings else "ok"),
        "errors": errors,
        "warnings": warnings,
        "checks": checks,
    }


def validate_config() -> None:
    """Validate configuration on startup. Raises ConfigError if critical config is missing."""
    status = get_config_status()

    if status["status"] == "error":
        error_lines = ["\nConfiguration validation failed:"]
        for error in status["errors"]:
            error_lines.append(f"  - {error}")
        raise ConfigError("\n".join(error_lines))

    if status["warnings"]:
        warning_lines = ["\nConfiguration warnings:"]
        for warning in status["warnings"]:
            warning_lines.append(f"  - {warning}")
        print("\n".join(warning_lines))


def get_firebase_service_account_path() -> str:
    """Get resolved Firebase service account file path (empty string when using ADC)."""
    raw = os.getenv("FIREBASE_SERVICE_ACCOUNT", "").strip()
    if not raw:
        return ""
    if os.path.isabs(raw):
        return raw
    return os.path.join(_get_backend_root(), raw)


def get_api_port() -> int:
    """Listen port: Cloud Run sets ``PORT``; locally use ``API_PORT`` or 5000."""
    port_raw = (os.getenv("PORT") or os.getenv("API_PORT") or "5000").strip()
    return int(port_raw)


def get_allowed_origins() -> List[str]:
    """Get CORS allowed origins."""
    raw = os.getenv("ALLOWED_ORIGINS", _default_allowed_origins())
    return [o.strip() for o in raw.split(",") if o.strip()]
