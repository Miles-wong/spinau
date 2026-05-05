"""Field extraction: parse a user message into structured incident-form values.

Strategy (fastest first, LLM last):
1. Fast path — detail/free-text fields:  store the raw reply directly, no LLM needed.
2. Fast path — boolean fields:          parse yes/no keywords without an LLM call.
3. Fast path — short enum replies:      fuzzy-match single-word answers against allowed values.
4. Semi-fast path — description field:  store immediately if rich enough, optionally chain LLM.
5. LLM path — everything else:          call the configured model to extract all remaining fields.

Results are cached by (message, collected-state) hash to avoid duplicate LLM calls
when the same turn is processed twice (e.g., streaming + final).
"""

import hashlib
import json
import re
import time
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from .ai import EXTRACTION_MODEL, MODEL_PROVIDER, get_openai_client
from .classification import (
    derive_recommendations_from_collected as classification_derive_recommendations,
    enforce_issue_type_boundary as classification_enforce_issue_type_boundary,
    extract_explicit_category as classification_extract_explicit_category,
    extract_explicit_data_types as classification_extract_explicit_data_types,
    extract_explicit_severity as classification_extract_explicit_severity,
    has_strong_data_disclosure_evidence as classification_has_strong_data_disclosure_evidence,
    infer_issue_type_from_collected as classification_infer_issue_type,
)
from .llm_backend import request_json_completion
from .prompts.extraction_prompt import build_extraction_prompt as build_extraction_prompt_template
from .schema import (
    EXTRACTION_FAST_MAX_TOKENS,
    EXTRACTION_MAX_TOKENS,
    EXTRACTION_SPEED_MODE,
    EXTRACTION_TOP_P,
    FORM_SCHEMA,
)
from .tracker import _ai_tracker

_extraction_cache: Dict[str, Dict[str, Any]] = {}
_extraction_cache_meta: Dict[str, float] = {}
_EXTRACTION_CACHE_TTL_SECONDS = 300.0
_EXTRACTION_CACHE_MAX_SIZE = 200

INFERABLE_FIELDS = [
    "category",
    "severity",
    "location_type",
    "category_other_text",
    "location_detail",
]

FIRST_PASS_FACT_FIELDS = [
    "noticed_time",
    "response_taken",
    "response_details",
    "affected_asset",
    "error_symptom",
    "incident_active",
    "impact_scope",
    "work_continuity",
    # Cyber-specific fields will be added conditionally in extract_fields()
]

CYBER_FIRST_PASS_FACT_FIELDS = [
    "data_involved_flag",
    "data_involved",
    "data_other_text",
    "external_party_involved",
    "external_party_details",
    "already_reported_to_it",
    "reported_to_details",
]

INFERRED_CLASSIFICATION_FIELDS = {"issue_type", "category", "severity"}

DETAIL_FIELDS = {
    "response_details",
    "affected_asset",
    "error_symptom",
    "external_party_details",
    "reported_to_details",
    "impact_scope",
    "work_continuity",
    "category_other_text",
    "data_other_text",
    "location_detail",
}

LOW_SIGNAL_TEXT_VALUES = {
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
    "idk",
    "whatever",
    "q",
    "you are not a robot",
    "no detail",
    "no details",
    "do not have detail",
    "don't have detail",
    "do not have details",
    "don't have details",
    "cannot provide details",
    "unclear",
    "whatever works",
    "skip this",
    "nothing",
    "none available",
    "not available yet",
}


def extract_fields(
    user_message: str,
    collected_so_far: Dict[str, Any],
    missing_fields: List[str],
) -> Dict[str, Any]:
    """
    Extract fields from user message via LLM with context awareness.

    Fast paths (no LLM needed):
    - Detail fields: directly store the user's answer
    - Boolean replies: parse yes/no directly

    Semi-fast path (fast-fill + LLM):
    - Description field: store user message as description, AND call LLM to
      extract other fields (time, category, severity, etc.) from the same message.

    All other cases: single LLM call with full conversation context.

    Special handling for "not_sure" domain:
    - Extraction is more conservative (don't force category/severity inference)
    - Allow the infer_issue_type_from_collected() fallback to resolve domain naturally
    """
    req_start = time.time()
    expected_field = missing_fields[0] if missing_fields else ""
    pre_patch, terminal_fast_patch, detail_fast_matched = _run_fast_path_stage(
        user_message=user_message,
        collected_so_far=collected_so_far,
        missing_fields=missing_fields,
    )

    explicit_allowed_fields = _build_explicit_fact_allowed_fields(missing_fields)
    explicit_fact_patch = _derive_explicit_fact_patch(
        user_message,
        {**(collected_so_far or {})},
        expected_field=expected_field,
        allowed_fields=explicit_allowed_fields,
    )
    if terminal_fast_patch is not None:
        terminal_patch = {**pre_patch, **explicit_fact_patch, **terminal_fast_patch}
        terminal_patch = _apply_semantic_consistency_rules(
            terminal_patch,
            user_message,
            collected_so_far,
            expected_field=expected_field,
            allowed_fields=explicit_allowed_fields,
        )
        return _filter_inferred_fields_until_core_ready(terminal_patch, collected_so_far)

    if explicit_fact_patch:
        pre_patch = {**explicit_fact_patch, **pre_patch}

    # Detail fast-path now preserves explicit fact extraction. If no extra explicit
    # facts exist, skip the LLM call for speed.
    if detail_fast_matched:
        pre_patch = _apply_semantic_consistency_rules(
            pre_patch,
            user_message,
            collected_so_far,
            expected_field=expected_field,
            allowed_fields=explicit_allowed_fields,
        )
    if detail_fast_matched and not explicit_fact_patch:
        return pre_patch

    cache_key = hashlib.md5(
        f"{user_message}|{sorted(missing_fields)}|{json.dumps(collected_so_far, sort_keys=True, ensure_ascii=False)}".encode()
    ).hexdigest()

    _cleanup_extraction_cache()
    if cache_key in _extraction_cache and _cache_entry_valid(cache_key):
        # Merge cached LLM results with any pre-set description.
        return {**pre_patch, **_extraction_cache[cache_key]}

    prompt_start = time.time()
    first_pass_fact_fields = _build_first_pass_fact_fields(collected_so_far)
    prompt = build_extraction_prompt_template(
        user_message,
        collected_so_far,
        missing_fields,
        inferable_fields=INFERABLE_FIELDS,
        first_pass_fact_fields=first_pass_fact_fields,
    )
    prompt_end = time.time()

    try:
        patch, api_time, used_fallback = request_json_completion(
            messages=[
                {
                    "role": "system",
                    "content": 'Extract JSON: {"field": value}. No text before or after.',
                },
                {"role": "user", "content": prompt},
            ],
            model=EXTRACTION_MODEL,
            temperature=0.0,
            top_p=EXTRACTION_TOP_P if MODEL_PROVIDER == "openai" else 1.0,
            max_tokens=EXTRACTION_FAST_MAX_TOKENS
            if EXTRACTION_SPEED_MODE == "fast"
            else EXTRACTION_MAX_TOKENS,
            timeout=15.0 if MODEL_PROVIDER == "local" else 5.0,
            use_gemini_fallback=True,
        )

        parse_start = time.time()
        parse_end = time.time()

        validate_start = time.time()
        patch = _run_post_parse_stage(
            patch=patch,
            user_message=user_message,
            collected_so_far=collected_so_far,
            expected_field=expected_field,
            allowed_fields=explicit_allowed_fields,
        )

        # Final safety net: if user gave a meaningful narrative, keep it as description.
        if "description" not in patch and "description" not in (collected_so_far or {}):
            if _looks_like_meaningful_description(user_message):
                patch["description"] = user_message.strip()
        validate_end = time.time()

        patch = _filter_inferred_fields_until_core_ready(patch, collected_so_far)

        # Merge pre-set fields (e.g. description from fast path) with LLM results.
        # pre_patch takes lower priority so LLM can override if it has better values.
        patch = {**pre_patch, **patch}

        if patch:
            _put_cache_entry(cache_key, patch)

        req_end = time.time()
        total_duration = req_end - req_start

        details = (
            f"model={MODEL_PROVIDER} missing_fields={len(missing_fields)} cache=no"
        )
        _ai_tracker.log_call("extract_fields", total_duration, details)

        _ai_tracker.log_subcomponent("Prompt build", prompt_end - prompt_start)
        _ai_tracker.log_subcomponent("LLM API call", api_time)
        _ai_tracker.log_subcomponent("JSON parse", parse_end - parse_start)
        _ai_tracker.log_subcomponent("Field validation", validate_end - validate_start)

        return patch

    except Exception as e:
        _ai_tracker.log_call(
            "extract_fields (failed)", time.time() - req_start, f"error={str(e)[:80]}"
        )

        if MODEL_PROVIDER == "gemini":
            try:
                fb_start = time.time()
                fb_client = get_openai_client()
                fb_response = fb_client.chat.completions.create(
                    model="gpt-4o-mini",
                    messages=[
                        {
                            "role": "system",
                            "content": 'Output valid JSON only. No text, no explanation, no markdown. Just {"field": value}.',
                        },
                        {"role": "user", "content": prompt},
                    ],
                    temperature=0.0,
                    top_p=1.0,
                    max_tokens=EXTRACTION_FAST_MAX_TOKENS
                    if EXTRACTION_SPEED_MODE == "fast"
                    else EXTRACTION_MAX_TOKENS,
                    timeout=15.0 if MODEL_PROVIDER == "local" else 5.0,
                )

                fb_text = fb_response.choices[0].message.content or ""
                try:
                    fb_patch = json.loads(fb_text)
                except json.JSONDecodeError:
                    fb_patch = _extract_json_from_text(fb_text)

                fb_patch = _run_post_parse_stage(
                    patch=fb_patch,
                    user_message=user_message,
                    collected_so_far=collected_so_far,
                    expected_field=expected_field,
                    allowed_fields=explicit_allowed_fields,
                )

                if "description" not in fb_patch and "description" not in (
                    collected_so_far or {}
                ):
                    if _looks_like_meaningful_description(user_message):
                        fb_patch["description"] = user_message.strip()
                fb_patch = _filter_inferred_fields_until_core_ready(
                    fb_patch, collected_so_far
                )
                fb_patch = {**pre_patch, **fb_patch}

                if fb_patch:
                    _put_cache_entry(cache_key, fb_patch)

                fb_time = time.time() - fb_start
                _ai_tracker.log_call(
                    "extract_fields fallback", fb_time, f"fields={len(fb_patch)}"
                )
                return fb_patch
            except Exception as fb_e:
                _ai_tracker.log_call(
                    "extract_fields fallback (failed)",
                    time.time() - fb_start,
                    f"error={str(fb_e)[:80]}",
                )

        # All LLM paths failed — return at least whatever fast-path found
        return pre_patch if pre_patch else {}


def _run_fast_path_stage(
    *,
    user_message: str,
    collected_so_far: Dict[str, Any],
    missing_fields: List[str],
) -> Tuple[Dict[str, Any], Optional[Dict[str, Any]], bool]:
    """Run deterministic fast-path extraction before LLM usage.

    Returns:
        (pre_patch, terminal_patch, detail_fast_matched)
    """
    pre_patch: Dict[str, Any] = {}
    detail_fast_matched = False

    # Detail fast path: preserve the answer, but do not terminate immediately.
    # This allows explicit_fact_patch to still capture extra facts from the same turn.
    if missing_fields and missing_fields[0] in DETAIL_FIELDS:
        text = (user_message or "").strip()
        if _looks_like_meaningful_detail_answer(text):
            pre_patch[missing_fields[0]] = text
            detail_fast_matched = True

    # Fast path: boolean yes/no.
    boolean_patch = _match_boolean_fast_path(user_message, collected_so_far, missing_fields)
    if boolean_patch:
        return pre_patch, boolean_patch, detail_fast_matched

    # Fast path: enum.
    enum_patch = _match_enum_fast_path(user_message, missing_fields)
    if enum_patch:
        return pre_patch, enum_patch, detail_fast_matched

    # Fast path: array/multi-select.
    array_patch = _match_array_fast_path(user_message, missing_fields)
    if array_patch:
        return pre_patch, array_patch, detail_fast_matched

    # Semi-fast path: description preservation/append.
    if "description" in missing_fields:
        text = (user_message or "").strip()
        if _looks_like_meaningful_description(text):
            pre_patch["description"] = text
    elif _looks_like_meaningful_description(user_message):
        existing_description = str((collected_so_far or {}).get("description", "")).strip()
        candidate = (user_message or "").strip()
        if existing_description and candidate.lower() not in existing_description.lower():
            combined = f"{existing_description}\n{candidate}".strip()
            if len(combined) <= FORM_SCHEMA["description"].get("max_length", 5000):
                pre_patch["description"] = combined

    return pre_patch, None, detail_fast_matched


def _run_post_parse_stage(
    *,
    patch: Dict[str, Any],
    user_message: str,
    collected_so_far: Dict[str, Any],
    expected_field: str,
    allowed_fields: Optional[set[str]],
) -> Dict[str, Any]:
    """Apply validation and semantic consistency after JSON parsing."""
    patch = _validate_and_clean_patch(patch, user_message, collected_so_far)
    patch = _apply_semantic_consistency_rules(
        patch,
        user_message,
        collected_so_far,
        expected_field=expected_field,
        allowed_fields=allowed_fields,
    )
    return patch


def _build_explicit_fact_allowed_fields(
    missing_fields: List[str],
) -> Optional[set[str]]:
    """Build the explicit-extraction allow list to reduce cross-field interference."""
    # In first-turn narrative mode, keep explicit extraction permissive so we can
    # capture multiple core facts from one message (time/boolean/action/etc.).
    if "description" in missing_fields:
        return None

    allowed = set(missing_fields)
    allowed.update({"issue_type", "description", "noticed_time"})
    return allowed


def _build_first_pass_fact_fields(collected_so_far: Dict[str, Any]) -> List[str]:
    """Return factual fields the model may opportunistically extract this turn."""
    fields = list(FIRST_PASS_FACT_FIELDS)
    issue_type = str((collected_so_far or {}).get("issue_type", "")).strip().lower()
    if issue_type != "it_support":
        fields.extend(CYBER_FIRST_PASS_FACT_FIELDS)
    return list(dict.fromkeys(fields))


def _match_boolean_fast_path(
    user_message: str,
    collected_so_far: Dict[str, Any],
    missing_fields: List[str],
) -> Optional[Dict[str, Any]]:
    """Match short boolean replies without LLM."""
    boolean_detail_pairs = {
        "response_taken": "response_details",
    }
    is_cyber = str(collected_so_far.get("issue_type", "cyber")).lower() != "it_support"
    if is_cyber:
        boolean_detail_pairs.update(
            {
                "external_party_involved": "external_party_details",
                "already_reported_to_it": "reported_to_details",
            }
        )

    if not missing_fields:
        return None

    next_field = missing_fields[0]
    if FORM_SCHEMA.get(next_field, {}).get("type") != "boolean":
        return None

    parsed_bool = _parse_short_boolean_reply(user_message)
    if parsed_bool is None:
        return None

    if parsed_bool is True and next_field in boolean_detail_pairs:
        detail_field = boolean_detail_pairs[next_field]
        detail_text = _extract_detail_after_yes(user_message)
        if detail_text:
            return {next_field: True, detail_field: detail_text}
    return {next_field: parsed_bool}


def _match_enum_fast_path(
    user_message: str,
    missing_fields: List[str],
) -> Optional[Dict[str, Any]]:
    """Match short enum replies without LLM."""
    if not missing_fields:
        return None
    next_field = missing_fields[0]
    schema = FORM_SCHEMA.get(next_field, {})
    if schema.get("type") != "enum":
        return None
    enum_values = schema.get("enum", [])
    matched = _fuzzy_match_enum(user_message, enum_values)
    if matched is None:
        return None
    return {next_field: matched}


def _match_array_fast_path(
    user_message: str,
    missing_fields: List[str],
) -> Optional[Dict[str, Any]]:
    """Match short multi-select replies without LLM."""
    if not missing_fields:
        return None
    next_field = missing_fields[0]
    schema = FORM_SCHEMA.get(next_field, {})
    if schema.get("type") != "array":
        return None
    valid_items = schema.get("items", [])
    matched_items = _parse_multi_select_reply(user_message, valid_items)
    if not matched_items:
        return None
    return {next_field: matched_items}


def _extract_json_from_text(text: str) -> Dict[str, Any]:
    """Extract a JSON object from text as a fallback."""
    try:
        start_idx = text.find("{")
        end_idx = text.rfind("}")
        if start_idx >= 0 and end_idx > start_idx:
            json_str = text[start_idx : end_idx + 1]
            return json.loads(json_str)
    except Exception:
        pass

    return {}


def _cleanup_extraction_cache() -> None:
    now = time.time()
    expired = [
        k
        for k, ts in _extraction_cache_meta.items()
        if now - ts > _EXTRACTION_CACHE_TTL_SECONDS
    ]
    for key in expired:
        _extraction_cache_meta.pop(key, None)
        _extraction_cache.pop(key, None)


def _cache_entry_valid(key: str) -> bool:
    ts = _extraction_cache_meta.get(key)
    if ts is None:
        return False
    if time.time() - ts > _EXTRACTION_CACHE_TTL_SECONDS:
        _extraction_cache_meta.pop(key, None)
        _extraction_cache.pop(key, None)
        return False
    return True


def _put_cache_entry(key: str, value: Dict[str, Any]) -> None:
    _cleanup_extraction_cache()
    if len(_extraction_cache) >= _EXTRACTION_CACHE_MAX_SIZE:
        oldest_key = min(
            _extraction_cache_meta,
            key=lambda k: _extraction_cache_meta.get(k, float("inf")),
            default=None,
        )
        if oldest_key is not None:
            _extraction_cache.pop(oldest_key, None)
            _extraction_cache_meta.pop(oldest_key, None)
    _extraction_cache[key] = value
    _extraction_cache_meta[key] = time.time()


def _fuzzy_match_enum(user_message: str, enum_values: List[str]) -> Optional[str]:
    """Fuzzy-match a short user reply to an enum value.

    Handles exact matches, substrings, and common typos (edit-distance ≤ 2).
    Only used when the user's message is short (≤ 5 words) to avoid false positives.
    """
    text = (user_message or "").strip().lower().rstrip(".,!?:;，。！？")
    words = text.split()
    if len(words) > 5:
        return None  # Only apply fast path for short replies

    # Exact or substring match
    for val in enum_values:
        if text == val or text == val.replace("_", " "):
            return val
    for val in enum_values:
        clean_val = val.replace("_", " ")
        if clean_val in text or text in clean_val:
            return val

    # Edit-distance ≤ 2 (handles common typos like "eamil" → "email")
    def _edit_distance(a: str, b: str) -> int:
        if abs(len(a) - len(b)) > 2:
            return 99
        dp = list(range(len(b) + 1))
        for i, ca in enumerate(a):
            ndp = [i + 1]
            for j, cb in enumerate(b):
                ndp.append(
                    min(dp[j] + (0 if ca == cb else 1), ndp[j] + 1, dp[j + 1] + 1)
                )
            dp = ndp
        return dp[len(b)]

    for val in enum_values:
        clean_val = val.replace("_", " ")
        # Check each word in text against the enum value
        for word in words:
            if len(word) >= 3 and _edit_distance(word, clean_val) <= 2:
                return val

    return None


def _parse_short_boolean_reply(user_message: str) -> Optional[bool]:
    """Parse yes/no style replies for boolean prompts.

    Handles both exact short replies ("yes", "no") and replies where the user
    prefixes their detail with a yes/no word ("Yes, reset password").
    """
    text = (user_message or "").strip().lower().rstrip(".!?，。！？")
    if not text:
        return None

    true_values = {
        "true",
        "yes",
        "y",
        "1",
        "ok",
        "sure",
        "affirmative",
        "yeah",
        "yep",
        "i did",
        "i have",
    }
    false_values = {
        "false",
        "no",
        "n",
        "0",
        "nope",
        "nah",
        "negative",
        "not yet",
        "not really",
        "none",
    }

    if text in true_values:
        return True
    if text in false_values:
        return False

    # Detect "yes, <detail>" / "no, <detail>" patterns
    if re.match(r"^(yes|yeah|yep|yup|sure|ok|affirmative|i did|i have)\b", text):
        return True
    if re.match(r"^(no|nope|nah|negative|not yet|not really|none)\b", text):
        return False

    return None


def _extract_detail_after_yes(user_message: str) -> Optional[str]:
    """Extract the detail text that follows a yes/true prefix in a combined boolean+detail reply.

    E.g. "Yes. Changed password, disconnected laptop" → "Changed password, disconnected laptop"
    Returns None if there is no meaningful detail after the yes prefix.
    """
    text = (user_message or "").strip()
    # Strip leading yes/true prefix (case-insensitive)
    stripped = re.sub(r"(?i)^(yes|true)[.,!?;:\s]+", "", text).strip()
    if stripped and stripped.lower() not in {"", "yes", "true", "no", "false"}:
        return stripped
    return None


def _parse_multi_select_reply(user_message: str, valid_items: List[str]) -> List[str]:
    """Parse a comma-separated multi-select reply into a list of valid enum items.

    Each token is fuzzy-matched against valid_items. Returns the matched subset.
    Only used as a fast path when missing_fields[0] is an array field.
    """
    text = (user_message or "").strip()
    if not text:
        return []

    tokens = [t.strip().lower().rstrip(".,!?;:") for t in text.split(",")]
    tokens = [t for t in tokens if t]

    if not tokens:
        return []

    matched: List[str] = []
    seen: set = set()
    for token in tokens:
        result = _fuzzy_match_enum(token, valid_items)
        if result and result not in seen:
            matched.append(result)
            seen.add(result)

    return matched


def _validate_and_clean_patch(
    patch: Dict[str, Any],
    user_message: str,
    collected_so_far: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Validate and clean extracted patch data.
    """
    cleaned = {}

    for field_name, value in patch.items():
        if field_name not in FORM_SCHEMA or value is None:
            continue

        schema = FORM_SCHEMA[field_name]
        field_type = schema.get("type", "string")

        try:
            if field_type == "enum":
                enum_values = schema.get("enum", [])
                if isinstance(value, list):
                    value = next(
                        (
                            v
                            for v in (str(x).lower().strip() for x in value)
                            if v in enum_values
                        ),
                        None,
                    )
                else:
                    value = str(value).lower().strip()
                    value = value if value in enum_values else None

            elif field_type == "string":
                value = str(value).strip()
                min_len = schema.get("min_length", 0)
                max_len = schema.get("max_length", 10000)
                if not (min_len <= len(value) <= max_len):
                    continue
                if _is_low_information_text(field_name, value):
                    continue

            elif field_type == "boolean":
                if isinstance(value, bool):
                    pass
                elif isinstance(value, str):
                    value_lower = value.lower().strip()
                    true_values = {"true", "yes", "y", "1"}
                    false_values = {"false", "no", "n", "0"}
                    if value_lower in true_values:
                        value = True
                    elif value_lower in false_values:
                        value = False
                    else:
                        continue
                else:
                    continue

            elif field_type == "array":
                if not isinstance(value, list):
                    continue
                allowed_items = schema.get("items", [])
                value = [
                    str(x).lower().strip()
                    for x in value
                    if str(x).lower().strip() in allowed_items
                ]

            if not _field_is_grounded_in_user_message(
                field_name,
                value,
                user_message,
                collected_so_far=collected_so_far,
            ):
                continue

            if value is not None and value != "":
                cleaned[field_name] = value

        except (ValueError, TypeError):
            continue

    return cleaned


def _is_low_information_text(field_name: str, text: str) -> bool:
    """Reject short or content-free strings for detail-oriented fields."""
    normalized = _normalize_text(text)
    if not normalized:
        return True

    if normalized in LOW_SIGNAL_TEXT_VALUES:
        return True

    if field_name in DETAIL_FIELDS or field_name in {
        "impact_scope",
        "work_continuity",
        "location_detail",
    }:
        if len(normalized) < 5:
            return True
        if not re.search(r"[A-Za-z\u4e00-\u9fff]", text):
            return True

    return False


def _apply_semantic_consistency_rules(
    patch: Dict[str, Any],
    user_message: str,
    collected_so_far: Optional[Dict[str, Any]] = None,
    *,
    expected_field: str = "",
    allowed_fields: Optional[set[str]] = None,
) -> Dict[str, Any]:
    """
    Reconcile extracted values with explicit signals using clear priority merging.
    
    MERGE PRIORITY (HIGHEST to LOWEST):
    1. Explicit facts (from deterministic extractors)
    2. Domain resolution (explicit issue_type handling)
    3. Explicit category/severity (from regex or LLM)
    4. Shared recommendations (system inference)
    5. Conservative safety net (severity downgrade if no impact signals)
    
    Expected improvement: Stable severity classification, no over-escalation without multi-user signals.
    """
    merged = {**(collected_so_far or {}), **(patch or {})}
    description = str(merged.get("description", ""))
    observed_text = f"{description} {user_message}".lower()

    # ========================================================================
    # STEP 1: Explicit Facts (Highest Priority)
    # Apply deterministic extraction results first - these override everything
    # ========================================================================
    explicit_fact_patch = _derive_explicit_fact_patch(
        user_message,
        merged,
        expected_field=expected_field,
        allowed_fields=allowed_fields,
    )
    # Only apply facts that aren't already in patch (prefer existing LLM results for same field)
    patch.update({k: v for k, v in explicit_fact_patch.items() if k not in patch})

    # ========================================================================
    # STEP 2: Domain Resolution (Issue Type)
    # Handle issue_type transitions from "not_sure" to concrete domains
    # ========================================================================
    current_issue_type = (
        str((collected_so_far or {}).get("issue_type", "")).strip().lower()
    )
    explicit_issue_type = str(patch.get("issue_type", "")).strip().lower()

    if (
        current_issue_type == "it_support"
        and explicit_issue_type not in {"cyber", "it_support"}
        and classification_has_strong_data_disclosure_evidence(observed_text)
    ):
        patch["issue_type"] = "cyber"
        patch.setdefault("category", "data_breach")

    if current_issue_type == "not_sure" and explicit_issue_type not in {
        "cyber",
        "it_support",
    }:
        # Only infer domain if we have strong signals in the text
        inferred_issue_type = classification_infer_issue_type(
            {
                **merged,
                **patch,
                "description": description or user_message,
            }
        )
        if inferred_issue_type in {"cyber", "it_support"}:
            patch["issue_type"] = inferred_issue_type

    # ========================================================================
    # STEP 3: Explicit Category & Severity (From Regex Patterns)
    # If user explicitly stated these, trust those signals
    # ========================================================================
    explicit_severity = classification_extract_explicit_severity(observed_text)
    if explicit_severity:
        patch["severity"] = explicit_severity

    resolved_issue_type = (
        str(patch.get("issue_type") or merged.get("issue_type") or "").strip().lower()
    )

    # Enforce domain boundaries (e.g., cyber fields cannot mix with IT fields)
    patch = classification_enforce_issue_type_boundary(patch, resolved_issue_type)

    explicit_category = classification_extract_explicit_category(observed_text, resolved_issue_type)
    if explicit_category:
        patch["category"] = explicit_category

    # ========================================================================
    # STEP 4: Shared Recommendations (System Inference)
    # Use consistent business logic for fields not explicitly set
    # Shared recommendation path used by both chat extraction and classic-form suggestions.
    # ========================================================================
    shared_recommendations = classification_derive_recommendations(
        {
            **merged,
            **patch,
            "description": description,
        }
    )

    # Only use shared recommendations if we don't have explicit user signals
    if not explicit_category:
        inferred_cat = shared_recommendations.get("category")
        if inferred_cat:
            patch["category"] = inferred_cat

    # Note: Severity from shared_recommendations will be applied here,
    # but it will be validated in STEP 5 for conservative downgrade
    if not explicit_severity:
        inferred_sev = shared_recommendations.get("severity")
        if inferred_sev:
            patch["severity"] = inferred_sev

    # ========================================================================
    # Extract Data Types
    # ========================================================================
    explicit_data_types = classification_extract_explicit_data_types(
        observed_text, resolved_issue_type
    )
    if explicit_data_types:
        patch["data_involved_flag"] = True
        patch["data_involved"] = explicit_data_types

    # ========================================================================
    # Category-Specific Consistency Checks
    # ========================================================================
    category = patch.get("category")
    if category == "credential_compromise":
        # Credential compromise should not be confused with hardware issues
        credential_signal_patterns = [
            r"credential(s)?\s+(stolen|leaked|compromised|exposed)",
            r"password\s+(stolen|leaked|reset by attacker|compromised)",
            r"account\s+(hacked|compromised|taken over|locked by attacker)",
            r"unauthorized\s+login",
            r"phishing",
            r"login\s+attempt(s)?",
        ]
        hardware_signals = [
            "monitor",
            "screen",
            "display",
            "keyboard",
            "mouse",
            "device broken",
            "hardware",
            "physical damage",
            "broken",
        ]

        has_credential_signal = any(
            re.search(p, observed_text) for p in credential_signal_patterns
        )
        has_hardware_signal = any(s in observed_text for s in hardware_signals)
        location_type = (
            patch.get("location_type") or merged.get("location_type") or ""
        ).lower()

        # If hardware signals dominate and NO credential signals, correct the category
        if (
            has_hardware_signal
            and not has_credential_signal
            and location_type in {"physical", "device", ""}
        ):
            patch["category"] = "infrastructure_issue"

    # ========================================================================
    # STEP 5: Conservative Severity Safety Net (FINAL)
    # Downgrade high/critical severity if no concrete multi-user impact signals.
    # Never override explicit user-provided severity.
    # ========================================================================
    severity = patch.get("severity")
    if severity in {"high", "critical"} and not explicit_severity:
        impact_scope = str(merged.get("impact_scope", "")).lower()
        num_users_affected = str(merged.get("num_users_affected", "")).lower()
        
        # High/critical signals require evidence of scope or multi-user impact
        high_impact_signals = [
            "multiple",
            "department",
            "company",
            "service down",
            "cannot work",
            "breach",
            "credentials",
            "customer",
        ]
        
        has_scope_signal = any(s in impact_scope for s in high_impact_signals)
        has_multi_user_signal = any(
            signal in num_users_affected 
            for signal in ["multiple", "several", "team", "department", "company"]
        )
        
        # Credential compromise: high/critical only if credentials are actually exposed
        if category == "credential_compromise":
            has_credential_exposure = any(
                pattern in observed_text 
                for pattern in ["credential", "password", "token", "key"]
            )
            if severity == "critical" and not (has_credential_exposure and (has_scope_signal or has_multi_user_signal)):
                patch["severity"] = "high"
            elif severity == "critical" and not has_multi_user_signal:
                patch["severity"] = "high"
        else:
            # For other categories: downgrade if no scope/multi-user evidence
            if not (has_scope_signal or has_multi_user_signal):
                patch["severity"] = "medium"

    # Final domain boundary enforcement
    patch = classification_enforce_issue_type_boundary(patch, resolved_issue_type)
    return patch


def _derive_explicit_fact_patch(
    user_message: str,
    merged: Dict[str, Any],
    *,
    expected_field: str = "",
    allowed_fields: Optional[set[str]] = None,
) -> Dict[str, Any]:
    """Extract deterministic facts from plain text before relying on broader inference."""
    text = (user_message or "").strip()
    lowered = text.lower()
    result: Dict[str, Any] = {}

    noticed_time = _extract_explicit_noticed_time(text)
    if noticed_time and _can_write_explicit_field("noticed_time", expected_field, allowed_fields):
        result["noticed_time"] = noticed_time

    if any(
        k in lowered
        for k in ["still active", "still ongoing", "ongoing", "not resolved"]
    ):
        if _can_write_explicit_field("incident_active", expected_field, allowed_fields):
            result["incident_active"] = True
    elif any(k in lowered for k in ["resolved", "fixed", "no longer", "contained"]):
        if _can_write_explicit_field("incident_active", expected_field, allowed_fields):
            result["incident_active"] = False

    response_details = _extract_response_details_from_text(text)
    if response_details and _can_write_explicit_field("response_details", expected_field, allowed_fields):
        result["response_taken"] = True
        result["response_details"] = response_details
    else:
        response_taken = _extract_response_taken_flag(text)
        if response_taken is not None and _can_write_explicit_field("response_taken", expected_field, allowed_fields):
            result["response_taken"] = response_taken

    if re.search(
        r"\b(cannot access|can't access|cannot work|unable to access|blocked)\b",
        lowered,
    ):
        if not result.get("work_continuity"):
            if _can_write_explicit_field("work_continuity", expected_field, allowed_fields):
                result["work_continuity"] = (
                    _extract_sentence_by_keywords(
                        text,
                        [
                            "cannot access",
                            "can't access",
                            "cannot work",
                            "unable to access",
                            "blocked",
                        ],
                    )
                    or "Work is impacted because access to key systems is blocked."
                )

    if re.search(
        r"\b(affecting my work|impacting my work|affecting work|impacting work)\b",
        lowered,
    ):
        if _can_write_explicit_field("impact_scope", expected_field, allowed_fields):
            result["impact_scope"] = (
                _extract_sentence_by_keywords(
                    text,
                    [
                        "affecting my work",
                        "impacting my work",
                        "affecting work",
                        "impacting work",
                    ],
                )
                or "Incident is impacting the reporter's daily work."
            )

    external_party = _extract_external_party_involved_flag(text)
    if external_party is not None and _can_write_explicit_field("external_party_involved", expected_field, allowed_fields):
        result["external_party_involved"] = external_party
        if external_party:
            ext_detail = _extract_sentence_by_keywords(
                text,
                [
                    "unknown foreign ip",
                    "unknown ip",
                    "external party",
                    "third-party",
                    "third party",
                    "attacker",
                    "vendor",
                    "supplier",
                    "customer",
                    "client",
                ],
            )
            if ext_detail and _can_write_explicit_field("external_party_details", expected_field, allowed_fields):
                result["external_party_details"] = ext_detail

    already_reported = _extract_already_reported_to_it(text)
    if already_reported is not None and _can_write_explicit_field("already_reported_to_it", expected_field, allowed_fields):
        result["already_reported_to_it"] = already_reported
        if already_reported:
            reported_detail = _extract_reported_to_details(text)
            if reported_detail and _can_write_explicit_field("reported_to_details", expected_field, allowed_fields):
                result["reported_to_details"] = reported_detail

    data_involved = _extract_data_involved_flag(text)
    if data_involved is not None and _can_write_explicit_field("data_involved_flag", expected_field, allowed_fields):
        result["data_involved_flag"] = data_involved
        if data_involved:
            explicit_data_types = classification_extract_explicit_data_types(lowered)
            if explicit_data_types and _can_write_explicit_field("data_involved", expected_field, allowed_fields):
                result["data_involved"] = explicit_data_types

    affected_asset = _extract_affected_asset_from_text(text)
    if affected_asset and _can_write_explicit_field("affected_asset", expected_field, allowed_fields):
        result["affected_asset"] = affected_asset

    error_symptom = _extract_error_symptom_from_text(text)
    if error_symptom and _can_write_explicit_field("error_symptom", expected_field, allowed_fields):
        result["error_symptom"] = error_symptom

    if re.search(
        r"\b(contact(ed)? me by email|prefer to be contacted by email|preferred contact.*email)\b",
        lowered,
    ):
        if _can_write_explicit_field("preferred_contact_method", expected_field, allowed_fields):
            result["preferred_contact_method"] = "email"
    elif re.search(
        r"\b(contact(ed)? me by phone|prefer to be contacted by phone|preferred contact.*phone)\b",
        lowered,
    ):
        if _can_write_explicit_field("preferred_contact_method", expected_field, allowed_fields):
            result["preferred_contact_method"] = "phone"
    elif re.search(
        r"\b(contact(ed)? me by teams|prefer to be contacted by teams|preferred contact.*teams)\b",
        lowered,
    ):
        if _can_write_explicit_field("preferred_contact_method", expected_field, allowed_fields):
            result["preferred_contact_method"] = "teams"

    if re.search(
        r"\b(cloud|microsoft 365|office 365|azure|aws|gcp|onedrive|sharepoint)\b",
        lowered,
    ):
        if _can_write_explicit_field("location_type", expected_field, allowed_fields):
            result["location_type"] = "cloud"
        cloud_detail = _extract_sentence_by_keywords(
            text,
            [
                "microsoft 365",
                "office 365",
                "cloud",
                "azure",
                "aws",
                "gcp",
                "sharepoint",
                "onedrive",
            ],
        )
        if cloud_detail and _can_write_explicit_field("location_detail", expected_field, allowed_fields):
            result["location_detail"] = cloud_detail

    return result


def _can_write_explicit_field(
    field_name: str,
    expected_field: str,
    allowed_fields: Optional[set[str]],
) -> bool:
    """Gate explicit fact writes to reduce cross-field interference."""
    if not allowed_fields:
        return True
    if field_name in allowed_fields:
        return True
    # Keep conditional detail pair writes enabled when parent field is expected.
    if field_name == "response_details" and expected_field == "response_taken":
        return True
    if field_name == "external_party_details" and expected_field == "external_party_involved":
        return True
    if field_name == "reported_to_details" and expected_field == "already_reported_to_it":
        return True
    return False


def _resolve_relative_time(raw: str) -> str:
    """Convert relative date phrases to absolute YYYY-MM-DD HH:MM strings.

    Examples:
      "today at 2pm"        → "2025-03-27 14:00"
      "yesterday at 9:30am" → "2025-03-26 09:30"
      "this morning"        → "2025-03-27 (this morning)"
      "3:45 PM"             → "3:45 PM"  (no relative day — returned unchanged)
    """
    lowered = raw.lower().strip()
    now = datetime.now()

    # Determine relative date portion
    if "yesterday" in lowered:
        base_date = (now - timedelta(days=1)).strftime("%Y-%m-%d")
    elif any(
        k in lowered
        for k in ("today", "tonight", "this morning", "this afternoon", "this evening")
    ):
        base_date = now.strftime("%Y-%m-%d")
    else:
        n_days_m = re.search(r"\b(\d+)\s+days?\s+ago\b", lowered)
        a_days_m = re.search(r"\ba\s+(couple|few)\s+days?\s+ago\b", lowered)
        if n_days_m:
            base_date = (now - timedelta(days=int(n_days_m.group(1)))).strftime(
                "%Y-%m-%d"
            )
        elif a_days_m:
            n = 2 if a_days_m.group(1) == "couple" else 3
            base_date = (now - timedelta(days=n)).strftime("%Y-%m-%d")
        else:
            # Not a relative date — leave unchanged
            return raw

    # Parse time portion (HH:MM am/pm  or  H am/pm)
    time_match = re.search(
        r"\b(\d{1,2}):(\d{2})\s*(am|pm)?\b|\b(\d{1,2})\s*(am|pm)\b",
        lowered,
    )
    if time_match:
        g = time_match.groups()
        if g[0] is not None:  # HH:MM [am/pm] format
            hour, minute, meridiem = int(g[0]), int(g[1]), g[2]
        else:  # H am/pm format
            hour, minute, meridiem = int(g[3]), 0, g[4]

        if meridiem == "pm" and hour < 12:
            hour += 12
        elif meridiem == "am" and hour == 12:
            hour = 0
        return f"{base_date} {hour:02d}:{minute:02d}"

    # Date is known but no clock time given — keep day + original phrase
    return f"{base_date} ({raw})"


def _extract_explicit_noticed_time(text: str) -> Optional[str]:
    """Extract an explicit time expression if one appears in the latest reply."""
    lowered = text.lower()
    patterns = [
        r"\b\d+\s+days?\s+ago\b(?:\s+at\s+(?:around\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b)?",
        r"\ba\s+(?:couple|few)\s+days?\s+ago\b(?:\s+at\s+(?:around\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b)?",
        r"\b(today|yesterday|tonight|this morning|this afternoon|this evening)\s+(at\s+)?(around\s+)?\d{1,2}(:\d{2})?\s?(am|pm)?\b",
        r"\b(today|yesterday|tonight|this morning|this afternoon|this evening|last night|earlier today)\b",
        r"\b\d{1,2}:\d{2}\s?(am|pm)\b",
        r"\b\d{1,2}\s?(am|pm)\b",
    ]
    for p in patterns:
        m = re.search(p, lowered)
        if m:
            raw = text[m.start() : m.end()].strip()
            return _resolve_relative_time(raw)
    return None


def _extract_response_details_from_text(text: str) -> Optional[str]:
    """Capture a sentence that clearly describes reporter actions already taken."""
    action_patterns = [
        r"\breset my password\b",
        r"\breset our password(s)?\b",
        r"\bchecked (?:the )?(?:sent items|sent folder|logs|audit logs|login activity)\b",
        r"\bconfirmed (?:that )?(?:the )?(?:wrong|incorrect) (?:attachment|invoice|file)\b",
        r"\b(supervisor|manager|team lead) (?:is|was|has been) aware\b",
        r"\b(informed|notified|told) (?:my|our|the)?\s*(?:supervisor|manager|team lead)\b",
        r"\blogged out from other devices\b",
        r"\bchecked recent login activity\b",
        r"\bchanged my password\b",
        r"\bchanged our password(s)?\b",
        r"\bdisconnected\b",
        r"\bclicked (?:the )?(?:link|url)\b",
        r"\bclosed (?:the )?(?:page|tab|window)\b",
        r"\bclosed it immediately\b",
        r"\bdeleted (?:the )?email\b",
        r"\breported (?:it|this) to (?:it|security|service desk|help desk|manager)\b",
        r"\breproduced\b",
        r"\bwe reproduced\b",
        r"\bwe (?:disabled|blocked|restarted|rolled back|cleared cache|reset|revoked|removed|isolated)\b",
        r"\bi (?:disabled|blocked|restarted|rolled back|cleared cache|reset|revoked|removed|isolated)\b",
        r"\bi restart(?:ed)?\b",
        r"\bwe restart(?:ed)?\b",
    ]
    sentence = _extract_sentence_by_regex(text, action_patterns)
    if sentence:
        return sentence
    return None


def _extract_response_taken_flag(text: str) -> Optional[bool]:
    """Detect explicit yes/no wording about whether the reporter took action."""
    lowered = text.lower()
    negative_patterns = [
        r"\b(i did not take any action|i didn't take any action|no action taken yet)\b",
        r"\b(i have not taken any action|i haven't taken any action)\b",
        r"\b(no action yet)\b",
    ]
    positive_patterns = [
        r"\b(checked (?:the )?(?:sent items|sent folder|logs|audit logs|login activity).*)",
        r"\b(confirmed (?:that )?(?:the )?(?:wrong|incorrect) (?:attachment|invoice|file).*)",
        r"\b((?:supervisor|manager|team lead) (?:is|was|has been) aware.*)",
        r"\b((?:informed|notified|told) (?:my|our|the)?\s*(?:supervisor|manager|team lead).*)",
        r"\b(i disconnected\b.*)",
        r"\b(i clicked\b.*(?:link|url).*)",
        r"\b(i closed\b.*(?:page|tab|window).*)",
        r"\b(clicked\b.*(?:link|url).*)",
        r"\b(closed\b.*(?:page|tab|window).*)",
        r"\b(deleted\b.*email.*)",
        r"\b(reported\b.*(?:it|security|service desk|help desk|manager).*)",
        r"\b(i changed\b.*password.*)",
        r"\b(i reset\b.*password.*)",
        r"\b(i restart(?:ed)?\b.*)",
        r"\b(i isolated\b.*)",
        r"\b(i blocked\b.*)",
        r"\b(i shut down\b.*)",
        r"\b(i turned off\b.*)",
        r"\b(i removed\b.*from (?:wifi|wi-fi|network).*)",
        r"\b(yes\b[.!]?\s+i\b)",
        r"\b(i already took action)\b",
    ]
    if any(re.search(pattern, lowered) for pattern in negative_patterns):
        return False
    if any(re.search(pattern, lowered) for pattern in positive_patterns):
        return True
    return None


def _extract_sentence_by_regex(text: str, patterns: List[str]) -> Optional[str]:
    """Return the first sentence that matches any of the supplied regex patterns."""
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        s = sentence.strip()
        if not s:
            continue
        if any(re.search(p, s, re.IGNORECASE) for p in patterns):
            return s
    return None


def _extract_sentence_by_keywords(text: str, keywords: List[str]) -> Optional[str]:
    """Return the first sentence that contains any of the supplied keywords."""
    lowered_keywords = [k.lower() for k in keywords]
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        s = sentence.strip()
        if not s:
            continue
        sl = s.lower()
        if any(k in sl for k in lowered_keywords):
            return s
    return None


def _extract_affected_asset_from_text(text: str) -> Optional[str]:
    """Extract the affected asset/system when it is stated explicitly."""
    patterns = [
        r"\baffected asset is (?P<value>[^.,;]+)",
        r"\bissue is with (?P<value>[^.,;]+)",
        r"\bfrom (?:our|the|my)?\s*(?P<value>support mailbox|shared mailbox|outlook mailbox|email mailbox)\b",
        r"\b(?P<value>support mailbox|shared mailbox|outlook mailbox|email mailbox)\b",
        r"\b(?P<value>my work laptop|my laptop|the payroll system|the hr portal|the shared office printer[^.]*|the printer[^.]*|the vpn|outlook|teams|email account|my email account)\b",
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            value = (match.groupdict().get("value") or match.group(0) or "").strip()
            value = re.sub(r"^(the issue is with|affected asset is)\s+", "", value, flags=re.IGNORECASE).strip()
            return value.rstrip(".")
    return None


def _extract_error_symptom_from_text(text: str) -> Optional[str]:
    """Extract an explicit error symptom or failed behavior."""
    patterns = [
        r"\b(?P<value>(?:wrong|incorrect) attachment (?:had been )?(?:included|sent|attached)[^.]*)",
        r"\b(?P<value>(?:another|other) (?:client|customer)'?s invoice [^.]*)",
        r"\b(?P<value>(?:customer|client) [^.]* received [^.]* (?:wrong|incorrect|another|other) [^.]*invoice[^.]*)",
        r"\bsymptom is that (?P<value>[^.]+)",
        r"\bit (?P<value>keeps freezing[^.]*|times out[^.]*|crashes[^.]*|is not responding[^.]*|won't connect[^.]*|cannot stay connected[^.]*)",
        r"\b(?P<value>Outlook crashes every time I open it[^.]*)",
        r"\b(?P<value>the application is not responding[^.]*)",
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            value = (match.groupdict().get("value") or match.group(0) or "").strip()
            value = re.sub(r"^symptom is that\s+", "", value, flags=re.IGNORECASE).strip()
            return value.rstrip(".")
    return None


def _filter_inferred_fields_until_core_ready(
    patch: Dict[str, Any],
    collected_so_far: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Smart filtering of inferred fields.

    Strategy (v2 - more permissive):
    1. Always allow category/severity/location_type to pass through
    2. Only block contact/preference fields until core facts exist
    3. Allow data/impact fields once we have description
    """
    merged = {**collected_so_far, **patch}

    # Always allow core factual fields. Classification fields are kept behind
    # maturity checks below so extraction can be assertive about facts without
    # over-committing to labels too early.
    allowed_fields = {
        "description",
        "noticed_time",
        "incident_active",
        "response_taken",
        "response_details",
        "affected_asset",
        "error_symptom",
        "data_involved_flag",
        "data_involved",
        "data_other_text",
        "external_party_involved",
        "external_party_details",
        "impact_scope",
        "work_continuity",
        "already_reported_to_it",
        "reported_to_details",
        "location_type",
        "category_other_text",
        "location_detail",
    }

    # Contact fields require core facts to be present
    contact_fields = {"preferred_contact_method", "phone_number"}

    result = {}
    for field, value in patch.items():
        if field in allowed_fields:
            result[field] = value
        elif field in INFERRED_CLASSIFICATION_FIELDS:
            if _can_keep_inferred_classification(field, merged):
                result[field] = value
        elif field in contact_fields:
            result[field] = value

    # Clean up conditional fields
    if merged.get("response_taken") is False:
        result.pop("response_details", None)

    if merged.get("already_reported_to_it") is False:
        result.pop("reported_to_details", None)

    if merged.get("data_involved_flag") is False:
        result.pop("data_involved", None)
        result.pop("data_other_text", None)

    return result


def _can_keep_inferred_classification(field_name: str, merged: Dict[str, Any]) -> bool:
    """Gate inferred classification fields separately from factual extraction."""
    if field_name == "issue_type":
        return _looks_like_meaningful_description(str(merged.get("description", "")))

    if field_name == "category":
        return _has_core_facts(merged) and "incident_active" in merged

    if field_name == "severity":
        if not (_has_core_facts(merged) and "incident_active" in merged):
            return False
        return any(
            bool(merged.get(field))
            for field in (
                "impact_scope",
                "work_continuity",
                "data_involved_flag",
                "external_party_involved",
                "response_taken",
            )
        )

    return False


def _field_is_grounded_in_user_message(
    field_name: str,
    value: Any,
    user_message: str,
    collected_so_far: Optional[Dict[str, Any]] = None,
) -> bool:
    """Ensure a field is supported by the latest message or prior collected narrative."""
    text = (user_message or "").strip()
    normalized = _normalize_text(text)
    collected = collected_so_far or {}

    if field_name == "description":
        return _looks_like_meaningful_description(text)

    if field_name == "noticed_time":
        return _looks_like_time_reference(text)

    if field_name == "incident_active":
        return _has_explicit_incident_active_signal(normalized)

    if field_name == "impact_scope":
        return _has_explicit_impact_scope_signal(normalized)

    if field_name == "work_continuity":
        return _has_explicit_work_continuity_signal(normalized)

    if field_name == "preferred_contact_method":
        return _mentions_contact_preference(text)

    if field_name == "phone_number":
        return _contains_phone_number(text)

    if field_name in {"category", "severity", "location_type"}:
        # Allow semantic inference from either the latest reply or prior
        # collected narrative context to prevent repeated follow-up.
        prior_description = str(collected.get("description", ""))
        return _looks_like_meaningful_description(
            text
        ) or _looks_like_meaningful_description(prior_description)

    return True


def _has_core_facts(collected: Dict[str, Any]) -> bool:
    """
    Require real core facts before allowing the flow to rely on inferred fields.
    """
    return _looks_like_meaningful_description(
        str(collected.get("description", ""))
    ) and bool(str(collected.get("noticed_time", "")).strip())


def _looks_like_meaningful_description(text: str) -> bool:
    """Decide whether free text looks like an incident description rather than a short answer."""
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


def _looks_like_meaningful_detail_answer(text: str) -> bool:
    """
    Check whether a short free-text reply looks like a usable detail answer.
    """
    stripped = (text or "").strip()
    if len(stripped) < 3:
        return False

    weak_values = {
        "yes",
        "no",
        "ok",
        "okay",
        "unknown",
        "none",
        "n/a",
        "na",
        "y",
        "n",
        "true",
        "false",
        "1",
        "0",
        "unclear",
        "whatever",
        "acknowledged",
        "received",
        "not available yet",
        "nothing",
    }

    normalized = _normalize_text(stripped)
    if normalized in weak_values:
        return False

    return True


def _looks_like_time_reference(text: str) -> bool:
    """Detect whether text contains an explicit or relative time reference."""
    stripped = (text or "").strip().lower()
    if not stripped:
        return False

    time_patterns = [
        r"\b\d{1,2}:\d{2}\b",
        r"\b\d{1,2}\s?(am|pm)\b",
        r"\b\d{4}-\d{1,2}-\d{1,2}\b",
        r"\b\d{1,2}/\d{1,2}/\d{2,4}\b",
        r"\b\d+\s?(hour|hours|minute|minutes|day|days|week|weeks)\s?ago\b",
    ]

    time_keywords = {
        "today",
        "yesterday",
        "tonight",
        "morning",
        "afternoon",
        "evening",
        "overnight",
        "just now",
        "earlier",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
        "this morning",
        "this afternoon",
        "this evening",
        "late night",
        "midnight",
    }

    if any(re.search(pattern, stripped) for pattern in time_patterns):
        return True

    return any(keyword in stripped for keyword in time_keywords)


def _extract_already_reported_to_it(text: str) -> Optional[bool]:
    """Detect whether the reporter explicitly says the incident was already escalated to IT."""
    lowered = text.lower()

    negative_patterns = [
        r"\b(have not yet contacted it|haven't contacted it|have not contacted it)\b",
        r"\b(have not yet reported(?: this)? to it|haven't reported(?: this)? to it|not reported(?: this)? to it)\b",
        r"\b(have not reported it to it yet|have not reported it to security yet|not reported it to it yet)\b",
        r"\b(haven't reported it to it yet|haven't reported it to security yet)\b",
        r"\b(have not reported it to it|haven't reported it to it)\b",
        r"\b(it has not yet been notified|it has not been notified|it was not notified|it hasn't been notified)\b",
        r"\b(security has not yet been notified|security has not been notified|security hasn't been notified)\b",
        r"\b(not yet notified (?:it|security)|notified (?:my|our|the)?\s*(?:supervisor|manager).*but not (?:it|security))\b",
        r"\b(no[t]?\s+contacted it yet)\b",
    ]
    positive_patterns = [
        r"\b(reported (?:this )?to it|contacted it|informed it|told it)\b",
        r"\b(reported (?:this )?to security|contacted security|reported .*service desk|contacted .*service desk)\b",
        r"\b(it has been notified|security has been notified|it was notified|security was notified)\b",
        r"\b(reported it to the service desk|reported it to service desk|reported this to the service desk)\b",
    ]

    if any(re.search(pattern, lowered) for pattern in negative_patterns):
        return False
    if any(re.search(pattern, lowered) for pattern in positive_patterns):
        return True

    return None


def _extract_reported_to_details(text: str) -> Optional[str]:
    """Extract the sentence that describes how the issue was reported to IT/security."""
    sentences = re.split(r"(?<=[.!?])\s+", text)
    for sentence in sentences:
        stripped = sentence.strip()
        match = re.search(
            r"\b(I reported .* to it|I contacted it|I reported .* to security|I contacted security|I reported .* service desk|I contacted .* service desk|reported it to the service desk.*|reported this to the service desk.*)\b",
            stripped,
            re.IGNORECASE,
        )
        if match:
            return match.group(0).strip()

    return None


def _extract_data_involved_flag(text: str) -> Optional[bool]:
    """Detect explicit mentions that sensitive or business data was involved."""
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
        r"\b(customer data|client data|personal data|financial data|credentials|sensitive data|employee data|company data)\b",
        lowered,
    ):
        return True
    if re.search(
        r"\b(?:wrong|incorrect) (?:attachment|invoice|file)\b.*\b(?:customer|client|personal|financial|sensitive)\b",
        lowered,
    ):
        return True
    if re.search(
        r"\b(?:customer|client).*\b(?:received|sent|got).*\b(?:another|other|wrong|incorrect)\b.*\binvoice\b",
        lowered,
    ):
        return True
    if re.search(r"\banother (?:client|customer)'?s invoice\b", lowered):
        return True

    return None


def _extract_external_party_involved_flag(text: str) -> Optional[bool]:
    """Detect whether the text explicitly mentions an outside actor or organization."""
    lowered = text.lower()
    if re.search(
        r"\b(no outside vendor|no outside party|no third[- ]party|no external party|just my laptop|just our internal system)\b",
        lowered,
    ):
        return False
    if re.search(
        r"\b(vendor|supplier|customer|client|external party|unknown sender|attacker|third[- ]party)\b",
        lowered,
    ):
        return True
    return None


def _has_explicit_incident_active_signal(normalized: str) -> bool:
    """Check for wording that directly states the incident is still ongoing."""
    keywords = [
        "still",
        "ongoing",
        "active",
        "not resolved",
        "still active",
        "still happening",
        "keeps happening",
        "continues",
    ]
    return any(keyword in normalized for keyword in keywords)


def _has_explicit_impact_scope_signal(normalized: str) -> bool:
    """Check for wording that directly indicates multi-user or broad impact scope."""
    keywords = [
        "multiple users",
        "several users",
        "department",
        "many devices",
        "multiple devices",
        "whole team",
        "entire team",
        "whole company",
        "company-wide",
        "multiple employees",
    ]
    return any(keyword in normalized for keyword in keywords)


def _has_explicit_work_continuity_signal(normalized: str) -> bool:
    """Check for wording that directly indicates work disruption."""
    keywords = [
        "cannot work",
        "can't work",
        "service down",
        "stopped working",
        "unable to access",
        "unable to work",
        "cannot access",
        "locked out",
        "work is blocked",
    ]
    return any(keyword in normalized for keyword in keywords)


def _mentions_contact_preference(text: str) -> bool:
    """Detect whether the user states a preferred follow-up contact method."""
    stripped = (text or "").strip().lower()
    contact_keywords = {
        "phone",
        "email",
        "teams",
        "in person",
        "call",
        "mobile",
        "contact me",
    }
    return any(keyword in stripped for keyword in contact_keywords)


def _contains_phone_number(text: str) -> bool:
    """Use a digit-count heuristic to detect likely phone numbers."""
    stripped = (text or "").strip()
    digits_only = re.sub(r"\D", "", stripped)
    return len(digits_only) >= 8


def _normalize_text(text: str) -> str:
    """Normalize whitespace and case for rule-based comparisons."""
    return re.sub(r"\s+", " ", (text or "").strip().lower())
