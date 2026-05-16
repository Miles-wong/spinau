"""Firestore data-access layer used by backend routes and permission checks.

The helpers in this module encapsulate collection paths, common query patterns,
and audit-style metadata updates. Keeping Firestore access centralized makes it
safer to evolve document schema and logging behavior without touching route code.
"""

from firebase_admin import firestore
from google.cloud.firestore_v1.base_query import FieldFilter
from typing import Optional, Dict, Any, Tuple
from datetime import datetime
import time
from backend_app.services.firebase_admin_utils import init_firebase_admin
from backend_app.core.logger import get_logger
from constants.incident_schema import ISSUE_TYPES, get_categories_by_issue_type
from constants.validation_limits import (
    MIN_DESCRIPTION_LENGTH,
    MAX_DESCRIPTION_LENGTH,
    USER_ROLE_CACHE_TTL_SECONDS,
    get_validation_errors,
)
from backend_app.ai.classification import (
    classify_report_with_ai,
    infer_category_from_collected,
    infer_issue_type_from_collected,
)

logger = get_logger(__name__)

# Initialize Firestore
_db = None
_user_role_cache: Dict[str, Tuple[str, float]] = {}


def get_firestore_db():
    """Return a lazily initialized Firestore client singleton.

    Using one shared client avoids repeated SDK initialization and keeps route
    handlers lightweight.
    """
    global _db
    if _db is None:
        # Ensure Firebase Admin is initialized
        init_firebase_admin()
        _db = firestore.client()
    return _db


def _get_user_doc_by_email(email: str):
    """Return first users document that matches an authenticated email."""
    if not email:
        return None

    db = get_firestore_db()
    if "@" not in email:
        legacy_uid_doc = db.collection("users").document(email).get()
        if legacy_uid_doc.exists:
            return legacy_uid_doc
    snapshot = (
        db.collection("users")
        .where(filter=FieldFilter("email", "==", email))
        .limit(1)
        .get()
    )
    if snapshot:
        return snapshot[0]

    normalized = email.strip().lower()
    if normalized and normalized != email:
        snapshot = (
            db.collection("users")
            .where(filter=FieldFilter("email", "==", normalized))
            .limit(1)
            .get()
        )
        if snapshot:
            return snapshot[0]

    # Backward compatibility: some environments still use email as document id.
    legacy_doc = db.collection("users").document(normalized or email).get()
    return legacy_doc if legacy_doc.exists else None


def get_user_role(email: str) -> str:
    """
    Get user role from Firestore users collection.

    Args:
        email: Authenticated user email

    Returns:
        str: "admin", "reporter", or "" (empty if not found)
    """
    try:
        now = time.monotonic()
        email = (email or "").strip()
        cached = _user_role_cache.get(email)
        if cached and cached[1] > now:
            # Return cached role to avoid repeated Firestore lookups
            return cached[0]

        user_doc = _get_user_doc_by_email(email)

        if not user_doc or not user_doc.exists:
            logger.info("User not found in Firestore users collection", email=email)
            _user_role_cache[email] = ("", now + USER_ROLE_CACHE_TTL_SECONDS)
            return ""

        role = user_doc.get("role") or ""
        logger.info("Resolved user role", email=email, role=role)

        if role in ["admin", "reporter"]:
            _user_role_cache[email] = (role, now + USER_ROLE_CACHE_TTL_SECONDS)
            return role

        logger.warning("User has invalid role", email=email, role=role)
        _user_role_cache[email] = ("", now + USER_ROLE_CACHE_TTL_SECONDS)
        return ""

    except Exception as e:
        logger.error("Error getting user role", email=email, exc_info=e)
        return ""


def check_rate_limit(
    email: str, action: str = "create_ticket", limit: int = 5, window_seconds: int = 60
) -> bool:
    """
    Check if user has exceeded rate limit.

    Uses Firestore timestamps to track recent actions.

    Args:
        email: Authenticated user email
        action: Action name
        limit: Max actions in window
        window_seconds: Time window

    Returns:
        bool: True if within limit
    """
    try:
        db = get_firestore_db()
        from datetime import datetime, timedelta, timezone

        cutoff_time = datetime.now(timezone.utc) - timedelta(seconds=window_seconds)

        identifier_field = "actor_email" if "@" in (email or "") else "uid"

        # Fast path: server-side time filter (requires composite index)
        try:
            docs = (
                db.collection("audit_logs")
                .where(filter=FieldFilter(identifier_field, "==", email))
                .where(filter=FieldFilter("action", "==", action))
                .where(filter=FieldFilter("created_at", ">", cutoff_time))
                .stream()
            )

            count = sum(1 for _ in docs)
            logger.info(
                "Rate limit fast query",
                email=email,
                action=action,
                count=count,
                limit=limit,
                window_seconds=window_seconds,
            )
            return count < limit

        except Exception as e:
            msg = str(e)
            # Firestore missing composite index fallback
            if "requires an index" not in msg.lower():
                raise

            logger.warning(
                "Missing composite index for rate limit query; using fallback filter",
                email=email,
                action=action,
            )

            docs = (
                db.collection("audit_logs")
                .where(filter=FieldFilter(identifier_field, "==", email))
                .where(filter=FieldFilter("action", "==", action))
                .stream()
            )

            count = 0
            for doc in docs:
                data = doc.to_dict() or {}
                created_at = data.get("created_at")
                # Skip docs where created_at is not yet materialized
                if not created_at:
                    continue

                # Ensure timezone-aware comparison
                try:
                    doc_time = (
                        created_at
                        if created_at.tzinfo
                        else created_at.replace(tzinfo=timezone.utc)
                    )
                except Exception:
                    continue

                if doc_time > cutoff_time:
                    count += 1
                    if count >= limit:
                        break

            logger.info(
                "Rate limit fallback query",
                email=email,
                action=action,
                count=count,
                limit=limit,
                window_seconds=window_seconds,
            )
            return count < limit

    except Exception as e:
        logger.warning(
            "Error checking rate limit, allowing request",
            email=email,
            action=action,
            exc_info=e,
        )
        # Fail open to avoid blocking incident reporting
        return True


def log_action(
    actor_email: str,
    action: str,
    resource_type: str,
    resource_id: Optional[str] = None,
    details: Optional[Dict[str, Any]] = None,
    status: str = "success",
    error_message: Optional[str] = None,
    ip_address: Optional[str] = None,
    user_agent: Optional[str] = None,
) -> str:
    """
    Log an action to Firestore audit_logs collection.

    Args:
        actor_email: Authenticated user email
        action: Action name (e.g., "create_ticket", "classify_incident")
        resource_type: Type of resource (e.g., "ticket", "incident")
        resource_id: ID of resource
        details: Additional details to log
        status: "success" or "failed"
        error_message: If failed
        ip_address: Client IP
        user_agent: Client user-agent

    Returns:
        str: Audit log document ID
    """
    try:
        db = get_firestore_db()
        from firebase_admin import firestore as fs

        actor_email = (actor_email or uid or "").strip().lower()

        log_data = {
            "actor_email": actor_email,
            "uid": uid,
            "action": action,
            "resource_type": resource_type,
            "resource_id": resource_id,
            "details": details or {},
            "status": status,
            "error_message": error_message,
            "ip_address": ip_address,
            "user_agent": user_agent,
            "created_at": fs.SERVER_TIMESTAMP,
        }

        doc_ref = db.collection("audit_logs").add(log_data)
        return doc_ref[1].id  # Returns (timestamp, doc_ref)

    except Exception as e:
        logger.error(
            "Error logging action",
            actor_email=actor_email,
            action=action,
            resource_type=resource_type,
            exc_info=e,
        )
        return ""


def validate_ticket_data(ticket_data: Dict[str, Any]) -> Dict[str, Any]:
    """Validate and normalize raw ticket data before Firestore persistence.
    
    Enforces whitelist, enum constraints, field aliases, data type normalization,
    and domain-specific rules (cyber vs IT support). Raises ValueError if invalid.
    """
    # Canonical fields used by database
    ALLOWED_FIELDS = {
        "description",
        "issue_type",
        "category",
        "category_other_text",
        "severity",
        "noticed_time",
        "location_type",
        "location_detail",
        "response_taken",
        "response_details",
        "affected_asset",
        "error_symptom",
        "incident_active",
        "data_involved_flag",
        "data_involved",
        "data_other_text",
        "work_continuity",
        "impact_scope",
        "external_party_involved",
        "external_party_details",
        "already_reported_to_it",
        "reported_to_details",
        "preferred_contact_method",
        "phone_number",
        "contact_email",
        "needs_triage_review",
    }

    FIELD_ALIASES = {
        "classification": "category",
        "personal_action_taken": "response_taken",
        "personal_action_details": "response_details",
    }

    CATEGORY_ALIASES = {
        "account_compromise": "credential_compromise",
        "data_leak": "data_breach",
        "system_issue": "infrastructure_issue",
    }

    LOCATION_ALIASES = {
        "office": "physical",
        "remote": "device",
        "public_wifi": "network",
    }

    DATA_ALIASES = {
        "customer_data": "personal_info",
        "employee_data": "personal_info",
        "financial_data": "financial",
        "login_credentials": "credentials",
    }

    # Valid enum values
    VALID_ISSUE_TYPES = set(ISSUE_TYPES)
    VALID_CATEGORIES = set(
        get_categories_by_issue_type("cyber")
        + get_categories_by_issue_type("it_support")
    )
    VALID_SEVERITIES = {"low", "medium", "high", "critical"}
    VALID_LOCATION_TYPES = {"email", "device", "network", "physical", "cloud", "other"}
    VALID_DATA_INVOLVED = {
        "personal_info",
        "credentials",
        "financial",
        "company_data",
        "other",
    }
    VALID_CONTACT = {"phone", "email", "in_person", "teams"}
    CYBER_ONLY_FIELDS = {
        "data_involved_flag",
        "data_involved",
        "data_other_text",
        "external_party_involved",
        "external_party_details",
        "already_reported_to_it",
        "reported_to_details",
    }
    IT_SUPPORT_ONLY_FIELDS = {"affected_asset", "error_symptom"}

    def prune_domain_fields(payload: Dict[str, Any], resolved_issue_type: str) -> None:
        if resolved_issue_type == "it_support":
            for field_name in CYBER_ONLY_FIELDS:
                payload.pop(field_name, None)
        elif resolved_issue_type == "cyber":
            for field_name in IT_SUPPORT_ONLY_FIELDS:
                payload.pop(field_name, None)

    def normalize_bool(value: Any) -> Optional[bool]:
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            value_lower = value.strip().lower()
            if value_lower in {"true", "yes", "y", "1"}:
                return True
            if value_lower in {"false", "no", "n", "0"}:
                return False
        return None

    def normalize_noticed_time(value: Any) -> Optional[str]:
        if value is None:
            return None
        if isinstance(value, datetime):
            return value.isoformat()
        if isinstance(value, str):
            text = value.strip()
            if not text:
                return None
            # HTML datetime-local from frontend: YYYY-MM-DDTHH:MM
            try:
                return datetime.fromisoformat(text).isoformat()
            except ValueError:
                # Keep natural-language time text for downstream processing
                return text
        return str(value)

    cleaned = {}

    # 1) Rename alias fields to canonical names
    canonical_input: Dict[str, Any] = {}
    for key, value in ticket_data.items():
        canonical_key = FIELD_ALIASES.get(key, key)
        if canonical_key not in canonical_input or canonical_input[canonical_key] in (
            None,
            "",
        ):
            canonical_input[canonical_key] = value

    # 2) Normalize per-field values
    for key, value in canonical_input.items():
        # Whitelist check
        if key not in ALLOWED_FIELDS:
            continue

        if value is None:
            continue

        if isinstance(value, str):
            value = value.strip()

        if key == "issue_type":
            value = str(value).strip().lower()
            if value not in VALID_ISSUE_TYPES:
                raise ValueError(f"Invalid issue_type: {value}")

        elif key == "category":
            value = str(value).strip().lower()
            value = CATEGORY_ALIASES.get(value, value)
            if value not in VALID_CATEGORIES:
                raise ValueError(f"Invalid category: {value}")

        elif key == "severity":
            value = str(value).strip().lower()
            if value not in VALID_SEVERITIES:
                raise ValueError(f"Invalid severity: {value}")

        elif key == "location_type":
            value = str(value).strip().lower()
            value = LOCATION_ALIASES.get(value, value)
            if value and value not in VALID_LOCATION_TYPES:
                raise ValueError(f"Invalid location_type: {value}")

        elif key == "preferred_contact_method":
            value = str(value).strip().lower()
            if value not in VALID_CONTACT:
                raise ValueError(f"Invalid contact method: {value}")

        elif key in {
            "response_taken",
            "incident_active",
            "data_involved_flag",
            "external_party_involved",
            "already_reported_to_it",
            "needs_triage_review",
        }:
            normalized = normalize_bool(value)
            if normalized is None:
                raise ValueError(f"Invalid boolean value for {key}: {value}")
            value = normalized

        elif key == "noticed_time":
            normalized_time = normalize_noticed_time(value)
            if normalized_time is None:
                continue
            value = normalized_time

        elif key == "data_involved":
            if not isinstance(value, list):
                raise ValueError("data_involved must be an array")
            normalized_items = []
            for item in value:
                item_value = DATA_ALIASES.get(
                    str(item).strip().lower(), str(item).strip().lower()
                )
                if (
                    item_value in VALID_DATA_INVOLVED
                    and item_value not in normalized_items
                ):
                    normalized_items.append(item_value)
            value = normalized_items

        # Keep existing strict enum checks for primary fields
        if key == "category" and value not in VALID_CATEGORIES:
            raise ValueError(f"Invalid category: {value}")
        if key == "severity" and value not in VALID_SEVERITIES:
            raise ValueError(f"Invalid severity: {value}")
        if key == "preferred_contact_method" and value not in VALID_CONTACT:
            raise ValueError(f"Invalid contact method: {value}")

        cleaned[key] = value

    # 3) Resolve domain and fill compatibility defaults for non-critical fields.
    # These defaults keep downstream UI/service logic stable when older clients
    # send partial payloads.
    issue_type = str(cleaned.get("issue_type", "")).strip().lower()
    if issue_type not in VALID_ISSUE_TYPES:
        inferred_issue_type = infer_issue_type_from_collected(
            {
                **ticket_data,
                **cleaned,
            }
        )
        issue_type = (
            inferred_issue_type
            if inferred_issue_type in VALID_ISSUE_TYPES
            else "it_support"
        )

    cleaned["issue_type"] = issue_type
    is_cyber = issue_type != "it_support"
    prune_domain_fields(cleaned, issue_type)

    valid_categories_for_type = set(get_categories_by_issue_type(issue_type))
    category_value = str(cleaned.get("category", "")).strip().lower()
    if category_value and category_value not in valid_categories_for_type:
        raise ValueError(f"Invalid category for {issue_type}: {category_value}")

    if "severity" not in cleaned:
        cleaned["severity"] = "medium"
    if "data_involved" not in cleaned:
        cleaned["data_involved"] = []
    if "response_taken" not in cleaned:
        cleaned["response_taken"] = False
    if not is_cyber:
        if "affected_asset" not in cleaned:
            cleaned["affected_asset"] = ""
        if "error_symptom" not in cleaned:
            cleaned["error_symptom"] = ""

    # Cyber-specific field defaults (only for cyber domain)
    if is_cyber:
        if "external_party_involved" not in cleaned:
            cleaned["external_party_involved"] = False
        if "already_reported_to_it" not in cleaned:
            cleaned["already_reported_to_it"] = False

    # Final submit-time classification. The reporter does not need to provide
    # category/severity manually, but persisted tickets should not be blank.
    try:
        final_classification = classify_report_with_ai(cleaned)
    except Exception as exc:
        logger.warning("Submit-time classification failed", exc_info=exc)
        final_classification = {}

    final_issue_type = str(final_classification.get("issue_type", "")).strip().lower()
    if final_issue_type in VALID_ISSUE_TYPES:
        cleaned["issue_type"] = final_issue_type
        issue_type = final_issue_type
        is_cyber = issue_type != "it_support"
        prune_domain_fields(cleaned, issue_type)
        valid_categories_for_type = set(get_categories_by_issue_type(issue_type))

    final_category = str(final_classification.get("category", "")).strip().lower()
    if final_category and final_category in valid_categories_for_type:
        cleaned["category"] = final_category

    if cleaned.get("category") and cleaned["category"] not in valid_categories_for_type:
        cleaned.pop("category", None)
        cleaned.pop("category_other_text", None)

    final_severity = str(final_classification.get("severity", "")).strip().lower()
    if final_severity in VALID_SEVERITIES:
        cleaned["severity"] = final_severity

    if is_cyber:
        prune_domain_fields(cleaned, "cyber")
        cleaned.setdefault("external_party_involved", False)
        cleaned.setdefault("already_reported_to_it", False)
    else:
        prune_domain_fields(cleaned, "it_support")
        cleaned.setdefault("affected_asset", "")
        cleaned.setdefault("error_symptom", "")

    if not cleaned.get("category"):
        inferred_category = infer_category_from_collected(cleaned)
        if inferred_category and inferred_category in valid_categories_for_type:
            cleaned["category"] = inferred_category

    if not cleaned.get("category"):
        cleaned["category"] = "other"
        cleaned["needs_triage_review"] = True
        cleaned.setdefault("category_other_text", "Needs triage review")
    else:
        cleaned["needs_triage_review"] = bool(cleaned.get("needs_triage_review", False))

    if not cleaned.get("severity"):
        cleaned["severity"] = "medium"
        cleaned["needs_triage_review"] = True

    # Validate description length (single source of truth)
    description = str(cleaned.get("description", "")).strip()
    if not description or len(description) < MIN_DESCRIPTION_LENGTH:
        raise ValueError(get_validation_errors()["description_too_short"])
    if len(description) > MAX_DESCRIPTION_LENGTH:
        raise ValueError(get_validation_errors()["description_too_long"])

    return cleaned
