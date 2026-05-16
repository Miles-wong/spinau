"""
Assistant response generation for the conversational form pipeline.

Responsibilities
----------------
- Choose which field to ask next with deterministic priority order.
- Generate natural-language responses via the configured LLM, or fall back to
  template-based messages when the API call fails or is skipped.
- Handle three turn scenarios: field resolved, other fields captured, nothing captured.
- Support both synchronous and streaming (SSE) response modes.
"""

import json
import os
import time
from typing import Any, Dict, Generator, List, Optional

from .ai import MODEL_PROVIDER
from .llm_backend import request_text_completion, stream_text_completion
from .schema import FORM_SCHEMA
from .question_flow import get_next_question
from .tracker import _ai_tracker


ASSISTANT_SYSTEM_RULES = (
    "You are a helpful incident and IT support intake assistant. "
    "Write concise, professional, user-facing replies. "
    "Core response policy: "
    "1) Keep a stable style and stay brief. "
    "2) Do not output JSON, schema terms, internal field names, or technical metadata. "
    "3) Acknowledge what the user provided, then naturally transition to the provided next question. "
    "4) You will be given a 'next question' template. Rephrase it naturally based on context; "
    "do not quote it verbatim. Adapt the wording to flow smoothly from your acknowledgement. "
    "5) If information is still missing, ask only ONE clear next question. "
    "6) If complete, clearly state the report is ready for submission. "
    "7) Keep responses to 2-4 short sentences. "
    "8) When the next question is about location, use generic phrasing; "
    "never mention the specific incident type (e.g. password, email, breach) in that question."
)


def choose_next_field(collected: Dict[str, Any], missing: List[str]) -> Optional[str]:
    """Return the highest-priority field still missing from the collected state.

    The missing list is already sorted by compute_missing_fields; this simply
    returns the first entry so callers stay explicit and easy to mock.
    """
    if not missing:
        return None
    return missing[0]


# Fields whose answers are always short/boolean and don't benefit from AI rewording.
# For these, skip the AI call and return the template reply instantly.
_TEMPLATE_ONLY_FIELDS = frozenset({
    "issue_type",
    "incident_active",
    "response_taken",
    "data_involved_flag",
    "data_involved",
    "data_other_text",
    "external_party_involved",
    "already_reported_to_it",
    "preferred_contact_method",
    "phone_number",
    "category",
    "severity",
})

_AI_REPLY_POLISH_MODE = os.environ.get("AI_REPLY_POLISH", "selective").strip().lower()
_AI_POLISH_TEXT_FIELDS = frozenset({
    "description",
    "response_details",
    "affected_asset",
    "error_symptom",
    "impact_scope",
    "work_continuity",
    "external_party_details",
    "reported_to_details",
    "location_detail",
})


def _build_template_reply(
    *,
    next_question: str,
    expected_field: Optional[str],
    patch: Dict[str, Any],
    missing: List[str],
) -> str:
    """Return a warmer template reply without calling the model."""
    if not next_question:
        return "Thanks, I have noted that."

    if expected_field and expected_field not in missing:
        prefix = "Got it."
    elif patch:
        prefix = "That helps."
    else:
        prefix = "No problem."

    if next_question.startswith(("Could", "What", "Who", "How", "When", "Where", "Is", "Has", "Did", "To route")):
        return f"{prefix} {next_question}".strip()
    return f"{prefix} {next_question}".strip()


def _should_use_ai(
    expected_field: Optional[str],
    user_message: str,
    patch: Dict[str, Any],
    missing: List[str],
    failed_attempts: int = 0,
) -> bool:
    """Return True only when an AI rewrite adds genuine value.

    Criteria:
    - The expected field is not in the template-only set (boolean / enum)
    - The user's message is long enough to reference naturally (>= 10 chars)
    - Something was actually extracted (so we have a value to acknowledge)
    - There are still fields to ask (no point calling AI just to say "done")
    """
    polish_mode = _AI_REPLY_POLISH_MODE
    if polish_mode in {"0", "false", "no", "off", "template"}:
        return False
    if not missing:
        return False
    if expected_field in _TEMPLATE_ONLY_FIELDS:
        return False
    if polish_mode == "full":
        return True
    if failed_attempts >= 1:
        return True
    if len(user_message.strip()) < 10:
        return False

    # Selective mode: use AI only when it softens a genuinely complex moment.
    # Ordinary short-answer turns stay template-only for speed and consistency.
    if expected_field in _AI_POLISH_TEXT_FIELDS and patch and len(user_message.strip()) >= 40:
        return True
    captured_text_fields = set(patch).intersection(_AI_POLISH_TEXT_FIELDS)
    return bool(captured_text_fields and len(user_message.strip()) >= 80)


def build_fallback_assistant_message(
    user_message: str,
    collected: Dict[str, Any],
    missing: List[str],
    extracted_patch: Optional[Dict[str, Any]] = None,
    expected_field: Optional[str] = None,
    previous_missing: Optional[List[str]] = None,
    failed_attempts: int = 0,
) -> str:
    """Build assistant message with context-aware three-case logic."""

    patch = extracted_patch or {}

    if not missing:
        return (
            "Thank you for providing all the required information. "
            "Your minimum viable ticket is now ready to be submitted. "
            "Please review the collected information and click Submit when ready."
        )

    # Fast path: skip AI for boolean/enum/short-answer fields.
    next_field = choose_next_field(collected, missing)
    _, next_question, _ = get_next_question(collected, missing) if next_field else (None, "", {})

    if not _should_use_ai(expected_field, user_message, patch, missing, failed_attempts):
        return _build_template_reply(
            next_question=next_question,
            expected_field=expected_field,
            patch=patch,
            missing=missing,
        )

    # --- Three-case scenario detection ---
    # Case 1: User answered the current expected field → move on
    expected_was_resolved = (
        expected_field is not None and expected_field not in missing
    )
    # Case 2: User answered OTHER fields but not the current expected
    other_fields_captured = (
        expected_field is not None
        and expected_field in missing
        and bool(patch)
    )
    # Case 3: Nothing useful extracted for the expected field
    nothing_captured = (
        expected_field is not None
        and expected_field in missing
        and not patch
    )

    if expected_was_resolved:
        # Include the actual value the user provided so AI can reference it naturally.
        resolved_value = collected.get(expected_field, patch.get(expected_field, ""))
        resolved_label = FORM_SCHEMA.get(expected_field, {}).get('label', expected_field)
        scenario_hint = (
            f"The user answered '{resolved_label}' with: '{resolved_value}'. "
            "Briefly acknowledge their specific answer, then naturally lead into the next question."
        )
    elif other_fields_captured:
        captured_labels = [FORM_SCHEMA.get(f, {}).get("label", f) for f in patch]
        expected_label = FORM_SCHEMA.get(expected_field, {}).get("label", expected_field)
        scenario_hint = (
            f"The user's reply provided some useful info ({', '.join(captured_labels)}), "
            f"but we still need '{expected_label}'. "
            "Briefly acknowledge what was noted, then naturally re-ask the missing field."
        )
    elif nothing_captured:
        expected_label = FORM_SCHEMA.get(expected_field, {}).get("label", expected_field)
        expected_type = FORM_SCHEMA.get(expected_field, {}).get("type", "string")
        if expected_type == "boolean":
            example_hint = "Please answer Yes or No."
        elif expected_field == "noticed_time":
            example_hint = "For example: today at 2 PM, or yesterday morning."
        else:
            example_hint = ""
        scenario_hint = (
            f"The user's reply did not give us any clear information about '{expected_label}'. "
            f"Politely re-ask the question. {example_hint}"
        )
    else:
        scenario_hint = "Process the user's input naturally and ask the next question."

    prompt = f"""Current turn context:

Scenario instruction: {scenario_hint}

The user just said:
"{user_message}"

Fields extracted from this reply: {json.dumps(patch, ensure_ascii=False) if patch else 'none'}

IMPORTANT: {'Your reply MUST end with this question (rephrase it naturally, do not quote verbatim): ' + next_question if next_question else 'The report is now complete. Do NOT ask another question; tell the user their report is ready to submit.'}"""

    try:
        response_text, _api_time = request_text_completion(
            messages=[
                {
                    "role": "system",
                    "content": ASSISTANT_SYSTEM_RULES,
                },
                {"role": "user", "content": prompt},
            ],
            temperature=0.4,
            max_tokens=200,
            timeout=4.0,
        )
        return response_text
    except Exception as exc:
        _ai_tracker.log_call("build_fallback_assistant_message (failed)", 0.0, f"error={str(exc)[:80]}")
        return _build_template_reply(
            next_question=next_question,
            expected_field=expected_field,
            patch=patch,
            missing=missing,
        )


def generate_assistant_message(
    user_message: str,
    collected: Dict[str, Any],
    missing: List[str],
    extracted_patch: Optional[Dict[str, Any]] = None,
    expected_field: Optional[str] = None,
    previous_missing: Optional[List[str]] = None,
    failed_attempts: int = 0,
) -> str:
    """Generate context-aware assistant reply using the three-case AI logic."""
    return build_fallback_assistant_message(
        user_message,
        collected,
        missing,
        extracted_patch,
        expected_field=expected_field,
        previous_missing=previous_missing,
        failed_attempts=failed_attempts,
    )


def stream_assistant_message(
    user_message: str,
    collected: Dict[str, Any],
    missing: List[str],
    extracted_patch: Optional[Dict[str, Any]] = None,
    expected_field: Optional[str] = None,
    previous_missing: Optional[List[str]] = None,
    failed_attempts: int = 0,
) -> Generator[str, None, None]:
    """Stream the assistant's natural-language reply from the LLM."""
    stream_start = time.time()

    patch = extracted_patch or {}

    # Fast path: skip AI entirely for boolean/enum/short-answer fields.
    # These never benefit from AI rewording and skipping saves ~1-2s per turn.
    if not _should_use_ai(expected_field, user_message, patch, missing, failed_attempts):
        reply = build_fallback_assistant_message(
            user_message, collected, missing, patch,
            expected_field=expected_field,
            previous_missing=previous_missing,
            failed_attempts=failed_attempts,
        )
        yield reply
        return

    # Use the template question as the base; the main AI will rephrase it naturally.
    next_question = ""
    if missing:
        _, next_question, _ = get_next_question(collected, missing)

    expected_was_resolved = (
        expected_field is not None and expected_field not in missing
    )
    other_fields_captured = (
        expected_field is not None and expected_field in missing and bool(patch)
    )
    nothing_captured = (
        expected_field is not None and expected_field in missing and not patch
    )

    if expected_was_resolved:
        # Include the actual value the user provided so AI can reference it naturally.
        resolved_value = collected.get(expected_field, patch.get(expected_field, ""))
        resolved_label = FORM_SCHEMA.get(expected_field, {}).get('label', expected_field)
        scenario_hint = (
            f"The user answered '{resolved_label}' with: '{resolved_value}'. "
            "Briefly acknowledge their specific answer, then naturally lead into the next question."
        )
    elif other_fields_captured:
        captured_labels = [FORM_SCHEMA.get(f, {}).get("label", f) for f in patch]
        expected_label = FORM_SCHEMA.get(expected_field, {}).get("label", expected_field)
        scenario_hint = (
            f"The user provided useful info ({', '.join(captured_labels)}), "
            f"but '{expected_label}' is still needed. Re-ask naturally."
        )
    elif nothing_captured:
        expected_label = FORM_SCHEMA.get(expected_field, {}).get("label", expected_field)
        scenario_hint = (
            f"The user's reply did not clearly provide '{expected_label}'. Politely re-ask with a concrete example."
        )
    else:
        scenario_hint = "Process naturally and ask the next question."

    prompt = f"""Current turn context:

Scenario instruction: {scenario_hint}

The user just said:
"{user_message}"

Fields extracted from this reply: {json.dumps(patch, ensure_ascii=False) if patch else 'none'}

IMPORTANT: {'Your reply MUST end with this question (rephrase it naturally, do not quote verbatim): ' + next_question if next_question else 'The report is now complete. Do NOT ask another question; tell the user their report is ready to submit.'}"""

    try:
        if MODEL_PROVIDER == "local":
            content, api_time = request_text_completion(
                messages=[
                    {
                        "role": "system",
                        "content": ASSISTANT_SYSTEM_RULES,
                    },
                    {"role": "user", "content": prompt},
                ],
                temperature=0.4,
                max_tokens=300,
                timeout=6.0,
            )

            safe_content = (content or "").strip()
            if not safe_content:
                safe_content = build_fallback_assistant_message(
                    user_message,
                    collected,
                    missing,
                    extracted_patch,
                    expected_field=expected_field,
                    previous_missing=previous_missing,
                    failed_attempts=failed_attempts,
                )

            yield safe_content

            stream_duration = time.time() - stream_start
            details = (
                f"model={MODEL_PROVIDER} mode=nonstream api_time={api_time:.2f}s "
                f"missing_fields={len(missing)}"
            )
            _ai_tracker.log_call("stream_assistant_message (local-nonstream)", stream_duration, details)
            return

        stream = stream_text_completion(
            messages=[
                {
                    "role": "system",
                    "content": ASSISTANT_SYSTEM_RULES,
                },
                {"role": "user", "content": prompt},
            ],
            temperature=0.4,
            max_tokens=200,
            timeout=4.0,
        )

        chunk_count = 0
        for chunk in stream:
            chunk_count += 1
            yield chunk

        stream_duration = time.time() - stream_start
        details = f"model={MODEL_PROVIDER} chunks={chunk_count} missing_fields={len(missing)}"
        _ai_tracker.log_call("stream_assistant_message (streaming)", stream_duration, details)
        _ai_tracker.log_subcomponent("API streaming call", stream_duration)

    except Exception:
        stream_duration = time.time() - stream_start
        details = f"model={MODEL_PROVIDER} error missing_fields={len(missing)}"
        _ai_tracker.log_call("stream_assistant_message (streaming-failed)", stream_duration, details)
        yield build_fallback_assistant_message(user_message, collected, missing)
