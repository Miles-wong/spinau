"""Question-flow logic: determine which field to ask next and generate question text.

Public API
----------
compute_missing_fields(collected)          Returns ordered list of still-missing fields.
get_next_question(collected, missing)      Returns (field, question_text, hints_dict).
generate_next_question_with_ai(...)        AI-generated natural-language question for a field.
generate_ai_suggestion_tip(collected, field)  One-line AI hint for category/severity chooser.
"""

import time
from typing import Any, Dict, List, Optional, Tuple

from .ai import MODEL_PROVIDER
from .classification import derive_recommendations_from_collected
from .flow_engine import compute_missing_fields as compute_missing_fields_engine
from .flow_engine import (
    select_next_field,
)
from .llm_backend import request_text_completion
from .schema import (
    FORM_SCHEMA,
    get_domain_category_label,
    get_fact_priority,
    normalize_issue_type,
)
from .tracker import _ai_tracker
from constants.incident_schema import get_categories_by_issue_type


def compute_missing_fields(collected: Dict[str, Any]) -> List[str]:
    """Compatibility wrapper around the deterministic flow engine.

    Keeping this wrapper in question_flow lets callers import one module for both:
    - missing-field computation
    - question generation
    """
    return compute_missing_fields_engine(
        collected,
        description_min_length=FORM_SCHEMA["description"].get("min_length", 10),
    )


def get_next_question(
    collected: Dict[str, Any],
    missing: List[str],
) -> Tuple[Optional[str], str, Dict[str, Any]]:
    """
    Generate the next question based on missing fields.

    Strategy:
    - Ask fact-based questions first
    - Avoid pushing users to classify severity/category too early
    - Keep location optional / low priority
    - Skip Cyber-only questions for IT Support domain

    Returns:
    - next_field: canonical field name to fill
    - question: user-facing question text
    - hints: input contract used by frontend composer (type/options/placeholders)
    """
    if not missing:
        return None, "", {}

    next_field = select_next_field(missing)
    schema = FORM_SCHEMA.get(next_field, {})
    field_type = schema.get("type", "string")
    hints: Dict[str, Any] = {"type": "text"}

    if field_type == "enum":
        enum_values = schema.get("enum", [])
        if next_field == "category":
            enum_values = get_categories_by_issue_type(
                str(collected.get("issue_type", "cyber"))
            )
        hints = {
            "type": "enum",
            "options": [
                {"value": v, "label": v.replace("_", " ").title()} for v in enum_values
            ],
        }
    elif field_type == "boolean":
        hints = {
            "type": "boolean",
            "options": [
                {"value": True, "label": "Yes"},
                {"value": False, "label": "No"},
            ],
        }
    elif field_type == "array":
        hints = {
            "type": "multi_select",
            "options": [
                {"value": v, "label": v.replace("_", " ").title()}
                for v in schema.get("items", [])
            ],
        }

    # Check if this is a Cyber domain (not IT Support)
    issue_type = normalize_issue_type(collected.get("issue_type", ""))
    is_cyber = issue_type == "cyber"
    category_label = get_domain_category_label(issue_type)

    questions_and_hints = {
        "issue_type": {
            "question": "To route this properly, should we treat it as cyber security, IT support, or are you not sure yet?",
            "hints": {
                "type": "enum",
                "options": [
                    {"value": "cyber", "label": "Cyber Security"},
                    {"value": "it_support", "label": "IT Support"},
                    {"value": "not_sure", "label": "Not Sure"},
                ],
            },
        },
        "description": {
            "question": "Start with what happened in your own words.",
            "hints": {
                "type": "textarea",
                "placeholder": "E.g., A customer received the wrong invoice, Outlook keeps crashing, or I clicked a suspicious link...",
                "examples": [
                    "A customer received another client's invoice by mistake",
                    "Outlook keeps crashing when I open attachments",
                    "I clicked a suspicious link and then noticed login alerts",
                ],
            },
        },
        "noticed_time": {
            "question": "Roughly when did you first notice it?",
            "hints": {
                "type": "text",
                "placeholder": "E.g., Today at 2pm, Yesterday morning",
                "examples": ["This morning around 9am", "About 2 hours ago"],
            },
        },
        "incident_active": {
            "question": "Is it still happening now?",
            "hints": {
                "type": "boolean",
                "options": [
                    {"value": True, "label": "Yes"},
                    {"value": False, "label": "No"},
                ],
            },
        },
        "response_taken": {
            "question": "Have you done anything about it so far?",
            "hints": {
                "type": "boolean",
                "options": [
                    {"value": True, "label": "Yes"},
                    {"value": False, "label": "No"},
                ],
                "detail_hint": {
                    "label": "Actions taken",
                    "placeholder": "E.g., Changed password, disconnected device from network, informed supervisor",
                },
            },
        },
        "response_details": {
            "question": "What have you tried or done so far?",
            "hints": {
                "type": "textarea",
                "placeholder": "E.g., Changed password, disconnected device from network, informed supervisor",
                "examples": [
                    "Changed my password",
                    "Disconnected the laptop from Wi-Fi",
                    "Reported it to my manager",
                ],
            },
        },
        "affected_asset": {
            "question": "What system, app, device, or service should we look at first?",
            "hints": {
                "type": "text",
                "placeholder": "E.g., Finance laptop, Outlook, payroll system, office printer, VPN",
                "examples": [
                    "My work laptop",
                    "Outlook on my desktop",
                    "The payroll system",
                ],
            },
        },
        "error_symptom": {
            "question": "What are you seeing when it goes wrong?",
            "hints": {
                "type": "textarea",
                "placeholder": "E.g., App crashes on launch, cannot sign in, printer shows offline, VPN disconnects",
                "examples": [
                    "Outlook keeps crashing when I open it",
                    "I cannot sign in and it says access denied",
                    "The printer is online but jobs do not print",
                ],
            },
        },
        "impact_scope": {
            "question": "Who or what seems affected: just you, one device, a team, or something wider?",
            "hints": {
                "type": "textarea",
                "placeholder": "E.g., Only me, my laptop only, several employees, one department",
                "examples": [
                    "Only my account seems affected",
                    "Only my work laptop is affected",
                    "It may affect the whole team",
                ],
            },
        },
        "work_continuity": {
            "question": "How is this affecting your work right now?",
            "hints": {
                "type": "textarea",
                "placeholder": "E.g., I cannot access email, work is delayed, no impact so far",
                "examples": [
                    "I cannot log in to email",
                    "My work is delayed but still possible",
                    "No impact on work yet",
                ],
            },
        },
        "preferred_contact_method": {
            "question": "What is the easiest way for the team to follow up with you?",
            "hints": hints,
        },
        "phone_number": {
            "question": "What phone number should we use if we need to call?",
            "hints": {
                "type": "text",
                "placeholder": "+1-555-0123",
            },
        },
        "category": {
            "question": f"If you had to pick one, which {category_label} category is closest?",
            "hints": hints,
        },
        "category_other_text": {
            "question": "What should we call this category in plain language?",
            "hints": {
                "type": "text",
                "placeholder": "E.g., unusual physical access attempt",
            },
        },
        "severity": {
            "question": "How urgent should the team treat this based on the impact so far?",
            "hints": hints,
        },
        "location_detail": {
            "question": "Where were you working when this happened?",
            "hints": {
                "type": "text",
                "placeholder": "E.g., Perth office, Barcelona office on company Wi-Fi, Perth remote work laptop at home",
                "examples": [
                    "Perth office, Level 12 finance area",
                    "Barcelona office with company Wi-Fi",
                    "Perth remote work laptop at home",
                ],
            },
        },
    }

    # Add Cyber-specific questions only for cyber domain
    if is_cyber:
        questions_and_hints.update(
            {
                "data_involved_flag": {
                    "question": "Could any customer, employee, financial, or other sensitive data be involved?",
                    "hints": {
                        "type": "boolean",
                        "options": [
                            {"value": True, "label": "Yes"},
                            {"value": False, "label": "No"},
                        ],
                    },
                },
                "data_involved": {
                    "question": "What kind of data might be involved?",
                    "hints": hints,
                },
                "data_other_text": {
                    "question": "What other type of data should we note?",
                    "hints": {
                        "type": "text",
                        "placeholder": "E.g., API keys, project documents",
                    },
                },
                "external_party_involved": {
                    "question": "Did anyone outside the company play a part in this?",
                    "hints": {
                        "type": "boolean",
                        "options": [
                            {"value": True, "label": "Yes"},
                            {"value": False, "label": "No"},
                        ],
                        "detail_hint": {
                            "label": "External party details",
                            "placeholder": "E.g., Vendor, customer, unknown sender, attacker IP",
                        },
                    },
                },
                "external_party_details": {
                    "question": "Who was involved externally, and what role did they play?",
                    "hints": {
                        "type": "text",
                        "placeholder": "E.g., Vendor, customer, unknown sender, attacker IP",
                    },
                },
                "already_reported_to_it": {
                    "question": "Has anyone in IT or security already been told?",
                    "hints": {
                        "type": "boolean",
                        "options": [
                            {"value": True, "label": "Yes"},
                            {"value": False, "label": "No"},
                        ],
                        "detail_hint": {
                            "label": "Who did you report it to, and when?",
                            "placeholder": "E.g., IT Service Desk today at 2:30 PM",
                        },
                    },
                },
                "reported_to_details": {
                    "question": "Who was told, and roughly when?",
                    "hints": {
                        "type": "text",
                        "placeholder": "E.g., IT Service Desk today at 2:30 PM",
                    },
                },
            }
        )

    config = questions_and_hints.get(
        next_field,
        {
            "question": f"Please provide: {schema.get('label', next_field)}",
            "hints": hints,
        },
    )

    result_hints = dict(config["hints"])

    # For AI-inferred fields that fall back to user selection, attach an
    # AI-generated recommendation so the reporter has context when choosing.
    if next_field in ("category", "severity"):
        suggestion = generate_ai_suggestion_tip(collected, next_field)
        if suggestion:
            # New format: dict with recommendedValue and tip
            result_hints["recommendedValue"] = suggestion.get("recommendedValue")
            result_hints["recommendedTip"] = suggestion.get("tip")
            # Only auto-select for the final manual fallback case:
            # auto inference did not populate severity and severity is now
            # the only remaining missing field to choose manually.
            if (
                next_field == "severity"
                and suggestion.get("recommendedValue")
                and not collected.get("severity")
                and len(missing) == 1
                and missing[0] == "severity"
            ):
                result_hints["autoSelectRecommended"] = True

    return next_field, config["question"], result_hints


def generate_next_question_with_ai(
    collected: Dict[str, Any],
    next_field: str,
    missing: List[str],
) -> str:
    """
    Generate the next question using AI instead of hardcoded templates.

    Args:
        collected: Fields already collected from the user
        next_field: The next field that needs to be filled
        missing: List of remaining missing fields

    Returns:
        A natural-language question generated by AI.

    Notes:
    - Falls back to template-based question text on any model error.
    - Applies explicit guardrails for location prompts to avoid over-specific
      references to incident type.
    """
    req_start = time.time()

    # Domain is the top-level branch in the intake flow. Keep this question deterministic
    # so the model never freelances or implicitly classifies it from narrative text.
    if next_field == "issue_type":
        _, fallback_question, _ = get_next_question(collected, missing)
        return fallback_question

    try:
        schema = FORM_SCHEMA.get(next_field, {})
        field_label = schema.get("label", next_field.replace("_", " ").title())
        field_type = schema.get("type", "string")

        # Build context for AI question generation
        collected_summary = _build_collected_summary(collected)
        enum_options = ""
        if field_type == "enum":
            enum_values = schema.get("enum", [])
            if next_field == "category":
                enum_values = get_categories_by_issue_type(
                    str(collected.get("issue_type", "cyber"))
                )
            enum_options = f"\nAvailable options: {', '.join(enum_values)}"

        missing_preview = ", ".join(missing[1:5])  # Skip current field

        # For location fields, prevent the LLM from referencing the specific incident type
        location_constraint = ""
        if next_field == "location_detail":
            location_constraint = (
                "\nIMPORTANT: Do NOT reference the specific incident type (e.g. 'password loss', "
                "'phishing email', 'the breach') in this question. "
                "Ask generically about the system, device, or environment where the incident occurred."
            )

        prompt = f"""You are a professional incident and IT support reporting assistant.

Context of what we've collected so far:
{collected_summary}

Current field to ask about: {field_label}
Field type: {field_type}{enum_options}

Remaining fields after this one: {missing_preview if missing_preview else "None - this might be the last field"}

Task: Generate a natural, professional, concise question to ask the user for the "{field_label}" field.

Requirements:
1. Make the question natural and conversational, not robotic
2. Keep it short (1 sentence, max 2)
3. If there are specific options/enum values, you can mention them naturally
4. Be empathetic to the user's situation
5. Reference context from what we already know if it helps{location_constraint}

Just respond with ONLY the question text, nothing else."""

        question, api_time = request_text_completion(
            messages=[
                {
                    "role": "system",
                    "content": "You are a helpful incident reporting assistant. Generate natural, professional questions.",
                },
                {"role": "user", "content": prompt},
            ],
            temperature=0.5,
            max_tokens=150,
            # Keep question generation snappy: local models get more time,
            # online models get 2 s; fast models (gpt-4o-mini etc.) finish
            # well within this; slow models fall back to the template instantly.
            timeout=15.0 if MODEL_PROVIDER == "local" else 2.0,
        )

        # Fallback to template if AI fails to generate
        if not question or len(question) < 10:
            _, fallback_question, _ = get_next_question(collected, missing)
            question = fallback_question

        req_time = time.time() - req_start
        details = f"field={next_field} model={MODEL_PROVIDER} api_time={api_time:.2f}s"
        _ai_tracker.log_call("generate_next_question_with_ai", req_time, details)

        return question

    except Exception as e:
        _ai_tracker.log_call(
            "generate_next_question_with_ai (failed)", 0.0, f"error={str(e)[:80]}"
        )
        # Fallback to template-based question
        _, fallback_question, _ = get_next_question(collected, missing)
        return fallback_question


def generate_ai_suggestion_tip(collected: Dict[str, Any], field: str) -> Optional[Dict[str, Any]]:
    """
    Generate a recommendation for category or severity, including both the
    recommended value AND a short tip text.

    Returns a dict with keys:
    - recommendedValue: the suggested enum value (e.g., "high", "phishing")
    - tip: short human-readable explanation (short for display)
    Or None if generation fails or is not applicable.
    """
    if field not in ("category", "severity"):
        return None

    description = str(collected.get("description", "")).strip()
    if len(description) < 10:
        return None

    shared_recommendations = derive_recommendations_from_collected(collected)

    if field == "severity":
        inferred_severity = shared_recommendations.get("severity")
        if inferred_severity:
            # Short tip only, no long explanation
            return {
                "recommendedValue": inferred_severity,
                "tip": f"Recommended: {inferred_severity.capitalize()}"
            }

    if field == "category":
        inferred_category = shared_recommendations.get("category")
        if inferred_category:
            # Short tip only
            return {
                "recommendedValue": inferred_category,
                "tip": f"Recommended: {inferred_category.replace('_', ' ').title()}"
            }

    return None


def _build_collected_summary(collected: Dict[str, Any]) -> str:
    """
    Build a concise summary of collected facts for question generation context.

    The summary is intentionally prioritized so the model sees high-signal facts
    first (domain facts, then classification fields).
    """
    if not collected:
        return "No information collected yet."

    summary_parts = []

    # Most relevant fields first
    priority_fields = [
        *get_fact_priority(normalize_issue_type(collected.get("issue_type", ""))),
        "category",
        "severity",
    ]

    for field in priority_fields:
        if field in collected and collected[field]:
            value = collected[field]
            label = FORM_SCHEMA.get(field, {}).get(
                "label", field.replace("_", " ").title()
            )

            # Format value nicely
            if isinstance(value, bool):
                value_str = "Yes" if value else "No"
            elif isinstance(value, list):
                value_str = ", ".join(str(v).replace("_", " ").title() for v in value)
            else:
                value_str = str(value)[:100]  # Truncate long values

            summary_parts.append(f"- {label}: {value_str}")

    return (
        "\n".join(summary_parts)
        if summary_parts
        else "Some information has been collected."
    )
