import re
import os
import time
from typing import Any, Dict, List, Optional

from constants.incident_schema import (
    IT_SUPPORT_CATEGORIES,
    get_categories_by_issue_type,
)

from .ai import EXTRACTION_MODEL, MODEL_PROVIDER
from .llm_backend import request_json_completion
from .prompts.classification_prompt import build_classification_prompt
from .schema import FORM_SCHEMA
from .tracker import _ai_tracker


def _json_classifier_model() -> str:
    """Use a fast JSON-friendly model for low-confidence classification."""
    if MODEL_PROVIDER == "openai" and EXTRACTION_MODEL.startswith("gpt-5"):
        return "gpt-4o-mini"
    return EXTRACTION_MODEL


AI_ISSUE_TYPE_CONFIDENCE_THRESHOLD = 0.75
DEFAULT_STRONG_GEMINI_CLASSIFIER_MODEL = "gemini-2.5-pro"


def _strong_classifier_model() -> str:
    """Use a stronger model only for low-confidence AI/local conflicts."""
    if MODEL_PROVIDER == "gemini":
        return os.environ.get(
            "STRONG_GEMINI_CLASSIFIER_MODEL",
            DEFAULT_STRONG_GEMINI_CLASSIFIER_MODEL,
        ).strip() or DEFAULT_STRONG_GEMINI_CLASSIFIER_MODEL
    return EXTRACTION_MODEL


DIRECT_ISSUE_TYPE_PROMPT = """Classify the user's message for an incident intake system.

Return exactly one JSON object and no extra text:
{"intent":"cyber|it_support","confidence":0.0,"reason":"short reason"}

Definitions:
- cyber: suspected cybersecurity, security incident, phishing, malware, ransomware, account compromise, unauthorized access, suspicious login, suspicious link/message, data exposure, wrong recipient involving sensitive/customer/company data, policy/security violation, or security-sensitive device loss.
- it_support: ordinary IT help such as hardware replacement, screen/monitor/printer/keyboard/mouse issues, software install/crash, routine password reset, routine locked account, access request, Wi-Fi/VPN/network, email/Teams/app problems, workstation setup, or service outage without a security-risk framing.

Important:
- AI is the primary decision maker for cyber vs it_support.
- You must choose either cyber or it_support. Do not return unclear.
- Short but meaningful descriptions are valid.
- If the user explicitly says they have a cyber incident to report, classify as cyber.
- If the user only asks for general help without security evidence, classify as it_support.
- Do not classify routine IT support as cyber just because it mentions account, access, email, dashboard, or security tools.
- Do classify as cyber when routine IT words are combined with clear security-risk evidence such as suspicious links, unknown-country login alerts, unexpected MFA, fake sender, credentials entered into a linked page, malware, or data sent to the wrong recipient.

Boundary examples:
- "password reset" -> it_support
- "password reset email I did not request" -> cyber
- "I forgot my password" -> it_support
- "account locked after weird MFA prompts" -> cyber
- "VPN keeps disconnecting" -> it_support
- "VPN issue after clicking unknown link" -> cyber
- "I lost my work phone" -> cyber
- "laptop screen cracked" -> it_support
- "I have a cyber incident to report" -> cyber
"""


def _normalize_direct_issue_type(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"cyber", "cyber_incident", "security", "security_incident"}:
        return "cyber"
    if normalized in {"it", "it_support", "support", "technical_support"}:
        return "it_support"
    if normalized in {"unclear", "unknown", "ambiguous", "invalid", ""}:
        return "unclear"
    return "unclear"


def _parse_confidence(value: Any) -> float:
    try:
        confidence = float(value)
    except (TypeError, ValueError):
        return 0.0
    if confidence > 1.0:
        confidence = confidence / 100.0
    return max(0.0, min(1.0, confidence))


def classify_issue_type_with_ai(description: str) -> Dict[str, Any]:
    """Let the model make the primary cyber vs IT support decision."""
    text = str(description or "").strip()
    if not text:
        return {"intent": "unclear", "confidence": 0.0, "reason": "empty description"}

    req_start = time.time()
    try:
        payload, api_time, used_fallback = request_json_completion(
            messages=[
                {"role": "system", "content": DIRECT_ISSUE_TYPE_PROMPT},
                {"role": "user", "content": text},
            ],
            model=_json_classifier_model(),
            temperature=0.0,
            top_p=1.0,
            max_tokens=120,
            timeout=6.0,
            use_gemini_fallback=True,
        )
        result = {
            "intent": _normalize_direct_issue_type(payload.get("intent")),
            "confidence": _parse_confidence(payload.get("confidence")),
            "reason": str(payload.get("reason", "")).strip()[:220],
        }
        _ai_tracker.log_call(
            "classify_issue_type_with_ai",
            time.time() - req_start,
            (
                f"model={MODEL_PROVIDER} fallback={used_fallback} "
                f"intent={result['intent']} confidence={result['confidence']:.2f} "
                f"api_time={api_time:.2f}s"
            ),
        )
        return result
    except Exception as exc:
        _ai_tracker.log_call(
            "classify_issue_type_with_ai (failed)",
            time.time() - req_start,
            f"error={str(exc)[:80]}",
        )
        return {"intent": "unclear", "confidence": 0.0, "reason": "AI issue-type classification failed"}


def has_local_cyber_safety_evidence(text: str) -> bool:
    """Second-opinion safety check used only when AI issue routing is uncertain."""
    lowered = (text or "").lower()
    return bool(
        has_strong_data_disclosure_evidence(lowered)
        or re.search(
            r"\b("
            r"cyber incident|security incident|phishing|malware|ransomware|"
            r"suspicious email|suspicious message|strange email|fake email|"
            r"unexpected mfa|mfa prompt|login alert|overseas login|another country|impossible travel|"
            r"password reset (?:email )?(?:i )?(?:did not|didn't) request|unrequested password reset|"
            r"clicked (?:an? )?(?:unknown|suspicious|fake) link|unknown link|suspicious link|"
            r"fake sender|fake login|entered .*password.*email|credentials?.*(?:stolen|captured|compromised)|"
            r"unauthorized access|accessed .*without permission|account .*hacked|account .*compromised|"
            r"lost .*company laptop|lost .*work laptop|stolen .*company laptop|stolen .*work laptop|"
            r"opened .*strange attachment|opened .*suspicious attachment|strange attachment|"
            r"personal (?:gmail|dropbox|cloud|drive)|customer records?.*personal|"
            r"shared mailbox sent .*we did not|forwarding rule"
            r")\b",
            lowered,
        )
    )


def has_local_it_support_evidence(text: str) -> bool:
    """Return True for concrete routine IT support evidence."""
    lowered = (text or "").lower()
    return bool(
        re.search(
            r"\b("
            r"screen is broken|screen cracked|monitor|printer|keyboard|mouse|dock|docking station|"
            r"move my computer|new office|set(?:ting)? up my computer|new workstation|"
            r"forgot my password|normal password reset|typed the wrong password|"
            r"need access to|access request|permission denied|"
            r"vpn keeps disconnecting|wi-?fi|outlook.*crash|teams audio|"
            r"laptop is very slow.*no security warnings|approved software installed|"
            r"reporting dashboard is down|payroll system"
            r")\b",
            lowered,
        )
    )


def extract_explicit_severity(text: str) -> Optional[str]:
    """Extract a severity only when the user states it explicitly."""
    patterns = {
        "critical": [
            r"\bcritical severity\b",
            r"\bseverity\s*[:=]?\s*critical\b",
            r"\bclassif(y|ied).+critical\b",
        ],
        "high": [
            r"\bhigh severity\b",
            r"\bseverity\s*[:=]?\s*high\b",
            r"\bclassif(y|ied).+high\b",
        ],
        "medium": [r"\bmedium severity\b", r"\bseverity\s*[:=]?\s*medium\b"],
        "low": [r"\blow severity\b", r"\bseverity\s*[:=]?\s*low\b"],
    }
    for severity, patterns_for_severity in patterns.items():
        if any(re.search(pattern, text) for pattern in patterns_for_severity):
            return severity
    return None


def extract_explicit_category(
    text: str, issue_type: Optional[str] = None
) -> Optional[str]:
    """Extract an explicit category label from direct user wording."""
    normalized_issue_type = str(issue_type or "").strip().lower()
    allow_cyber = normalized_issue_type in {"", "cyber", "not_sure"}
    allow_it_support = normalized_issue_type in {"", "it_support", "not_sure"}

    category_aliases = {
        "unauthorized_access": ["unauthorized access"],
        "credential_compromise": ["credential compromise", "account compromise"],
        "phishing": ["phishing"],
        "malware": ["malware", "virus", "ransomware"],
        "data_breach": ["data breach", "data leak", "data disclosure"],
        "email_exposure": ["email exposure", "wrong email recipient"],
        "device_loss": ["device loss", "lost device", "stolen device"],
        "suspicious_activity": ["suspicious activity"],
        "policy_violation": ["policy violation"],
        "infrastructure_issue": ["infrastructure issue"],
        "hardware_issue": ["hardware issue"],
        "network_issue": ["network issue"],
        "software_issue": ["software issue"],
        "access_account_issue": [
            "access issue",
            "account issue",
            "access account issue",
            "account locked",
            "cannot sign in",
        ],
        "communication": ["communication", "teams calls", "teams meeting"],
        "performance_issue": ["performance issue", "extremely slow"],
        "service_request": ["service request"],
        "technical_incident": ["technical incident"],
        "general_technical_support": ["general technical support"],
    }
    for category, aliases in category_aliases.items():
        if (
            category
            in {
                "unauthorized_access",
                "credential_compromise",
                "phishing",
                "malware",
                "data_breach",
                "email_exposure",
                "device_loss",
                "suspicious_activity",
                "policy_violation",
                "infrastructure_issue",
            }
            and not allow_cyber
        ):
            continue
        if (
            category
            in {
                "hardware_issue",
                "network_issue",
                "software_issue",
                "access_account_issue",
                "communication",
                "performance_issue",
                "service_request",
                "technical_incident",
                "general_technical_support",
            }
            and not allow_it_support
        ):
            continue
        if any(alias in text for alias in aliases):
            return category
    return None


def extract_explicit_data_types(
    text: str, issue_type: Optional[str] = None
) -> List[str]:
    """Map direct data-type mentions to the schema's canonical values."""
    normalized_issue_type = str(issue_type or "").strip().lower()
    if normalized_issue_type == "it_support":
        return []

    found: List[str] = []
    if re.search(r"\bcredential(s)?\b", text):
        found.append("credentials")
    if re.search(
        r"\b(company data|corporate data|internal documents|internal data)\b", text
    ):
        found.append("company_data")
    if re.search(
        r"\b(financial|bank|payment|credit card|account number|invoice)\b", text
    ):
        found.append("financial")
    if re.search(
        r"\b(personal info|personal information|personal data|pii|customer data|client data)\b",
        text,
    ):
        found.append("personal_info")
    if re.search(r"\b(?:customer|client).*\binvoice\b", text):
        found.append("personal_info")
    return list(dict.fromkeys(found))


def is_category_allowed_for_issue_type(
    category: Optional[str], issue_type: Optional[str]
) -> bool:
    """Return whether a category is valid for the resolved top-level issue type."""
    normalized_category = str(category or "").strip().lower()
    normalized_issue_type = str(issue_type or "").strip().lower()

    if not normalized_category or normalized_issue_type not in {"cyber", "it_support"}:
        return True

    return normalized_category in {
        value.strip().lower()
        for value in get_categories_by_issue_type(normalized_issue_type)
    }


def enforce_issue_type_boundary(
    patch: Dict[str, Any], issue_type: Optional[str]
) -> Dict[str, Any]:
    """Prune cross-domain fields once the top-level issue type is resolved."""
    normalized_issue_type = str(issue_type or "").strip().lower()
    if normalized_issue_type not in {"cyber", "it_support"}:
        return patch

    result = dict(patch)

    category = result.get("category")
    if category and not is_category_allowed_for_issue_type(
        category, normalized_issue_type
    ):
        result.pop("category", None)
        result.pop("category_other_text", None)

    if normalized_issue_type == "it_support":
        for field_name in (
            "data_involved_flag",
            "data_involved",
            "data_other_text",
            "external_party_involved",
            "external_party_details",
            "already_reported_to_it",
            "reported_to_details",
        ):
            result.pop(field_name, None)
    elif normalized_issue_type == "cyber":
        for field_name in ("affected_asset", "error_symptom"):
            result.pop(field_name, None)

    return result


def build_observed_text_from_collected(collected: Dict[str, Any]) -> str:
    """Build a normalized text blob from collected fields for shared recommendation rules."""
    text_parts = [
        str(collected.get("description", "")).strip(),
        str(collected.get("impact_scope", "")).strip(),
        str(collected.get("work_continuity", "")).strip(),
        str(collected.get("response_details", "")).strip(),
        str(collected.get("affected_asset", "")).strip(),
        str(collected.get("error_symptom", "")).strip(),
        str(collected.get("external_party_details", "")).strip(),
        str(collected.get("reported_to_details", "")).strip(),
        str(collected.get("location_detail", "")).strip(),
    ]

    data_involved = collected.get("data_involved") or []
    if isinstance(data_involved, list) and data_involved:
        text_parts.append(
            " ".join(str(item).replace("_", " ") for item in data_involved)
        )

    if collected.get("data_involved_flag") is True:
        text_parts.append("sensitive data involved")
    elif collected.get("data_involved_flag") is False:
        text_parts.append("no data involved")

    if collected.get("incident_active") is True:
        text_parts.append("still active")
    elif collected.get("incident_active") is False:
        text_parts.append("contained")

    if collected.get("external_party_involved") is True:
        text_parts.append("external party involved")
    elif collected.get("external_party_involved") is False:
        text_parts.append("no external party involved")

    if collected.get("already_reported_to_it") is True:
        text_parts.append("already reported to IT")
    elif collected.get("already_reported_to_it") is False:
        text_parts.append("not reported to IT")

    return " ".join(part for part in text_parts if part).strip()


def infer_category_from_collected(collected: Dict[str, Any]) -> Optional[str]:
    """Infer category from collected incident fields using the shared classification rules."""
    if not collected:
        return None

    observed_text = build_observed_text_from_collected(collected)
    if not observed_text:
        return None

    resolved_issue_type = str(collected.get("issue_type", "")).strip().lower()

    explicit_category = extract_explicit_category(observed_text, resolved_issue_type)
    if explicit_category:
        return explicit_category

    inferred_category = _infer_category_from_text(observed_text, resolved_issue_type)
    if not is_category_allowed_for_issue_type(inferred_category, resolved_issue_type):
        return None
    return inferred_category


def has_strong_data_disclosure_evidence(text: str) -> bool:
    """Return True for clear wrong-recipient or cross-client data disclosure."""
    lowered = (text or "").lower()
    patterns = [
        r"\bdata (?:leak|breach|exposure|disclosure)\b",
        r"\b(?:exposed|leaked|disclosed) (?:data|information|invoice|personal|customer|client)\b",
        r"\bwrong (?:person|recipient|customer|client)\b",
        r"\bsent .* to the wrong (?:person|recipient|customer|client)\b",
        r"\bwrong attachment\b.*\b(?:client|customer|invoice|personal|sensitive)\b",
        r"\b(?:client|customer).*\binvoice\b.*\b(?:wrong|another|other)\b",
        r"\banother (?:client|customer)'?s invoice\b",
        r"\b(?:another|other) (?:client|customer).*\b(?:invoice|data|information)\b",
        r"\bemail\b.*\bwrong attachment\b",
    ]
    return any(re.search(pattern, lowered) for pattern in patterns)


def infer_issue_type_from_collected(
    collected: Dict[str, Any],
    allow_reclassification: bool = False,
) -> Optional[str]:
    """Infer the top-level domain from collected facts."""
    if not collected:
        return None

    issue_type = str(collected.get("issue_type", "")).strip().lower()
    if issue_type == "cyber":
        return issue_type
    if issue_type == "it_support" and not allow_reclassification:
        return issue_type

    observed_text = build_observed_text_from_collected(collected).lower()
    if not observed_text:
        return None

    # Strong domain phrase override: when users explicitly call it a cyber/security
    # incident, keep routing in the cyber domain even if support-style verbs
    # like "report" are present.
    if re.search(r"\b(cyber|security)\s+incident\b", observed_text):
        return "cyber"

    if has_strong_data_disclosure_evidence(observed_text):
        return "cyber"

    inferred_category = _infer_category_from_text(observed_text, "not_sure")
    if inferred_category:
        if inferred_category == "other" and re.search(
            r"\b(security concern|badge readers?|server room|physical security|visitor.*server room)\b",
            observed_text,
        ):
            return "cyber"
        return "it_support" if inferred_category in IT_SUPPORT_CATEGORIES else "cyber"

    phishing_patterns = [
        r"(?:email|message).*(?:fake|unusual|suspicious|unexpected).*(?:sender|from)",
        r"(?:clicked|click).*(?:link|url).*(?:suspicious|fake|unusual)",
        r"(?:log\s*in|login).*(?:through|via).*(?:link|url)",
        r"entered.*(?:login details|credentials).*(?:page|site).*(?:email|message)",
        r"page linked from an email",
        r"(?:email|message).*(?:urgent|immediately|asap).*(?:password|reset|confirm)",
        r"fake.*(?:email|message|login|sender)",
        r"(?:sender|from).*(?:address|email).*(?:unusual|suspicious|looked|fake)",
        r"sender.*looked\s+fake",
        r"phishing",
        r"invalid.*(?:email|sender)",
    ]

    cyber_signals = [
        r"\bphishing\b",
        r"\bmalware\b",
        r"\bransomware\b",
        r"\bcredential\b",
        r"\blogin details\b",
        r"\bmfa prompt(s)?\b",
        r"\bpassword reset.*(?:unexpected|unrequested)\b",
        r"\bsuspicious login\b",
        r"\blogin alerts? from another country\b",
        r"\bunauthorized access\b",
        r"\bdata breach\b",
        r"\bwrong person\b.*\bspreadsheet\b",
        r"\bwrong attachment\b.*\b(?:client|customer|invoice|personal|sensitive)\b",
        r"\b(?:client|customer).*\binvoice\b.*\b(?:wrong|another|other)\b",
        r"\banother (?:client|customer)'?s invoice\b",
        r"\bwrong (?:client|customer).*invoice\b",
        r"\brecalled it immediately\b",
        r"\blost (?:my )?(?:work )?(?:phone|laptop|device)\b",
        r"\bsuspicious email\b",
        r"\battacker\b",
        r"\bcompromised\b",
        r"\bbrute force\b",
        r"\bhacked\b",
        r"\breverse shell\b",
        r"\bvirus\b",
        r"\btrojan\b",
    ]

    it_support_signals = [
        r"\bwifi\b",
        r"\bwi-fi\b",
        r"\bnetwork connection\b",
        r"\binternet connection\b",
        r"\bvpn.*(?:disconnect|won't connect|not working)\b",
        r"\bneed a password reset\b",
        r"\bsoftware.*(?:crash|not working|install)\b",
        r"\bapp (?:crash|crashes|crashed|crashing)\b",
        r"\binstall\b",
        r"\bpermission denied\b",
        r"\baccess request\b",
        r"\bslow performance\b",
        r"\bprinter\b",
        r"\bmonitor\b",
        r"\bkeyboard\b",
        r"\bmouse\b",
        r"\blaptop.*(?:slow|crash|won't start)\b",
        r"\bcomputer.*(?:slow|crash|won't start)\b",
    ]

    phishing_score = sum(
        1 for pattern in phishing_patterns if re.search(pattern, observed_text)
    )
    if phishing_score >= 2:
        return "cyber"

    cyber_score = sum(
        1 for pattern in cyber_signals if re.search(pattern, observed_text)
    )
    it_support_score = sum(
        1 for pattern in it_support_signals if re.search(pattern, observed_text)
    )

    if re.search(r"\b(mfa prompt|login alert|another country|unknown country|unexpected reset link)\b", observed_text):
        return "cyber"
    has_suspicious_negation = bool(
        re.search(r"\b(no|not|without)\s+(?:a\s+)?suspicious (?:email|message|link|sender)\b", observed_text)
    )
    if not has_suspicious_negation and re.search(r"\b(suspicious email|fake sender|clicked.*link|log\s*in.*(?:through|via).*(?:link|url)|entered.*(?:login details|credentials).*(?:page|site).*(?:email|message)|page linked from an email|attachment.*suspicious|sender.*looked\s+fake)\b", observed_text):
        return "cyber"
    if re.search(r"\b(left my work phone|left my laptop|lost my work phone|lost my laptop|stolen device)\b", observed_text):
        return "cyber"
    if re.search(r"\b(wrong person|wrong recipient|sent .*spreadsheet.*wrong)\b", observed_text):
        return "cyber"

    if cyber_score == 0 and it_support_score == 0:
        if not has_suspicious_negation and re.search(r"\b(suspicious|strange email|weird email|fake|unexpected)\b", observed_text):
            return "cyber"
        return "it_support"
    if cyber_score > 0 and it_support_score == 0:
        return "cyber"
    if it_support_score > 0 and cyber_score == 0:
        return "it_support"
    return "cyber"


def infer_severity_from_collected(collected: Dict[str, Any]) -> Optional[str]:
    """Infer severity from collected incident fields using conservative shared rules."""
    if not collected:
        return None

    observed_text = build_observed_text_from_collected(collected)
    if not observed_text:
        return None

    category = collected.get("category")
    if isinstance(category, str):
        category = category.strip() or None
    if not category:
        category = infer_category_from_collected(collected)

    return _infer_severity_from_text(observed_text, category)


def classify_report_with_ai(collected: Dict[str, Any]) -> Dict[str, Any]:
    """Classify issue_type/category/severity with AI as the primary router.

    The model decides the top-level issue type first. Local rules are only used
    as a second opinion when that decision is low-confidence, and as support for
    category/severity after a high-confidence AI issue type has been locked.
    """
    description = str(collected.get("description", "")).strip()
    direct_issue_type = classify_issue_type_with_ai(description)
    direct_intent = str(direct_issue_type.get("intent", "")).strip().lower()
    direct_confidence = _parse_confidence(direct_issue_type.get("confidence"))
    ai_locked_issue_type = (
        direct_intent
        if direct_intent in {"cyber", "it_support"}
        and direct_confidence >= AI_ISSUE_TYPE_CONFIDENCE_THRESHOLD
        else ""
    )

    if not ai_locked_issue_type and not _looks_like_meaningful_description(description):
        if direct_intent == "unclear":
            return {
                "issue_type": "it_support",
                "category": "general_technical_support",
                "confidence": "low",
                "needs_confirmation": True,
                "issue_type_source": "local_fallback",
                "issue_type_confidence": direct_confidence,
                "issue_type_reason": direct_issue_type.get("reason") or "Defaulted to IT support because no clear cyber evidence was found.",
                "analysis": "Best fit: IT Support. Low confidence.",
            }

    explicit_issue_type = str(collected.get("issue_type", "")).strip().lower()
    locked_issue_type = (
        explicit_issue_type if explicit_issue_type in {"cyber", "it_support"} else ""
    )
    if ai_locked_issue_type:
        locked_issue_type = ai_locked_issue_type

    observed_text = build_observed_text_from_collected(collected).lower()
    if locked_issue_type == "it_support" and not ai_locked_issue_type:
        has_strong_cyber_evidence = bool(
            re.search(
                r"\b(mfa prompt|unexpected mfa|login alert|another country|unknown country|"
                r"suspicious email|fake sender|clicked.*(link|url)|phishing|unauthorized access|"
                r"compromised|credential theft|password reset.*unexpected)\b",
                observed_text,
            )
        ) or has_strong_data_disclosure_evidence(observed_text)
        if has_strong_cyber_evidence:
            locked_issue_type = ""
    if not locked_issue_type and not ai_locked_issue_type and has_local_cyber_safety_evidence(observed_text):
        locked_issue_type = "cyber"
    if (
        not locked_issue_type
        and not ai_locked_issue_type
        and direct_intent == "unclear"
        and not has_local_cyber_safety_evidence(observed_text)
        and not has_local_it_support_evidence(observed_text)
    ):
        locked_issue_type = "it_support"
    rule_result = _classify_with_rules(collected, locked_issue_type=locked_issue_type)
    low_confidence_ai_intent = (
        not ai_locked_issue_type
        and direct_intent in {"cyber", "it_support"}
        and direct_confidence < AI_ISSUE_TYPE_CONFIDENCE_THRESHOLD
    )
    local_issue_type = str(rule_result.get("issue_type", "")).strip().lower()
    if low_confidence_ai_intent and local_issue_type in {"cyber", "it_support"}:
        if direct_intent == local_issue_type:
            result = _with_issue_type_metadata(
                rule_result,
                source="local_ai_agreement",
                direct_issue_type=direct_issue_type,
                direct_confidence=direct_confidence,
            )
            if not result.get("analysis"):
                result["analysis"] = "Low-confidence AI and local rules agreed; kept the local triage result."
            return result

        result = _with_issue_type_metadata(
            rule_result,
            source="local_pending_strong_arbitration",
            direct_issue_type=direct_issue_type,
            direct_confidence=direct_confidence,
        )
        result["strong_arbitration_pending"] = True
        result["strong_arbitration_kind"] = "issue_type_only"
        result["strong_arbitration_ai_intent"] = direct_intent
        result["strong_arbitration_local_issue_type"] = local_issue_type
        if not result.get("analysis"):
            result["analysis"] = "AI and local rules disagreed; kept the local triage result while stronger issue-type arbitration runs in the background."
        return result

    if not ai_locked_issue_type and rule_result.get("confidence") == "high":
        return rule_result

    heuristic_issue_type = (
        locked_issue_type
        or str(rule_result.get("issue_type", "")).strip().lower()
        or infer_issue_type_from_collected(collected, allow_reclassification=True)
    )

    factual_summary = _build_classification_summary(collected)
    prompt = build_classification_prompt(
        factual_summary=factual_summary,
        locked_issue_type=locked_issue_type,
    )

    req_start = time.time()
    validated_ai: Dict[str, Any] = {}
    used_fallback = False

    try:
        payload, api_time, used_fallback = request_json_completion(
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a senior incident triage analyst. "
                        "Return one strict JSON object only."
                    ),
                },
                {"role": "user", "content": prompt},
            ],
            model=_json_classifier_model(),
            temperature=0.0,
            top_p=1.0,
            max_tokens=320,
            timeout=6.0,
            use_gemini_fallback=True,
        )
        validated_ai = _validate_ai_classification_payload(payload, locked_issue_type)
        _ai_tracker.log_call(
            "classify_report_with_ai",
            time.time() - req_start,
            (
                f"model={MODEL_PROVIDER} fallback={used_fallback} "
                f"issue_type={validated_ai.get('issue_type', '')} "
                f"category={validated_ai.get('category', '')} api_time={api_time:.2f}s"
            ),
        )
    except Exception as exc:
        _ai_tracker.log_call(
            "classify_report_with_ai (failed)",
            time.time() - req_start,
            f"error={str(exc)[:80]}",
        )

    heuristic = {
        key: value
        for key, value in rule_result.items()
        if key in {"issue_type", "category", "severity"}
    }
    prefer_ai_issue_type = bool(ai_locked_issue_type) or _should_prefer_ai_issue_type(
        locked_issue_type=locked_issue_type,
        heuristic_issue_type=heuristic_issue_type,
        heuristic=heuristic,
        validated_ai=validated_ai,
    )

    resolved_issue_type = (
        ai_locked_issue_type
        or locked_issue_type
        or (validated_ai.get("issue_type") if prefer_ai_issue_type else "")
        or heuristic.get("issue_type")
        or heuristic_issue_type
        or validated_ai.get("issue_type")
    )
    if resolved_issue_type in {"cyber", "it_support"} and validated_ai:
        validated_ai = enforce_issue_type_boundary(validated_ai, resolved_issue_type)

    resolved_category = (
        validated_ai.get("category")
        or heuristic.get("category")
    )
    resolved_severity = (
        validated_ai.get("severity")
        or heuristic.get("severity")
    )

    resolved_issue_type, resolved_category, resolved_severity = _apply_classification_guardrails(
        collected=collected,
        resolved_issue_type=str(resolved_issue_type or ""),
        resolved_category=resolved_category,
        resolved_severity=resolved_severity,
        heuristic=heuristic,
        preserve_issue_type=bool(ai_locked_issue_type),
    )

    if resolved_category == "phishing":
        has_concrete_phishing_signal = bool(
            re.search(
                r"\b(clicked|click|link|url|fake sender|spoofed|credential|password reset|login page|unknown sender|suspicious sender)\b",
                observed_text,
            )
        )
        has_weak_email_signal = bool(
            re.search(r"\b(strange email|weird email|strange message|weird message)\b", observed_text)
        )
        if has_weak_email_signal and not has_concrete_phishing_signal:
            resolved_category = "other"
            if not resolved_severity:
                resolved_severity = "low"

    if not resolved_category and resolved_issue_type in {"cyber", "it_support"}:
        resolved_category = "other"
    if not resolved_severity and resolved_category == "other":
        resolved_severity = _infer_severity_from_text(
            build_observed_text_from_collected(collected), resolved_category
        )
    confidence = _estimate_classification_confidence(
        collected=collected,
        resolved_issue_type=resolved_issue_type,
        resolved_category=resolved_category,
        resolved_severity=resolved_severity,
        heuristic=heuristic,
        validated_ai=validated_ai,
    )
    if ai_locked_issue_type:
        confidence = "high" if direct_confidence >= 0.9 else "medium"

    if resolved_issue_type not in {"cyber", "it_support"}:
        resolved_issue_type = "it_support"
        if not resolved_category:
            resolved_category = "general_technical_support"

    result: Dict[str, Any] = {
        "issue_type": resolved_issue_type,
        "confidence": confidence,
        "needs_confirmation": True,
    }
    if resolved_category:
        result["category"] = resolved_category
    if resolved_severity:
        result["severity"] = resolved_severity
    if direct_issue_type:
        result["issue_type_source"] = "ai_primary" if ai_locked_issue_type else "local_fallback"
        result["issue_type_confidence"] = direct_confidence
        if direct_issue_type.get("reason"):
            result["issue_type_reason"] = direct_issue_type.get("reason")

    analysis = _build_classification_analysis(
        resolved_issue_type=resolved_issue_type,
        resolved_category=resolved_category,
        resolved_severity=resolved_severity,
        confidence=confidence,
        heuristic=heuristic,
        validated_ai=validated_ai,
    )
    if analysis:
        result["analysis"] = analysis

    return result


def _classify_with_rules(
    collected: Dict[str, Any],
    *,
    locked_issue_type: str = "",
) -> Dict[str, Any]:
    """Return rule classification plus a confidence label.

    High confidence means we have a specific rule-backed category and can skip
    the model. Low/medium confidence lets AI handle freer descriptions.
    """
    context = dict(collected)
    if locked_issue_type:
        context["issue_type"] = locked_issue_type

    recommendations = derive_recommendations_from_collected(context)
    issue_type = str(recommendations.get("issue_type") or locked_issue_type or "").strip().lower()
    category = str(recommendations.get("category") or "").strip().lower()
    severity = str(recommendations.get("severity") or "").strip().lower()
    observed_text = build_observed_text_from_collected(collected).lower()

    confidence = "low"
    if issue_type in {"cyber", "it_support"} and category:
        confidence = "medium"
        if category != "other" or _has_explicit_other_context(observed_text, issue_type):
            confidence = "high"
    elif issue_type in {"cyber", "it_support"}:
        confidence = "medium"

    result: Dict[str, Any] = {
        "confidence": confidence,
        "needs_confirmation": True,
    }
    if issue_type in {"cyber", "it_support"}:
        result["issue_type"] = issue_type
    if category:
        result["category"] = category
    if severity:
        result["severity"] = severity
    if confidence == "high":
        result["analysis"] = "Matched high-confidence triage rules."
    return result


def _with_issue_type_metadata(
    result: Dict[str, Any],
    *,
    source: str,
    direct_issue_type: Dict[str, Any],
    direct_confidence: float,
) -> Dict[str, Any]:
    """Attach issue-routing provenance to a classification result."""
    enriched = dict(result)
    enriched["needs_confirmation"] = True
    enriched["issue_type_source"] = source
    enriched["issue_type_confidence"] = direct_confidence
    if direct_issue_type.get("reason"):
        enriched["issue_type_reason"] = direct_issue_type.get("reason")
    return enriched


def _classify_conflict_with_strong_model(
    *,
    collected: Dict[str, Any],
    direct_issue_type: Dict[str, Any],
    local_result: Dict[str, Any],
) -> Dict[str, Any]:
    """Resolve low-confidence AI/local conflicts with a stronger classifier.

    The stronger model is only a tie-breaker. Its output still goes through the
    same enum validation, domain boundary enforcement, and deterministic
    guardrails as the normal classifier. If anything fails, callers fall back to
    the local result.
    """
    factual_summary = _build_classification_summary(collected)
    observed_text = build_observed_text_from_collected(collected)
    direct_intent = str(direct_issue_type.get("intent", "")).strip().lower()
    direct_reason = str(direct_issue_type.get("reason", "")).strip()

    prompt = (
        "Resolve this classification conflict for an incident intake system.\n\n"
        "Return one JSON object only with this exact shape:\n"
        "{"
        '"issue_type":"cyber|it_support",'
        '"category":"allowed_category",'
        '"severity":"low|medium|high|critical",'
        '"analysis":"short evidence-based explanation (max 220 chars)",'
        '"winner":"ai|local|override"'
        "}\n\n"
        "Allowed taxonomy:\n"
        f"- cyber categories: {' | '.join(get_categories_by_issue_type('cyber'))}\n"
        f"- it_support categories: {' | '.join(get_categories_by_issue_type('it_support'))}\n"
        "- severity: low | medium | high | critical\n\n"
        "Decision rules:\n"
        "- Prefer cyber only when there is security-risk evidence: suspicious link/message, compromise, unauthorized access, malware, data exposure, policy/security violation, or security-sensitive device loss.\n"
        "- Prefer it_support for routine access, setup, outage, crash, malfunction, hardware, software, network, or service requests without security-risk evidence.\n"
        "- Pick a category that belongs to the chosen issue_type.\n"
        "- Do not copy either side blindly; use the incident facts as source of truth.\n\n"
        "Low-confidence AI issue routing:\n"
        f"- issue_type: {direct_intent or 'unclear'}\n"
        f"- confidence: {_parse_confidence(direct_issue_type.get('confidence')):.2f}\n"
        f"- reason: {direct_reason or 'not provided'}\n\n"
        "Local rule result:\n"
        f"- issue_type: {local_result.get('issue_type', '')}\n"
        f"- category: {local_result.get('category', '')}\n"
        f"- severity: {local_result.get('severity', '')}\n"
        f"- confidence: {local_result.get('confidence', '')}\n\n"
        "Incident facts:\n"
        f"{factual_summary or observed_text}"
    )

    req_start = time.time()
    try:
        payload, api_time, used_fallback = request_json_completion(
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a senior incident triage adjudicator. "
                        "Return one strict JSON object only."
                    ),
                },
                {"role": "user", "content": prompt},
            ],
            model=_strong_classifier_model(),
            temperature=0.0,
            top_p=1.0,
            max_tokens=4096,
            timeout=40.0,
            use_gemini_fallback=False,
        )
        validated = _validate_ai_classification_payload(payload, locked_issue_type="")
        if not validated:
            return {}

        heuristic = {
            key: value
            for key, value in local_result.items()
            if key in {"issue_type", "category", "severity"}
        }
        issue_type, category, severity = _apply_classification_guardrails(
            collected=collected,
            resolved_issue_type=str(validated.get("issue_type", "")),
            resolved_category=validated.get("category"),
            resolved_severity=validated.get("severity"),
            heuristic=heuristic,
            preserve_issue_type=False,
        )
        if issue_type not in {"cyber", "it_support"}:
            return {}

        result: Dict[str, Any] = {
            "issue_type": issue_type,
            "confidence": "medium",
            "needs_confirmation": True,
        }
        if category:
            result["category"] = category
        if severity:
            result["severity"] = severity
        if validated.get("analysis"):
            result["analysis"] = validated["analysis"]
        else:
            result["analysis"] = "Resolved low-confidence AI/local disagreement with stronger-model arbitration."

        _ai_tracker.log_call(
            "classify_conflict_with_strong_model",
            time.time() - req_start,
            (
                f"model={_strong_classifier_model()} fallback={used_fallback} "
                f"issue_type={issue_type} category={category or ''} api_time={api_time:.2f}s"
            ),
        )
        return result
    except Exception as exc:
        _ai_tracker.log_call(
            "classify_conflict_with_strong_model (failed)",
            time.time() - req_start,
            f"model={_strong_classifier_model()} error={str(exc)[:80]}",
        )
        return {}


def classify_issue_type_conflict_with_strong_model(
    *,
    collected: Dict[str, Any],
    direct_issue_type: Dict[str, Any],
    local_issue_type: str,
) -> Dict[str, Any]:
    """Resolve only cyber vs it_support with the stronger Gemini model.

    This is intentionally smaller than the full classifier so it can run in the
    background without deciding category/severity or blocking the user turn.
    """
    observed_text = build_observed_text_from_collected(collected)
    direct_intent = str(direct_issue_type.get("intent", "")).strip().lower()
    direct_reason = str(direct_issue_type.get("reason", "")).strip()
    normalized_local = str(local_issue_type or "").strip().lower()

    prompt = (
        "Resolve only the top-level issue type for this incident intake conflict.\n\n"
        "Return one JSON object only:\n"
        '{"issue_type":"cyber|it_support","analysis":"short evidence-based reason max 180 chars"}\n\n'
        "Definitions:\n"
        "- cyber: security risk, suspicious activity, compromise, unauthorized access, malware, phishing, data exposure, policy/security violation, or security-sensitive device loss.\n"
        "- it_support: routine access help, setup, outage, crash, malfunction, performance, hardware, software, network, communication, or service request without security-risk evidence.\n\n"
        "Low-confidence fast AI result:\n"
        f"- issue_type: {direct_intent or 'unclear'}\n"
        f"- confidence: {_parse_confidence(direct_issue_type.get('confidence')):.2f}\n"
        f"- reason: {direct_reason or 'not provided'}\n\n"
        "Local rule result:\n"
        f"- issue_type: {normalized_local or 'unclear'}\n\n"
        "Incident facts:\n"
        f"{observed_text}"
    )

    req_start = time.time()
    try:
        payload, api_time, used_fallback = request_json_completion(
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a senior incident triage adjudicator. "
                        "Return one strict JSON object only."
                    ),
                },
                {"role": "user", "content": prompt},
            ],
            model=_strong_classifier_model(),
            temperature=0.0,
            top_p=1.0,
            max_tokens=2048,
            timeout=30.0,
            use_gemini_fallback=False,
        )
        issue_type = str(payload.get("issue_type", "")).strip().lower()
        if issue_type not in {"cyber", "it_support"}:
            return {}

        result = {
            "issue_type": issue_type,
            "analysis": str(payload.get("analysis", "")).strip()[:180],
        }
        _ai_tracker.log_call(
            "classify_issue_type_conflict_with_strong_model",
            time.time() - req_start,
            (
                f"model={_strong_classifier_model()} fallback={used_fallback} "
                f"issue_type={issue_type} api_time={api_time:.2f}s"
            ),
        )
        return result
    except Exception as exc:
        _ai_tracker.log_call(
            "classify_issue_type_conflict_with_strong_model (failed)",
            time.time() - req_start,
            f"model={_strong_classifier_model()} error={str(exc)[:80]}",
        )
        return {}


def _has_explicit_other_context(observed_text: str, issue_type: str) -> bool:
    """Return True when observed text contains strong signals that justify an 'other' category.

    Prevents every ambiguous description from defaulting to 'other' by requiring
    at least one explicit contextual keyword that confirms the label is intentional.
    """
    if issue_type == "cyber":
        return bool(
            re.search(
                r"\b(security concern|does not fit the usual categories|badge readers?|server room|physical security)\b",
                observed_text,
            )
        )
    if issue_type == "it_support":
        return bool(
            re.search(
                r"\b(it question that does not fit|does not fit the normal support categories|shared mailbox can be renamed|general it question)\b",
                observed_text,
            )
        )
    return False


def _apply_classification_guardrails(
    *,
    collected: Dict[str, Any],
    resolved_issue_type: str,
    resolved_category: Optional[str],
    resolved_severity: Optional[str],
    heuristic: Dict[str, str],
    preserve_issue_type: bool = False,
) -> tuple[str, Optional[str], Optional[str]]:
    """Apply deterministic safety constraints after AI or rule classification."""
    observed_text = build_observed_text_from_collected(collected).lower()
    category = str(resolved_category or "").strip().lower() or None
    severity = str(resolved_severity or "").strip().lower() or None
    issue_type = str(resolved_issue_type or "").strip().lower()

    if not preserve_issue_type and has_strong_data_disclosure_evidence(observed_text):
        issue_type = "cyber"
        category = "data_breach"

    if re.search(
        r"\b(no|not|without)\s+(?:a\s+)?suspicious (?:email|message|link|sender)\b",
        observed_text,
    ) and category == "phishing":
        category = heuristic.get("category") if heuristic.get("category") != "phishing" else None

    if issue_type in {"cyber", "it_support"} and category:
        guarded = enforce_issue_type_boundary({"category": category}, issue_type)
        category = guarded.get("category")

    if not category:
        category = heuristic.get("category") or None
    if not severity:
        severity = heuristic.get("severity") or None

    return issue_type, category, severity


def derive_recommendations_from_collected(collected: Dict[str, Any]) -> Dict[str, str]:
    """Return a shared category/severity recommendation set from collected incident details."""
    recommendations: Dict[str, str] = {}

    current_issue_type = str(collected.get("issue_type", "")).strip().lower()
    resolved_collected = dict(collected)

    if current_issue_type == "not_sure":
        inferred_issue_type = infer_issue_type_from_collected(collected)
        if inferred_issue_type:
            resolved_collected["issue_type"] = inferred_issue_type
            recommendations["issue_type"] = inferred_issue_type

    category = infer_category_from_collected(resolved_collected)
    if category:
        recommendations["category"] = category

    severity = infer_severity_from_collected(
        {
            **resolved_collected,
            **({"category": category} if category else {}),
        }
    )
    if severity:
        recommendations["severity"] = severity

    resolved_issue_type = str(resolved_collected.get("issue_type", "")).strip().lower()
    return enforce_issue_type_boundary(recommendations, resolved_issue_type)


def _build_classification_summary(collected: Dict[str, Any]) -> str:
    """Serialize collected incident fields into a human-readable summary for the classification prompt.

    Only includes fields with non-empty values; boolean flags and list values
    are rendered to plain text so the LLM does not need to parse raw Python types.
    """
    fields = [
        ("description", "Description"),
        ("noticed_time", "When noticed"),
        ("incident_active", "Still active"),
        ("response_taken", "Action taken"),
        ("response_details", "Action details"),
        ("impact_scope", "Impact scope"),
        ("work_continuity", "Work impact"),
        ("location_type", "Location type"),
        ("location_detail", "Location details"),
        ("affected_asset", "Affected asset"),
        ("error_symptom", "Error symptom"),
        ("data_involved_flag", "Sensitive data involved"),
        ("data_involved", "Data types"),
        ("external_party_involved", "External party involved"),
        ("external_party_details", "External party details"),
        ("already_reported_to_it", "Reported to IT"),
        ("reported_to_details", "Reported to IT details"),
    ]
    lines: List[str] = []
    for field_name, label in fields:
        value = collected.get(field_name)
        if value in (None, "", []):
            continue
        if isinstance(value, list):
            value_text = ", ".join(str(item) for item in value)
        else:
            value_text = str(value)
        lines.append(f"- {label}: {value_text}")
    return "\n".join(lines)


def _validate_ai_classification_payload(
    payload: Dict[str, Any],
    locked_issue_type: str,
) -> Dict[str, Any]:
    """Validate and sanitize a raw JSON payload returned by the classification model.

    Ensures the response contains a known issue_type, a category that belongs to
    that domain, and a recognised severity level.  Returns an empty dict when the
    issue_type is absent or unrecognised so callers can fall back to heuristics.
    """
    validated: Dict[str, Any] = {}

    issue_type = str(payload.get("issue_type", "")).strip().lower()
    if locked_issue_type:
        issue_type = locked_issue_type
    if issue_type in {"cyber", "it_support"}:
        validated["issue_type"] = issue_type
    else:
        return {}

    allowed_categories = set(get_categories_by_issue_type(issue_type))
    category = str(payload.get("category", "")).strip().lower()
    if category in allowed_categories:
        validated["category"] = category

    severity = str(payload.get("severity", "")).strip().lower()
    if severity in {"low", "medium", "high", "critical"}:
        validated["severity"] = severity

    analysis = str(payload.get("analysis", "")).strip()
    if analysis:
        validated["analysis"] = analysis[:220]

    return validated


def _estimate_classification_confidence(
    *,
    collected: Dict[str, Any],
    resolved_issue_type: str,
    resolved_category: Optional[str],
    resolved_severity: Optional[str],
    heuristic: Dict[str, str],
    validated_ai: Dict[str, Any],
) -> str:
    """Estimate classification confidence as 'high', 'medium', or 'low'.

    Scoring factors:
    - Description length (longer narratives carry more signal).
    - Number of supporting factual fields already collected.
    - Agreement between AI output and deterministic heuristics.

    Returns 'high' for score >= 6, 'medium' for >= 4, otherwise 'low'.
    """
    score = 0
    description = str(collected.get("description", "")).strip()
    if len(description) >= 160:
        score += 2
    elif len(description) >= 60:
        score += 1

    supporting_fields = [
        "noticed_time",
        "incident_active",
        "response_taken",
        "impact_scope",
        "work_continuity",
        "affected_asset",
        "error_symptom",
        "data_involved_flag",
        "external_party_involved",
    ]
    score += min(
        3,
        sum(1 for field_name in supporting_fields if collected.get(field_name) not in (None, "", [])),
    )

    if validated_ai.get("issue_type") == heuristic.get("issue_type", resolved_issue_type):
        score += 1
    if resolved_category and resolved_category == heuristic.get("category"):
        score += 1
    if resolved_severity and resolved_severity == heuristic.get("severity"):
        score += 1

    if score >= 6:
        return "high"
    if score >= 4:
        return "medium"
    return "low"


def _build_classification_analysis(
    *,
    resolved_issue_type: str,
    resolved_category: Optional[str],
    resolved_severity: Optional[str],
    confidence: str,
    heuristic: Dict[str, str],
    validated_ai: Dict[str, Any],
) -> str:
    """Build a short human-readable analysis string to surface in the confirmation prompt.

    Prefers the model's own analysis text when available; falls back to a
    structured sentence built from the resolved fields and confidence level.
    """
    model_analysis = str(validated_ai.get("analysis", "")).strip()
    if model_analysis:
        return model_analysis

    parts: List[str] = []
    domain_label = "Cyber" if resolved_issue_type == "cyber" else "IT Support"
    parts.append(f"Best fit: {domain_label}")
    if resolved_category:
        parts.append(resolved_category.replace("_", " "))
    if resolved_severity:
        parts.append(f"{resolved_severity} severity")
    if heuristic.get("category") == resolved_category and heuristic.get("severity") == resolved_severity:
        parts.append("AI and rules agree")
    parts.append(f"{confidence} confidence")
    return ". ".join(parts) + "."


def _should_prefer_ai_issue_type(
    *,
    locked_issue_type: str,
    heuristic_issue_type: str,
    heuristic: Dict[str, str],
    validated_ai: Dict[str, Any],
) -> bool:
    """Decide whether the AI's issue_type should override the heuristic result.

    Returns True only when:
    - No issue type is externally locked.
    - The AI resolved 'cyber' with a specific (non-'other') category.
    - The heuristic produced a weak IT-support default with no category or severity.
    - The AI's category is security-specific or the severity is high/critical.
    """
    if locked_issue_type:
        return False

    ai_issue_type = str(validated_ai.get("issue_type", "")).strip().lower()
    ai_category = str(validated_ai.get("category", "")).strip().lower()
    ai_severity = str(validated_ai.get("severity", "")).strip().lower()

    if ai_issue_type != "cyber":
        return False
    if ai_category in {"", "other"}:
        return False

    heuristic_issue_type = str(heuristic_issue_type or "").strip().lower()
    heuristic_category = str(heuristic.get("category", "")).strip().lower()
    heuristic_severity = str(heuristic.get("severity", "")).strip().lower()

    heuristic_is_weak_it_default = (
        heuristic_issue_type == "it_support"
        and not heuristic_category
        and not heuristic_severity
    )
    ai_is_security_specific = ai_category in {
        "phishing",
        "credential_compromise",
        "unauthorized_access",
        "data_breach",
        "malware",
        "suspicious_activity",
        "email_exposure",
    }
    ai_is_high_impact = ai_severity in {"high", "critical"}

    return heuristic_is_weak_it_default and (ai_is_security_specific or ai_is_high_impact)


def _looks_like_meaningful_description(text: str) -> bool:
    """Return True when a text fragment is substantial enough to classify.

    Rejects single-word answers, common filler phrases, and texts below
    the minimum description length so the classifier is never called on
    noise-only input.
    """
    stripped = (text or "").strip()
    normalized = _normalize_text(stripped)

    if len(stripped) < FORM_SCHEMA["description"].get("min_length", 10):
        return False

    weak_values = {
        "1",
        "0",
        "ok",
        "okay",
        "yes",
        "no",
        "y",
        "n",
        "true",
        "false",
        "unknown",
        "na",
        "n/a",
        "none",
    }

    enum_like_values = (
        set(FORM_SCHEMA["category"]["enum"])
        | set(FORM_SCHEMA["severity"]["enum"])
        | set(FORM_SCHEMA["preferred_contact_method"]["enum"])
    )

    if normalized in weak_values or normalized in enum_like_values:
        return False

    if not re.search(r"[A-Za-z\u4e00-\u9fff]", stripped):
        return False

    if re.search(r"[\u4e00-\u9fff]", stripped):
        return len(re.findall(r"[\u4e00-\u9fff]", stripped)) >= 5

    if " " in stripped:
        return len([part for part in stripped.split() if part]) >= 2

    return False


def _infer_category_from_text(
    text: str, issue_type: Optional[str] = None
) -> Optional[str]:
    """Infer an incident category from free text using ordered regex rules.

    Matches are evaluated from most specific to most generic so that a
    description containing both malware and phishing signals resolves to
    the more concrete category.  Returns None when no rule fires.
    """
    lowered = text.lower()

    normalized_issue_type = str(issue_type or "").strip().lower()
    allow_cyber = normalized_issue_type in {"", "cyber", "not_sure"}
    allow_it_support = normalized_issue_type in {"", "it_support", "not_sure"}

    if allow_cyber and re.search(r"\b(cyber|security)\s+incident\b", lowered):
        return "suspicious_activity"

    if allow_cyber and re.search(
        r"\b(malware|virus|trojan|worm|ransomware|popup|pop-up|antivirus|infected)\b",
        lowered,
    ):
        return "malware"
    if allow_cyber and re.search(
        r"\b(opened|opening).*(attachment).*(slow|popup|pop-up|infected|weird)\b|\bslow.*after opening.*attachment\b|\b(popups?|pop-ups?).*after.*attachment\b|\bslow.*and.*popups?.*after.*attachment\b",
        lowered,
    ):
        return "malware"
    has_suspicious_negation = bool(
        re.search(r"\b(no|not|without)\s+(?:a\s+)?suspicious (?:email|message|link|sender)\b", lowered)
    )

    if allow_cyber and not has_suspicious_negation and re.search(
        r"\b(phishing|suspicious email|unknown sender|spoofed|fake login|credential harvest|fake microsoft 365|fake office 365|sender.*(?:unusual|suspicious|fake|invalid)|sender.*looked\s+fake|unusual.*sender|clicked.*(?:link|url)|log\s*in.*(?:through|via).*(?:link|url)|entered.*(?:login details|credentials).*(?:page|site).*(?:email|message)|page linked from an email|suspicious.*(?:email|message)|fake.*email)\b",
        lowered,
    ):
        return "phishing"
    if allow_cyber and re.search(
        r"\b(unexpected mfa|mfa prompt(s)?|credential|account compromise|compromised account|unexpected password reset|"
        r"(?:entered|typed|submitted).*(?:username|user name|password|login).*(?:fake|linked|email|page|portal)|"
        r"(?:username|user name).*(?:password).*(?:fake|linked|email|page|portal)|"
        r"(?:password|credentials?) (?:were|was|may have been|might have been)? ?(?:captured|stolen|compromised))\b",
        lowered,
    ):
        return "credential_compromise"
    if allow_cyber and re.search(
        r"\b(login alerts?.*(?:another country|unknown country)|(?:another country|unknown country).*login alerts?|"
        r"unexpected login alerts?|unknown country login)\b",
        lowered,
    ):
        return "unauthorized_access"
    if allow_cyber and re.search(
        r"\b(account locked)\b",
        lowered,
    ) and re.search(r"\b(mfa prompt|unexpected|not requested|another country|suspicious)\b", lowered):
        return "credential_compromise"
    if allow_cyber and re.search(
        r"\b(email exposure|email sent to wrong|wrong email recipient|sent .* to the wrong external recipient|"
        r"wrong external recipient|recalled (?:the )?message|recipient opened)\b",
        lowered,
    ):
        return "email_exposure"
    if allow_cyber and has_strong_data_disclosure_evidence(lowered):
        return "data_breach"
    if allow_cyber and re.search(
        r"\b(data leak|data breach|exposed data|leaked data|wrong person|wrong recipient|sent .* to the wrong)\b",
        lowered,
    ):
        return "data_breach"
    if allow_cyber and re.search(
        r"\b(lost (?:my )?(?:work )?(?:phone|laptop|device)|stolen (?:my )?(?:work )?(?:phone|laptop|device)|left (?:my )?(?:work )?(?:phone|laptop|device) in)\b",
        lowered,
    ):
        return "device_loss"
    if allow_cyber and re.search(
        r"\b(unauthorized access|unexpected login|accessed without permission)\b",
        lowered,
    ):
        return "unauthorized_access"
    if allow_cyber and re.search(
        r"\b(unusual powershell|powershell windows?|temporary folder|files appearing|reverse shell|unexpected script|"
        r"suspicious process|unusual process|suspicious activity)\b",
        lowered,
    ):
        return "suspicious_activity"
    if allow_cyber and re.search(
        r"\b(policy violation|against (?:our )?(?:data handling|security|company) policy|personal gmail|personal email account|"
        r"shared .* through .*personal|sent .* through .*personal|personal dropbox|personal cloud|uploaded .* to .*personal)\b",
        lowered,
    ):
        return "policy_violation"
    if allow_cyber and re.search(
        r"\b(certificate warning|tls certificate|expired certificate|dns change|public web application|browser security errors?|"
        r"security certificate|ssl certificate|infrastructure issue)\b",
        lowered,
    ):
        return "infrastructure_issue"
    if allow_cyber and re.search(
        r"\b(security concern|badge readers?|server room|taking photos of badge|visitor.*server room|physical security)\b",
        lowered,
    ):
        return "other"
    if allow_cyber and re.search(
        r"\b(lost laptop|stolen laptop|lost device|stolen device)\b", lowered
    ):
        return "device_loss"

    if allow_it_support and re.search(
        r"\b(it question that does not fit|does not fit the normal support categories|shared mailbox can be renamed|general it question)\b",
        lowered,
    ):
        return "other"
    if allow_it_support and re.search(
        r"\b(help setting up|help .* setup|new workstation|standard office applications|getting started|setup my new workstation|"
        r"setting up my new workstation|printer connection.*docking station)\b",
        lowered,
    ):
        return "general_technical_support"
    if allow_it_support and re.search(
        r"\b(service request|request setup|need setup|new account request|access request|need a monitor|software installed|just started)\b",
        lowered,
    ):
        return "service_request"
    if allow_it_support and re.search(
        r"\b(hardware|keyboard|mouse|monitor|printer|laptop issue|desktop issue|will not turn on|won't turn on|blank screen|screen remains blank)\b",
        lowered,
    ):
        return "hardware_issue"
    if allow_it_support and re.search(
        r"\b(network issue|network down|wifi issue|wi-fi issue|vpn issue|internet issue|no connection|vpn keeps disconnecting|disconnecting every few minutes"
        r"|vpn.*(?:drops?|disconnects?|reconnects?|unstable)"
        r"|wi-?fi.*(?:unavailable|not working|down|gone|dropped|unstable|disconnected)"
        r"|(?:office|floor|level|building|campus).*wi-?fi"
        r"|connection.*(?:unstable|dropped|unavailable|lost|not available)"
        r"|internet.*(?:down|unavailable|not working|outage)"
        r"|no.*(?:wifi|wi-fi|internet|network|connection)"
        r"|(?:wifi|wi-fi|network|internet).*became.*(?:unavailable|down|unstable))\b",
        lowered,
    ):
        return "network_issue"
    if allow_it_support and re.search(
        r"\b(software issue|application issue|app crash|cannot install|installation issue|outlook crashes|application is not responding|times out"
        r"|outlook.*(?:will not open|won't open|does not open|crashes|crashing)"
        r"|app.*(?:crash|crashed|crashing|freezing|frozen|not responding|will not open|won't open|won't load)"
        r"|program.*(?:crash|not responding|stopped working)"
        r"|(?:keeps?|keep).*crashing)\b",
        lowered,
    ):
        return "software_issue"
    if allow_it_support and re.search(
        r"\b(account issue|access issue|permission issue|login issue|cannot login|cannot log in|cannot sign in|can't sign in|"
        r"unable to sign in|password reset|account is locked|account locked|locked out|need access restored|approve timesheets)\b",
        lowered,
    ):
        return "access_account_issue"
    if allow_it_support and re.search(
        r"\b(teams issue|outlook issue|email sync|communication issue|teams calls?|teams meetings?|meetings? show connecting|"
        r"audio starts|chat works|calls? failing)\b",
        lowered,
    ):
        return "communication"
    if allow_it_support and re.search(
        r"\b(performance issue|slow system|system slow|lagging|slowness|extremely slow|very slow|takes several minutes|"
        r"cpu usage stays high|slow performance|basic applications takes? several minutes)\b",
        lowered,
    ):
        return "performance_issue"
    if allow_it_support and re.search(
        r"\b(technical incident|service outage|unexpected technical problem|system is down|tool is unavailable|core tool is unavailable|"
        r"system is unavailable|unavailable for the whole team|multiple users|get a server error|server error after logging in|"
        r"outage|whole team.*cannot|dashboard is down|reporting dashboard is down|dashboard.*server error)\b",
        lowered,
    ):
        return "technical_incident"
    if allow_it_support and re.search(
        r"\b(help setting up|help .* setup|new workstation|standard office applications|getting started|setup my new workstation|"
        r"setting up my new workstation|printer connection.*docking station)\b",
        lowered,
    ):
        return "general_technical_support"

    return None


def _infer_severity_from_text(text: str, category: Optional[str]) -> Optional[str]:
    """Infer a severity level from free text and the resolved category.

    Uses conservative heuristics: errs toward 'medium' for ambiguous signals
    and requires concrete multi-user or data-exposure evidence before returning
    'high' or 'critical'.
    """
    lowered = text.lower()
    data_involved_flag = _extract_data_involved_flag(text)

    if category in {
        "malware",
        "phishing",
        "credential_compromise",
        "suspicious_activity",
    }:
        if data_involved_flag is False and re.search(
            r"\b(laptop|device|attachment|antivirus|popup|pop-up|slow|email)\b", lowered
        ):
            return "medium"

    if category == "malware" and re.search(
        r"\b(suspicious email|opened an attachment|opening an attachment|popup|pop-up|infected)\b",
        lowered,
    ):
        return "high"

    if re.search(
        r"\b(critical|company-wide|whole company|many devices|multiple systems|service down|production down|ransomware spreading)\b",
        lowered,
    ):
        return "critical"

    if category in {"technical_incident", "network_issue", "software_issue", "access_account_issue"}:
        if re.search(r"\b(cannot work|can't work|unable to work|team|department|tool is unavailable|system is down|blocked)\b", lowered):
            return "high"
        if re.search(r"\b(cannot access|can't access|unable to access|disconnecting|times out|crashes)\b", lowered):
            return "medium"
        if category == "access_account_issue":
            return "medium"

    if data_involved_flag is not False and re.search(
        r"\b(customer data|personal data|financial data|credentials exposed|multiple devices|department|cannot work|can't work|unable to work|service disruption|exfiltration|breach confirmed)\b",
        lowered,
    ):
        return "high"

    if category == "unauthorized_access" and not re.search(
        r"\b(single account|single device|no data involved)\b", lowered
    ):
        return "high"

    if category in {
        "malware",
        "phishing",
        "credential_compromise",
        "suspicious_activity",
    }:
        if re.search(
            r"\b(no customer data|no data involved|as far as i know)\b", lowered
        ):
            return "medium"
        if re.search(
            r"\b(laptop|device|attachment|antivirus|popup|pop-up|slow)\b", lowered
        ):
            return "medium"

    if category == "data_breach":
        if re.search(r"\b(recalled it immediately|not sure whether they opened it|uncertain whether they opened it)\b", lowered):
            return "medium"
        return "high"

    if category == "service_request":
        return "low"

    if category == "other":
        if re.search(r"\b(need help asap|need help|wanted to check|strange email|suspicious email|weird email)\b", lowered):
            return "low"

    if re.search(
        r"\b(suspicious|unknown sender|attachment|antivirus|popup|pop-up|slow)\b",
        lowered,
    ):
        return "medium"

    if category in {
        "credential_compromise",
        "device_loss",
        "phishing",
        "malware",
        "suspicious_activity",
    }:
        return "medium"

    return None


def _extract_data_involved_flag(text: str) -> Optional[bool]:
    """Detect whether sensitive data was involved, based on explicit text signals.

    Returns True for clear affirmative mentions, False for explicit negations,
    and None when the text is ambiguous or the reporter is uncertain.
    """
    lowered = text.lower()

    if re.search(
        r"\b(no customer data was involved|no data was involved|no sensitive data was involved|no customer data involved|no personal data was involved|no credentials were involved|no customer or employee data was involved)\b",
        lowered,
    ):
        return False
    if re.search(
        r"\b(not sure (?:what|whether).*(?:exposed|involved)|might have involved|may have involved)\b",
        lowered,
    ):
        return None
    if re.search(
        r"\b(customer data|personal data|financial data|credentials|sensitive data|employee data|company data)\b",
        lowered,
    ):
        return True

    return None


def _normalize_text(text: str) -> str:
    """Collapse whitespace and lowercase text for consistent pattern matching."""
    return re.sub(r"\s+", " ", (text or "").strip().lower())
