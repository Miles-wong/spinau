"""Conversation flow engine.

This module owns deterministic intake-flow decisions:
- which fields are still missing
- whether enough facts exist to ask inferred fields
- which missing field should be asked next
"""

from typing import Any, Dict, List, Optional

from .schema import get_fact_priority, normalize_issue_type


CYBER_REQUIRED_FIELDS_IN_ORDER = [
    "description",
    "noticed_time",
    "incident_active",
    "response_taken",
]

IT_SUPPORT_REQUIRED_FIELDS_IN_ORDER = [
    "description",
    "noticed_time",
    "incident_active",
    "response_taken",
    "affected_asset",
    "error_symptom",
]


def _get_required_fields_in_order(issue_type: str) -> List[str]:
    normalized = normalize_issue_type(issue_type)
    if normalized == "it_support":
        return IT_SUPPORT_REQUIRED_FIELDS_IN_ORDER
    return CYBER_REQUIRED_FIELDS_IN_ORDER


def has_valid_description(collected: Dict[str, Any], min_length: int = 10) -> bool:
    """Check whether the current description is long enough to count as usable."""
    description = str(collected.get("description", "")).strip()
    return len(description) >= min_length


def has_minimum_core_facts(collected: Dict[str, Any], min_length: int = 10) -> bool:
    """Require the minimum facts needed before asking model-dependent fields."""
    return has_valid_description(collected, min_length=min_length) and bool(
        str(collected.get("noticed_time", "")).strip()
    )


def can_infer_category_and_severity(
    collected: Dict[str, Any], min_length: int = 10
) -> bool:
    """Return whether the state is mature enough to finalize inferred fields."""
    return (
        has_minimum_core_facts(collected, min_length=min_length)
        and "incident_active" in collected
    )


def compute_missing_fields(
    collected: Dict[str, Any], description_min_length: int = 10
) -> List[str]:
    """Return the ordered list of missing fields for the current conversation state.

    Design notes:
    - This function is deterministic and intentionally free from LLM calls.
    - It acts as the canonical source for "what to ask next" eligibility.
    - Ordering is a blend of required-field priority and domain fact priority.
    - Conditional detail fields are only surfaced when their parent answer makes
      them relevant (for example, response details after response_taken=True).
    """
    missing: List[str] = []
    issue_type = normalize_issue_type(collected.get("issue_type", ""))
    is_cyber = issue_type == "cyber"
    domain_resolved = issue_type in {"cyber", "it_support"}

    if issue_type not in {"cyber", "it_support", "not_sure"}:
        return ["issue_type"]

    if not has_valid_description(collected, min_length=description_min_length):
        missing.append("description")

    if not str(collected.get("noticed_time", "")).strip():
        missing.append("noticed_time")

    if "description" in missing:
        return missing

    if "incident_active" not in collected:
        missing.append("incident_active")

    if "response_taken" not in collected:
        missing.append("response_taken")
    elif collected.get("response_taken") and not collected.get("response_details"):
        missing.append("response_details")

    # Keep `not_sure` in a neutral fact-collection stage. This prevents early
    # over-branching into IT-support-specific prompts before domain resolution.
    if issue_type == "it_support":
        if not str(collected.get("affected_asset", "")).strip():
            missing.append("affected_asset")
        if not str(collected.get("error_symptom", "")).strip():
            missing.append("error_symptom")

    if is_cyber:
        if "data_involved_flag" not in collected:
            missing.append("data_involved_flag")
        elif collected.get("data_involved_flag"):
            if (
                not collected.get("data_involved")
                or len(collected.get("data_involved", [])) == 0
            ):
                missing.append("data_involved")
            elif "other" in collected.get("data_involved", []) and not collected.get(
                "data_other_text"
            ):
                missing.append("data_other_text")

    if not str(collected.get("impact_scope", "")).strip():
        missing.append("impact_scope")
    if not str(collected.get("work_continuity", "")).strip():
        missing.append("work_continuity")

    if is_cyber:
        if "external_party_involved" not in collected:
            missing.append("external_party_involved")
        elif collected.get("external_party_involved") and not collected.get(
            "external_party_details"
        ):
            missing.append("external_party_details")

        if "already_reported_to_it" not in collected:
            missing.append("already_reported_to_it")
        elif collected.get("already_reported_to_it") and not collected.get(
            "reported_to_details"
        ):
            missing.append("reported_to_details")

    if not collected.get("preferred_contact_method"):
        missing.append("preferred_contact_method")
    elif collected.get("preferred_contact_method") == "phone" and not collected.get(
        "phone_number"
    ):
        missing.append("phone_number")

    # Category is optional during the core conversation because classification can
    # infer it later. The only enforced detail here is "other" clarification text.
    if (
        can_infer_category_and_severity(collected, min_length=description_min_length)
        and domain_resolved
    ):
        if collected.get("category") == "other" and not collected.get(
            "category_other_text"
        ):
            missing.append("category_other_text")

    # Ask severity only once all earlier missing items are resolved. This keeps
    # the flow focused on factual intake before judgment-oriented classification.
    if not collected.get("severity") and len(missing) == 0:
        if (
            can_infer_category_and_severity(collected, min_length=description_min_length)
            and domain_resolved
        ):
            missing.append("severity")

    # Ask for concrete location detail directly at the end. The flow deliberately
    # avoids a separate location_type step to reduce redundant branching.
    if len(missing) == 0 and not str(collected.get("location_detail", "")).strip():
        missing.append("location_detail")

    missing = list(dict.fromkeys(missing))
    fact_priority = get_fact_priority(issue_type)
    required_fields_in_order = _get_required_fields_in_order(issue_type)
    required_rank = {field: idx for idx, field in enumerate(required_fields_in_order)}
    fact_rank = {field: idx for idx, field in enumerate(fact_priority)}

    def sort_key(field: str) -> tuple[int, int, int]:
        if field == "issue_type" and issue_type == "not_sure":
            return (0, -1, -1)

        # Ask required fields first once they are eligible in the missing list.
        if field in required_rank:
            return (1, required_rank[field], fact_rank.get(field, 999))

        return (2, fact_rank.get(field, 999), 999)

    missing.sort(key=sort_key)
    return missing


def select_next_field(missing: List[str]) -> Optional[str]:
    """Return the next field to ask.

    The list is already sorted by compute_missing_fields; this helper keeps caller
    code explicit and easy to mock in tests.
    """
    if not missing:
        return None
    return missing[0]
