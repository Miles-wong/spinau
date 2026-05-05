"""Firebase Admin bootstrap and token verification helpers.

This module centralizes Firebase Admin initialization and ID token verification so
all backend entry points share the same behavior. It is intentionally defensive:
- Service-account path resolution supports relative and absolute paths.
- Initialization is idempotent to avoid duplicate app creation.
- Token verification applies a small clock-skew tolerance when supported by the
  installed firebase-admin SDK version.

Public API:
- init_firebase_admin: Initialize the SDK once for the current process.
- verify_id_token: Validate a bearer token and return decoded claims.
- get_firebase_status: Provide a lightweight health/status payload.
"""

import os

from dotenv import load_dotenv

# Import Firebase Admin SDK (real package is loaded by proxy module)
import firebase_admin
from firebase_admin import credentials, auth

# Load environment variables
load_dotenv()

# Firebase Admin initialization state
_initialized = False
# Cache whether verify_id_token supports clock_skew_seconds
_supports_clock_skew = None


def _get_backend_root() -> str:
    """Return backend project root regardless of current module location."""
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def _resolve_service_account_file() -> str:
    """Return path to service account JSON, or empty string to use Application Default Credentials."""
    path = os.getenv("FIREBASE_SERVICE_ACCOUNT", "").strip()
    if not path:
        return ""

    if not os.path.isabs(path):
        path = os.path.join(_get_backend_root(), path)

    if not os.path.exists(path):
        raise RuntimeError(f"Service account file does not exist: {path}")

    return path


def init_firebase_admin():
    """Initialize Firebase Admin SDK (only once)."""
    global _initialized
    if _initialized:
        return

    if firebase_admin._apps:
        _initialized = True
        return

    key_path = _resolve_service_account_file()
    project_id = os.getenv("FIREBASE_PROJECT_ID", "").strip()
    opts = {}
    if project_id:
        opts["projectId"] = project_id

    if key_path:
        print(f"Using service account file: {key_path}")
        cred = credentials.Certificate(key_path)
    else:
        print("Using Application Default Credentials for Firebase Admin SDK")
        cred = credentials.ApplicationDefault()

    if opts:
        firebase_admin.initialize_app(cred, opts)
    else:
        firebase_admin.initialize_app(cred)
    _initialized = True


def verify_id_token(id_token: str) -> dict:
    """Verify Firebase ID Token and return decoded user info.
    
    Adds 5-second clock skew tolerance to avoid failures caused by slight clock drift.
    """
    global _supports_clock_skew
    init_firebase_admin()
    
    # Check support for clock_skew_seconds only once
    if _supports_clock_skew is None:
        try:
            import inspect
            sig = inspect.signature(auth.verify_id_token)
            _supports_clock_skew = 'clock_skew_seconds' in sig.parameters
        except:
            _supports_clock_skew = False
    
    # Use clock skew tolerance when supported
    if _supports_clock_skew:
        return auth.verify_id_token(id_token, check_revoked=False, clock_skew_seconds=5)
    else:
        return auth.verify_id_token(id_token, check_revoked=False)


def get_firebase_status():
    """
    Get status of Firebase initialization.
    
    Returns dict with initialization state and any errors.
    """
    if not _initialized:
        return {
            "initialized": False,
            "project_id": None,
            "error": "Firebase not yet initialized",
        }
    
    try:
        # Try to get the Firebase app instance
        firebase_admin.get_app()
        project_id = os.getenv("FIREBASE_PROJECT_ID", "unknown")
        return {
            "initialized": True,
            "project_id": project_id,
            "error": None,
        }
    except Exception as e:
        return {
            "initialized": False,
            "project_id": None,
            "error": str(e),
        }
