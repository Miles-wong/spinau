"""Static schema definitions for the incident-intake conversational form.

Contains:
- FORM_SCHEMA       Per-field metadata (type, enum values, label, required flag, question role).
- EXTRACTION_SCHEMA Compact schema handed to the LLM for structured extraction.
- QUESTION_PRIORITY Ordered list that controls which field is asked next.
- FOLLOW_UP_RULES   Conditional fields triggered by a parent field's value.
- ARRAY_FOLLOW_UP_RULES  Same as above but for array-typed answers.
- AI_INFERRED_FIELDS     Fields the model fills automatically (not actively asked).
- FACT_FIELDS            Fields reporters answer directly from memory.
- Extraction tuning constants (token limits, speed mode, sampling params).
"""

import os

from constants.incident_schema import (
    ALL_CATEGORIES,
    CONTACT_METHODS,
    DATA_TYPES_INVOLVED,
    ISSUE_TYPES,
    LOCATION_TYPES,
    SEVERITY_LEVELS,
    get_issue_type_profile,
)


FORM_ISSUE_TYPES = [*ISSUE_TYPES, "not_sure"]

COMMON_FACT_FIELDS = [
    "issue_type",
    "description",
    "noticed_time",
    "incident_active",
    "response_taken",
    "response_details",
    "impact_scope",
    "work_continuity",
    "preferred_contact_method",
    "phone_number",
]

CYBER_FACT_FIELDS = [
    "data_involved_flag",
    "data_involved",
    "data_other_text",
    "external_party_involved",
    "external_party_details",
    "already_reported_to_it",
    "reported_to_details",
]

IT_SUPPORT_FACT_FIELDS = [
    "affected_asset",
    "error_symptom",
]

COMMON_FACT_FIELD_SET = set(COMMON_FACT_FIELDS)
CYBER_FACT_FIELD_SET = set(CYBER_FACT_FIELDS)
IT_SUPPORT_FACT_FIELD_SET = set(IT_SUPPORT_FACT_FIELDS)


FORM_SCHEMA = {
    "issue_type": {
        "type": "enum",
        "enum": FORM_ISSUE_TYPES,
        "ai_writable": False,
        "label": "Issue Type",
        "required": True,
        "question_role": "fact",
    },
    "description": {
        "type": "string",
        "min_length": 10,
        "max_length": 5000,
        "ai_writable": True,
        "label": "Incident Description",
        "required": True,
        "question_role": "fact",
    },
    "category": {
        "type": "enum",
        "enum": ALL_CATEGORIES,
        "ai_writable": True,
        "label": "Incident Category",
        "required": True,
        "question_role": "ai_inferred",
    },
    "category_other_text": {
        "type": "string",
        "max_length": 500,
        "ai_writable": True,
        "label": "Category Details (if other)",
        "question_role": "ai_inferred",
    },
    "severity": {
        "type": "enum",
        "enum": SEVERITY_LEVELS,
        "ai_writable": True,
        "label": "Severity",
        "required": True,
        "question_role": "ai_inferred",
    },
    "location_type": {
        "type": "enum",
        "enum": LOCATION_TYPES,
        "ai_writable": True,
        "label": "Location Type",
        "required": False,
        "question_role": "optional",
    },
    "location_detail": {
        "type": "string",
        "max_length": 500,
        "ai_writable": True,
        "label": "Location Details",
        "required": False,
        "question_role": "optional",
    },
    "noticed_time": {
        "type": "string",
        "ai_writable": True,
        "label": "Time Noticed",
        "required": True,
        "question_role": "fact",
    },
    "response_taken": {
        "type": "boolean",
        "ai_writable": True,
        "label": "Have you taken any action?",
        "required": True,
        "question_role": "fact",
    },
    "response_details": {
        "type": "string",
        "max_length": 1000,
        "ai_writable": True,
        "label": "Action Details",
        "question_role": "fact",
    },
    "affected_asset": {
        "type": "string",
        "max_length": 500,
        "ai_writable": True,
        "label": "Affected Asset",
        "question_role": "fact",
    },
    "error_symptom": {
        "type": "string",
        "max_length": 1000,
        "ai_writable": True,
        "label": "Error Symptom",
        "question_role": "fact",
    },
    "data_involved_flag": {
        "type": "boolean",
        "ai_writable": True,
        "label": "Does this involve sensitive data?",
        "required": True,
        "question_role": "fact",
    },
    "data_involved": {
        "type": "array",
        "items": DATA_TYPES_INVOLVED,
        "ai_writable": True,
        "label": "Types of Data Involved",
        "question_role": "fact",
    },
    "data_other_text": {
        "type": "string",
        "max_length": 500,
        "ai_writable": True,
        "label": "Other Data Type Details",
        "question_role": "fact",
    },
    "incident_active": {
        "type": "boolean",
        "ai_writable": True,
        "label": "Is the incident still active?",
        "required": True,
        "question_role": "fact",
    },
    "impact_scope": {
        "type": "string",
        "max_length": 1000,
        "ai_writable": True,
        "label": "Impact Scope",
        "required": True,
        "question_role": "fact",
    },
    "work_continuity": {
        "type": "string",
        "max_length": 1000,
        "ai_writable": True,
        "label": "Work Continuity Impact",
        "required": True,
        "question_role": "fact",
    },
    "external_party_involved": {
        "type": "boolean",
        "ai_writable": True,
        "label": "External party involved?",
        "required": True,
        "question_role": "fact",
    },
    "external_party_details": {
        "type": "string",
        "max_length": 1000,
        "ai_writable": True,
        "label": "External Party Details",
        "question_role": "fact",
    },
    "already_reported_to_it": {
        "type": "boolean",
        "ai_writable": True,
        "label": "Already reported to IT?",
        "required": True,
        "question_role": "fact",
    },
    "reported_to_details": {
        "type": "string",
        "max_length": 500,
        "ai_writable": True,
        "label": "Who/when reported to IT",
        "question_role": "fact",
    },
    "preferred_contact_method": {
        "type": "enum",
        "enum": CONTACT_METHODS,
        "ai_writable": True,
        "label": "Preferred Contact Method",
        "required": True,
        "question_role": "fact",
    },
    "phone_number": {
        "type": "string",
        "max_length": 20,
        "ai_writable": True,
        "label": "Phone Number",
        "question_role": "fact",
    },
}


EXTRACTION_SCHEMA = {
    "issue_type": FORM_ISSUE_TYPES,
    "description": "string (detailed incident description)",
    "category": ALL_CATEGORIES,
    "category_other_text": "string (if category is other)",
    "severity": SEVERITY_LEVELS,
    "location_type": LOCATION_TYPES,
    "location_detail": "string",
    "noticed_time": "string (date/time or natural language)",
    "response_taken": "boolean",
    "response_details": "string",
    "affected_asset": "string (device, system, app, account, printer, network, or service affected)",
    "error_symptom": "string (what is going wrong, error shown, broken behaviour, or failure symptom)",
    "data_involved_flag": "boolean",
    "data_involved": DATA_TYPES_INVOLVED,
    "data_other_text": "string",
    "incident_active": "boolean",
    "impact_scope": "string",
    "work_continuity": "string",
    "external_party_involved": "boolean",
    "external_party_details": "string",
    "already_reported_to_it": "boolean",
    "reported_to_details": "string",
    "preferred_contact_method": CONTACT_METHODS,
    "phone_number": "string",
}

EXTRACTION_MAX_TOKENS = 220
EXTRACTION_FAST_MAX_TOKENS = int(os.environ.get("EXTRACTION_FAST_MAX_TOKENS", "180"))

EXTRACTION_SPEED_MODE = os.environ.get("EXTRACTION_SPEED", "fast").lower()
EXTRACTION_TOP_P = 0.7 if EXTRACTION_SPEED_MODE == "fast" else 1.0


# Ask fact-based fields first because reporters can answer them directly.
QUESTION_PRIORITY = [
    *COMMON_FACT_FIELDS,
    *IT_SUPPORT_FACT_FIELDS,
    *CYBER_FACT_FIELDS,
    # Let AI infer these first and ask them only if still unresolved.
    "category",
    "category_other_text",
    "severity",
    "location_detail",
]


# Conditional follow-up rules used when a parent field implies extra detail is required.
FOLLOW_UP_RULES = {
    "response_taken": {
        True: ["response_details"],
    },
    "data_involved_flag": {
        True: ["data_involved"],
    },
    "external_party_involved": {
        True: ["external_party_details"],
    },
    "already_reported_to_it": {
        True: ["reported_to_details"],
    },
    "preferred_contact_method": {
        "phone": ["phone_number"],
    },
}


# Conditional follow-up rules for array-type answers.
ARRAY_FOLLOW_UP_RULES = {
    "data_involved": {
        "other": ["data_other_text"],
    },
}


def normalize_issue_type(issue_type: str) -> str:
    normalized = str(issue_type or "").strip().lower()
    return normalized if normalized in {"cyber", "it_support", "not_sure"} else ""


def get_domain_fact_fields(issue_type: str) -> list[str]:
    normalized = normalize_issue_type(issue_type)
    if normalized == "cyber":
        return list(CYBER_FACT_FIELDS)
    if normalized == "it_support":
        return list(IT_SUPPORT_FACT_FIELDS)
    return []


def get_fact_priority(issue_type: str) -> list[str]:
    normalized = normalize_issue_type(issue_type)
    if normalized == "it_support":
        return [*COMMON_FACT_FIELDS, *IT_SUPPORT_FACT_FIELDS, *CYBER_FACT_FIELDS]
    if normalized == "cyber":
        return [*COMMON_FACT_FIELDS, *CYBER_FACT_FIELDS, *IT_SUPPORT_FACT_FIELDS]
    return [*COMMON_FACT_FIELDS, *IT_SUPPORT_FACT_FIELDS, *CYBER_FACT_FIELDS]


def get_domain_category_label(issue_type: str) -> str:
    normalized = normalize_issue_type(issue_type)
    if normalized == "it_support":
        return "IT support request"
    if normalized == "not_sure":
        return "report"
    profile = get_issue_type_profile(normalized or "cyber")
    return profile["label"].lower()
