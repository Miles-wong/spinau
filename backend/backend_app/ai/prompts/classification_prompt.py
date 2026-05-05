from typing import Dict, List

from constants.incident_schema import ISSUE_TYPES, SEVERITY_LEVELS, get_categories_by_issue_type


CYBER_CATEGORY_HINTS: Dict[str, str] = {
    "phishing": "suspicious email, fake sender, fake login page, credential harvest, or email-linked login flow",
    "credential_compromise": "unexpected password reset, credential theft, or compromised account evidence",
    "unauthorized_access": "unexpected login, unknown-country access, or account accessed without permission",
    "malware": "virus, ransomware, infected attachment, popups, or infected device behavior",
    "data_breach": "data leak, wrong recipient, exposed records, or confirmed unauthorized data sharing",
}

IT_CATEGORY_HINTS: Dict[str, str] = {
    "network_issue": "wifi, wi-fi unavailable, internet down, vpn, dns, connection problems, network outage, unstable connection, or office/floor connectivity issues",
    "software_issue": "app crash, install/update failure, broken application behavior, program not responding, or application freezing",
    "access_account_issue": "routine login, permission, MFA, or account access help without clear security compromise",
    "hardware_issue": "device, printer, keyboard, monitor, or peripheral faults",
    "service_request": "setup, provisioning, install request, or new equipment/software request",
    "performance_issue": "slow system, lagging, high CPU/memory usage, or sluggish response",
    "technical_incident": "service outage, system down, tool unavailable, or unexpected technical failure affecting workflows",
    "general_technical_support": "general IT help that does not fit a more specific category",
}

CLASSIFICATION_POLICY: List[str] = [
    "Use the description as the primary source of truth and treat supporting fields as additional evidence.",
    "Pick the most specific matching category. Only use 'other' when no category hint clearly applies — do not default to 'other' to be safe.",
    "If the narrative suggests credential theft, phishing, suspicious login flow, or account compromise, prefer the cyber taxonomy even if the user only describes an access problem.",
    "Severity should reflect business impact and scope, not just the technical nature of the issue.",
    "Single-user issue with workaround usually low/medium. Single-user blocked medium/high. Multi-user or security-sensitive impact high/critical.",
    "Keep the explanation concise and evidence-based.",
]


def build_classification_prompt(
    *,
    factual_summary: str,
    locked_issue_type: str,
) -> str:
    taxonomy_lines = _build_classification_taxonomy_lines(locked_issue_type)
    issue_type_rule = (
        f"- The issue_type is already fixed as '{locked_issue_type}'. Do not change it.\n"
        if locked_issue_type
        else (
            "- First classify the report as exactly one of: 'cyber' or 'it_support'.\n"
            "- Choose 'cyber' only when the main problem is security risk, suspicious activity, compromise, unauthorized access, malware, phishing, data exposure, or a security-sensitive device loss.\n"
            "- Choose 'it_support' when the main problem is access help, setup, outage, crash, malfunction, performance, hardware, software, network, or service request.\n"
            "- If the report is ambiguous, prefer the safer operational interpretation only when clear security evidence is absent.\n"
        )
    )
    category_hints = _build_category_hints(locked_issue_type)
    decision_policy = "\n".join(f"- {line}" for line in CLASSIFICATION_POLICY)

    return (
        "Classify this report into a two-level taxonomy.\n\n"
        "Use this schema contract exactly. All returned enum values must come from these allowed values.\n\n"
        f"{taxonomy_lines}\n\n"
        "Category hints:\n"
        f"{category_hints}\n\n"
        "Decision policy:\n"
        f"{issue_type_rule}"
        f"{decision_policy}\n\n"
        "Return one JSON object only with this shape:\n"
        '{'
        '"issue_type":"cyber|it_support",'
        '"category":"allowed_category",'
        '"severity":"low|medium|high|critical",'
        '"analysis":"short evidence-based explanation (max 220 chars)"'
        '}\n\n'
        "Incident facts:\n"
        f"{factual_summary}"
    )


def _build_classification_taxonomy_lines(locked_issue_type: str) -> str:
    lines = [f"- issue_type: {' | '.join(ISSUE_TYPES)}"]

    issue_types = [locked_issue_type] if locked_issue_type in ISSUE_TYPES else list(ISSUE_TYPES)
    for issue_type in issue_types:
        categories = get_categories_by_issue_type(issue_type)
        lines.append(f"- {issue_type} categories: {' | '.join(categories)}")

    lines.append(f"- severity: {' | '.join(SEVERITY_LEVELS)}")
    return "\n".join(lines)


def _build_category_hints(locked_issue_type: str) -> str:
    sections: List[str] = []
    if locked_issue_type in {"", "cyber"}:
        sections.extend(
            f"- cyber.{category}: {hint}" for category, hint in CYBER_CATEGORY_HINTS.items()
        )
    if locked_issue_type in {"", "it_support"}:
        sections.extend(
            f"- it_support.{category}: {hint}" for category, hint in IT_CATEGORY_HINTS.items()
        )
    return "\n".join(sections)