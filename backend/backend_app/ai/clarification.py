"""Global clarification helpers for unclear, off-topic, or partial answers."""

import re
from typing import Any, Dict, List, Optional, Tuple
from .schema import FORM_SCHEMA


FIELD_EXAMPLES: Dict[str, List[str]] = {
    "reported_to_details": [
        "I reported it to Tom from IT at 2:30 PM today.",
        "Reported to Security Helpdesk this afternoon.",
    ],
    "response_details": [
        "Disconnected the laptop from network and reset account password.",
        "Deleted the email and reported to my manager and IT.",
    ],
    "external_party_details": [
        "Informed vendor Acme by email to security@acme.com.",
        "Called third-party support team and shared incident ID.",
    ],
    "location_detail": [
        "Work laptop asset LT-2048.",
        "Office email account john.doe@company.com.",
    ],
    "impact_scope": [
        "Impacted my account and one shared mailbox.",
        "Potentially impacts customer billing system.",
    ],
    "work_continuity": [
        "Cannot access email and VPN for now.",
        "Work is delayed but partially available.",
    ],
    "phone_number": [
        "+1-555-0123",
        "+86 138 0013 8000",
    ],
}


WEAK_REPLIES = {
    "ok", "okay", "k", "yes", "no", "idk", "whatever", "noted", "received", "not sure", "n/a", "none"
}


def evaluate_reply_quality(
    user_message: str,
    expected_field: Optional[str],
    extracted_patch: Dict[str, Any],
    current_missing: List[str],
    previous_missing: Optional[List[str]] = None,
    failed_attempts: int = 0,
) -> Tuple[bool, Optional[str], Optional[str]]:
    """
    Evaluate if we should ask a clarification instead of moving on.
    """
    if not expected_field:
        return True, None, None

    text = (user_message or "").strip()
    lowered = text.lower()
    before_missing = set(previous_missing or [])
    after_missing = set(current_missing or [])

    expected_value = extracted_patch.get(expected_field)
    expected_schema = FORM_SCHEMA.get(expected_field, {})
    expected_type = expected_schema.get("type", "string")

    # Even if the field looks resolved, reject low-quality values.
    if expected_value is not None and not _is_value_sufficient(expected_field, expected_value):
        return False, expected_field, build_clarification_message(expected_field, failed_attempts)

    # Field resolved with sufficient quality -> no clarification needed.
    if expected_field in before_missing and expected_field not in after_missing:
        return True, None, None

    # No extraction for expected field and field still missing.
    if expected_field in after_missing and expected_value is None:
        # Description is special: accept a sufficiently rich narrative and let extraction fallback fill it.
        if expected_field == "description" and _looks_like_meaningful_description_text(text):
            return True, None, None

        # For boolean fields, only standard weak_reply checks apply, not yes/no
        if expected_type != "boolean":
            # Non-boolean: check off-topic, length, and weak replies
            if _looks_off_topic(lowered) or len(text) < 2 or _is_weak_reply(lowered):
                return False, expected_field, build_clarification_message(expected_field, failed_attempts)
        else:
            # Boolean field: off-topic is still bad, but yes/no alone is not weak
            if _looks_off_topic(lowered) or len(text) < 2:
                return False, expected_field, build_clarification_message(expected_field, failed_attempts)
            # Check weak replies but exclude yes/no from weak reply list for boolean fields
            weak_but_not_yes_no = [w for w in WEAK_REPLIES if w not in {"yes", "no"}]
            if lowered.strip(" .,!?:;，。！？；") in weak_but_not_yes_no:
                return False, expected_field, build_clarification_message(expected_field, failed_attempts)
        
        # The expected field is still missing; clarify directly with examples.
        return False, expected_field, build_clarification_message(expected_field, failed_attempts)

    return True, None, None


def _looks_like_meaningful_description_text(text: str) -> bool:
    stripped = (text or "").strip()
    if len(stripped) < 20:
        return False

    lowered = stripped.lower()
    weak_values = {
        "1", "0", "ok", "okay", "yes", "no", "y", "n", "true", "false", "unknown", "na", "n/a", "none"
    }
    if lowered in weak_values:
        return False

    # Accept multi-clause natural language descriptions.
    if re.search(r"[A-Za-z\u4e00-\u9fff]", stripped) and (" " in stripped or "，" in stripped or "," in stripped):
        return True
    return False


def build_clarification_message(field_name: str, failed_attempts: int = 0) -> str:
    """Create a clarification prompt with examples tailored to the requested field."""
    schema = FORM_SCHEMA.get(field_name, {})
    label = schema.get("label", field_name.replace("_", " ").title())
    field_type = schema.get("type", "string")

    prompt = f"It looks like your reply is unclear. I need to confirm: {label}."

    if failed_attempts >= 1:
        prompt = f"I still don't have a valid response for: {label}."

    type_hint = ""
    if field_type == "boolean":
        type_hint = "Please answer Yes or No."
    elif field_type == "enum":
        options = schema.get("enum", [])
        if options:
            type_hint = f"Options include: {', '.join(options[:4])}{' ...' if len(options) > 4 else ''}."
    elif field_type == "array":
        options = schema.get("items", [])
        if options:
            type_hint = f"You can provide one or more, e.g.: {', '.join(options[:4])}{' ...' if len(options) > 4 else ''}."

    examples = FIELD_EXAMPLES.get(field_name, _generic_examples_for_field(field_name, field_type))
    example_text = "\n".join([f"- {example}" for example in examples[:2]])

    return (
        f"{prompt}\n"
        f"{type_hint}\n"
        "Here are some examples:\n"
        f"{example_text}"
    ).strip()


def _is_value_sufficient(field_name: str, value: Any) -> bool:
    """Decide whether an extracted answer contains enough detail to keep."""
    if isinstance(value, bool):
        return True

    text = str(value or "").strip()
    lowered = text.lower()
    if not text:
        return False

    low_signal_phrases = {
        "do not have detail",
        "don't have detail",
        "no detail",
        "no details",
        "not sure",
        "unknown",
        "cannot provide details",
        "no concrete detail",
    }
    normalized = " ".join(lowered.split())
    if len(normalized) <= 40 and normalized in low_signal_phrases:
        return False

    if field_name == "reported_to_details":
        return _has_who_and_when(text)

    if field_name in {"response_details", "external_party_details", "impact_scope", "work_continuity"}:
        return len(text) >= 8

    if field_name == "phone_number":
        return bool(re.search(r"\+?\d[\d\s\-()]{5,}", text))

    return len(text) >= 2


def _has_who_and_when(text: str) -> bool:
    """Require both a contact target and a rough time indicator in escalation details."""
    lowered = text.lower()
    has_when = bool(
        re.search(r"\b\d{1,2}:\d{2}\b", lowered)
        or re.search(r"\b\d{1,2}\s?(am|pm)\b", lowered)
        or any(k in lowered for k in ["today", "yesterday", "morning", "afternoon", "evening", "this afternoon"])
    )
    # Who can be a name, team, department token.
    tokens = [t.strip(" ,.;:") for t in re.split(r"\s+|,", text) if t.strip(" ,.;:")]
    has_who = len(tokens) >= 2 and any(len(t) >= 2 for t in tokens)
    return has_when and has_who


def _looks_off_topic(lowered: str) -> bool:
    """Detect replies that acknowledge the question without adding usable content."""
    off_topic_keywords = [
        "idk", "whatever", "skip", "later", "not sure", "dont know",
        "do not have", "don't have", "no update", "no information",
        "maybe later", "acknowledged", "received", "nothing to add", "no new information"
    ]
    return any(k in lowered for k in off_topic_keywords)


def _is_weak_reply(lowered: str) -> bool:
    """Strip punctuation before checking whether a reply is too weak to use."""
    normalized = lowered.strip(" .,!?:;，。！？；")
    return normalized in WEAK_REPLIES


def _generic_examples_for_field(field_name: str, field_type: str) -> List[str]:
    """Provide fallback examples when no field-specific samples exist."""
    if field_type == "boolean":
        return ["Yes", "No"]
    if field_type == "enum":
        enum_values = FORM_SCHEMA.get(field_name, {}).get("enum", [])
        return [", ".join(enum_values[:3])] if enum_values else ["Use one valid option"]
    return [
        "Please provide one clear sentence with concrete details.",
        "Include key facts like who, when, and what if applicable.",
    ]


