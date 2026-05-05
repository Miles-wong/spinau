"""Single source of truth for incident field enum values on the backend.

These constants are consumed by:
- validation / schema modules
- API routes that may need enum awareness

Keep this file aligned with frontend/src/constants/incidentSchema.ts.
"""

INCIDENT_CATEGORIES = [
    "phishing",
    "malware",
    "email_exposure",
    "credential_compromise",
    "unauthorized_access",
    "data_breach",
    "device_loss",
    "suspicious_activity",
    "policy_violation",
    "infrastructure_issue",
    "other",
]

IT_SUPPORT_CATEGORIES = [
    "hardware_issue",
    "network_issue",
    "software_issue",
    "access_account_issue",
    "communication",
    "performance_issue",
    "service_request",
    "technical_incident",
    "general_technical_support",
    "other",
]

ISSUE_TYPES = ["cyber", "it_support"]

ISSUE_TYPE_PROFILES = {
    "cyber": {
        "label": "Cyber Security",
        "required_fields": [
            "issue_type",
            "category",
            "description",
            "noticed_time",
            "severity",
            "response_taken",
            "incident_active",
            "impact_scope",
            "work_continuity",
            "data_involved_flag",
            "external_party_involved",
            "already_reported_to_it",
            "preferred_contact_method",
        ],
        "domain_specific_fields": [
            "data_involved_flag",
            "data_involved",
            "data_other_text",
            "external_party_involved",
            "external_party_details",
            "already_reported_to_it",
            "reported_to_details",
        ],
    },
    "it_support": {
        "label": "IT Support",
        "required_fields": [
            "issue_type",
            "category",
            "description",
            "noticed_time",
            "severity",
            "response_taken",
            "incident_active",
            "impact_scope",
            "work_continuity",
            "affected_asset",
            "error_symptom",
            "preferred_contact_method",
        ],
        "domain_specific_fields": [
            "affected_asset",
            "error_symptom",
        ],
    },
}

ALL_CATEGORIES = list(dict.fromkeys(INCIDENT_CATEGORIES + IT_SUPPORT_CATEGORIES))


def get_categories_by_issue_type(issue_type: str):
    if str(issue_type or "").strip().lower() == "it_support":
        return IT_SUPPORT_CATEGORIES
    return INCIDENT_CATEGORIES


def get_issue_type_profile(issue_type: str):
    if str(issue_type or "").strip().lower() == "it_support":
        return ISSUE_TYPE_PROFILES["it_support"]
    return ISSUE_TYPE_PROFILES["cyber"]


SEVERITY_LEVELS = ["low", "medium", "high", "critical"]

LOCATION_TYPES = ["email", "device", "network", "physical", "cloud", "other"]

DATA_TYPES_INVOLVED = [
    "personal_info",
    "credentials",
    "financial",
    "company_data",
    "other",
]

CONTACT_METHODS = ["phone", "email", "in_person", "teams"]
