import json
from typing import Dict, List

from ..schema import EXTRACTION_SCHEMA, FORM_SCHEMA


CYBER_CATEGORY_HINTS: List[str] = [
    "'lost/forgot/reset/compromised password or account' -> credential_compromise",
    "'phishing/suspicious email/fake login page/unexpected reset link' -> phishing",
    "'virus/malware/ransomware/popup/infected' -> malware",
    "'data leak/exposed data/leaked file/shared spreadsheet' -> data_breach",
    "'unexpected login/unauthorized access/account accessed without permission' -> unauthorized_access",
    "'lost/stolen device/laptop/phone' -> device_loss",
]

IT_CATEGORY_HINTS: List[str] = [
    "'wifi/network/internet/vpn/dns/connection' -> network_issue",
    "'install/app/crash/update/software/tool' -> software_issue",
    "'login/account/access/permission/password reset/mfa' -> access_account_issue",
    "'slow/lag/performance/freezing' -> performance_issue",
    "'new laptop/new monitor/request setup/request install' -> service_request",
    "'hardware/laptop/keyboard/mouse/screen/dock/printer' -> hardware_issue",
    "'teams/outlook/email/chat/call' -> communication",
    "Generic technical problem without better fit -> technical_incident or general_technical_support",
]

NOT_SURE_POLICY: List[str] = [
    "User selected 'Not Sure'. Extract clear factual information from the narrative.",
    "Do NOT force category or severity inference yet.",
    "Only infer issue_type if you see multiple explicit cyber or IT support signals.",
    "If signals remain mixed or weak, omit issue_type, category, and severity.",
]


def build_extraction_prompt(
    user_message: str,
    collected_so_far: Dict[str, object],
    missing_fields: List[str],
    inferable_fields: List[str],
    first_pass_fact_fields: List[str],
) -> str:
    minimal_schema = {}
    candidate_fields: List[str] = []

    issue_type = str(collected_so_far.get("issue_type", "")).strip().lower()
    current_inferable_fields = list(inferable_fields)
    if issue_type == "not_sure":
        current_inferable_fields = ["issue_type", *current_inferable_fields]

    for field in missing_fields[:10]:
        if field not in candidate_fields:
            candidate_fields.append(field)

    for field in first_pass_fact_fields:
        if field not in candidate_fields and field not in collected_so_far:
            candidate_fields.append(field)

    for field in current_inferable_fields:
        if field not in candidate_fields and field not in collected_so_far:
            candidate_fields.append(field)

    for field in candidate_fields:
        if field in EXTRACTION_SCHEMA:
            minimal_schema[field] = EXTRACTION_SCHEMA[field]

    schema_str = json.dumps(minimal_schema, ensure_ascii=False, separators=(",", ":"))
    current_field_hint = _build_current_field_hint(missing_fields)
    collected_str = _format_collected_context(collected_so_far)

    system_and_core = (
        "You are an incident and IT support intake specialist using AI to extract structured information.\n\n"
        f"{current_field_hint}"
        f"{collected_str}"
        "## CORE RULE SET: Extract vs Infer vs Omit\n\n"
        "### Priority 1: Deterministic Extraction (Fastest Path)\n"
        "- Noticed Time: Extract if any time phrase appears (2pm, yesterday, 10:30am, etc.)\n"
        "- Boolean Fields: Extract if clear yes/no, true/false, or understood as such\n"
        "- Description: Extract any meaningful detail text directly stated\n"
        "- Detail Fields: Extract factual information about what happened\n"
        "- Data Signals: Extract if data types are explicitly mentioned (spreadsheet, database, passwords, emails, etc.)\n\n"
        "### Priority 2: LLM Inference (When Safe)\n"
        "- Be assertive for facts the user directly stated, including time, action taken, affected asset, symptoms, data, external party, and whether IT/security was notified\n"
        "- Category: CAN infer when issue_type is 'cyber' or 'it_support' and the description contains clear domain evidence (NOT when 'not_sure')\n"
        "- Severity: CAN infer ONLY when category + impact/scope/data evidence are present\n"
        "- Issue Type (Domain): CANNOT infer unless report is explicitly 'not_sure' with multiple strong signals\n\n"
        "### Priority 3: Omit When Absent\n"
        "- Leave fields empty when you cannot support them with text evidence\n"
        "- Do NOT guess or use generic defaults\n"
        "- Do NOT create null, empty string '', or empty list [] values\n\n"
        "### Critical Time Extraction\n"
        "Capture these formats: '2 PM', '2pm', 'two pm', 'at 2 pm', 'about 2 pm', 'around 2 pm',\n"
        "'this afternoon', 'yesterday morning', '2:00 pm', '14:00', 'this morning', 'last night', 'today'\n"
        "Result: Extract noticed_time as the exact phrase mentioned\n\n"
    )

    domain_section = _build_domain_section(issue_type)

    return (
        system_and_core
        + domain_section
        + "## EXTRACTION RULES\n\n"
        "1. Return one JSON object only, no markdown or text outside JSON\n"
        "2. Use ONLY schema-defined field names (no invented fields)\n"
        "3. Extract multiple fields from a single message when possible\n"
        "4. Never output null, empty strings '', empty arrays [], or comments\n"
        "5. For noticed_time: extract the exact time phrase as written in the message\n"
        "6. For data types: infer from context (spreadsheet + 'account numbers' -> financial + personal_info)\n"
        "7. If message is vague or short, leave uncertain complex fields blank instead of guessing\n"
        "8. Do NOT ask for clarification - extract what you can safely support\n"
        "9. For factual fields, prefer extracting supported details over asking again later\n"
        "10. For issue_type, category, and severity, infer only when evidence is strong and internally consistent\n\n"
        f'Latest user message: "{user_message}"\n'
        f"Available fields to extract: {schema_str}"
    )


def _build_current_field_hint(missing_fields: List[str]) -> str:
    if not missing_fields:
        return ""

    current_field = missing_fields[0]
    current_schema = FORM_SCHEMA.get(current_field, {})
    current_label = current_schema.get("label", current_field.replace("_", " ").title())
    current_type = current_schema.get("type", "string")
    if current_type == "enum":
        options = current_schema.get("enum", [])
        return (
            f"*** CURRENT QUESTION: The user was just asked about '{current_label}' "
            f"(field: {current_field}). Valid values: {options}. "
            "If the reply is answering this question (even with a typo or short word), "
            f"extract it as '{current_field}'. ***\n\n"
        )
    if current_type == "boolean":
        return (
            f"*** CURRENT QUESTION: The user was just asked '{current_label}' "
            f"(field: {current_field}, boolean). "
            "If the reply is answering yes/no (true/false), extract it here: true/false only. ***\n\n"
        )
    return (
        f"*** CURRENT QUESTION: The user was just asked about '{current_label}' "
        f"(field: {current_field}). Prioritize extracting this field. ***\n\n"
    )


def _format_collected_context(collected_so_far: Dict[str, object]) -> str:
    if not collected_so_far:
        return ""

    collected_items = []
    for key, value in collected_so_far.items():
        if value is None or value == "" or value == []:
            continue
        value_str = (
            json.dumps(value, ensure_ascii=False)
            if isinstance(value, (list, dict))
            else str(value)
        )
        field_label = FORM_SCHEMA.get(key, {}).get("label", key.replace("_", " ").title())
        collected_items.append(f"- {field_label}: {value_str}")

    if not collected_items:
        return ""
    return "Already collected:\n" + "\n".join(collected_items) + "\n\n"


def _build_domain_section(issue_type: str) -> str:
    if issue_type == "not_sure":
        policy_lines = "\n".join(f"- {line}" for line in NOT_SURE_POLICY)
        return (
            "## DOMAIN DETERMINATION (Not Sure Mode)\n\n"
            f"{policy_lines}\n\n"
            "Cyber signals: phishing, malware, suspicious login, password compromise, data leak, unauthorized access, suspicious email, device loss with security risk, credential theft\n\n"
            "IT Support signals: network/wifi issues, software crash/install, account access help, password reset, slow system, hardware problems, VPN issues, email/chat problems\n\n"
        )
    if issue_type == "cyber":
        hint_lines = "\n".join(f"- {hint}" for hint in CYBER_CATEGORY_HINTS)
        return (
            "## DOMAIN: Cyber Incident Management\n\n"
            "CRITICAL RULE: User explicitly selected 'Cyber'. Infer category + severity accordingly.\n\n"
            "Cyber Category Patterns:\n"
            f"{hint_lines}\n\n"
            "Cyber Severity Patterns:\n"
            "- Single user affected + no data exposure -> medium\n"
            "- Multiple users affected OR sensitive data leaked -> high\n"
            "- Company-wide impact OR service unavailable OR major data breach -> critical\n\n"
            "Data Types: Look for mentions of passwords, customer data, financial info, personal info, spreadsheets with sensitive content, employee information, etc.\n\n"
        )
    if issue_type == "it_support":
        hint_lines = "\n".join(f"- {hint}" for hint in IT_CATEGORY_HINTS)
        return (
            "## DOMAIN: IT Support & Operations\n\n"
            "CRITICAL RULE: User explicitly selected 'IT Support'. Infer category + severity accordingly.\n\n"
            "IT Support Category Patterns:\n"
            f"{hint_lines}\n\n"
            "IT Support Severity Patterns:\n"
            "- One user with workaround -> low or medium\n"
            "- One user blocked from working -> medium or high\n"
            "- Multiple users/team blocked OR core service unavailable -> high or critical\n\n"
        )
    return ""
