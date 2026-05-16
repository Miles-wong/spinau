"""Conversation state machine — the main entry point for processing a user turn.

Public API
----------
create_initial_state()              Build a fresh conversation dict.
process_user_message(msg, state)    Synchronous turn: returns (new_state, reply, extracted).
process_user_message_stream(msg, state)  Generator version that yields SSE-style event dicts.
is_complete(state)                  True when all required fields are collected.
"""
from typing import Any, Dict, List, Optional, Tuple

from .assistant import choose_next_field, generate_assistant_message, stream_assistant_message
from .classification import (
    classify_report_with_ai,
    infer_issue_type_from_collected,
    is_category_allowed_for_issue_type,
)
from .clarification import evaluate_reply_quality
from .extraction import extract_fields
from .flow_engine import (
    can_infer_category_and_severity,
    compute_missing_fields,
    has_valid_description,
)
from .inference_engine import infer_derived_fields
from .question_flow import get_next_question


def create_initial_state() -> Dict[str, Any]:
    """Create the initial conversation state."""
    initial_message = (
        "Hello! I'm your incident and IT support reporting assistant. "
        "Please describe what happened in as much detail as you can."
    )

    initial_collected = {"issue_type": "not_sure"}
    initial_missing = compute_missing_fields(initial_collected)
    return {
        "collected": initial_collected,
        "missing": initial_missing,
        "active_missing": list(initial_missing),
        "deferred_fields": [],
        "messages": [{"role": "assistant", "content": initial_message}],
        "turn": 0,
        "expected_field": initial_missing[0] if initial_missing else None,
        "failed_attempts": 0,
        "pending_classification": None,
        "pending_issue_type_arbitration": None,
        "needs_manual_issue_type": False,
        "classification_confirmed": False,
    }


def _active_missing(all_missing: List[str], deferred_fields: List[str]) -> List[str]:
    """Return the missing fields that are still eligible to be asked now."""
    active = [f for f in all_missing if f not in deferred_fields]
    if active:
        return active
    # If only deferred fields remain, revisit them now.
    return list(all_missing)


def _user_requests_skip_or_unknown(user_message: str) -> bool:
    """Detect short, explicit replies that indicate the user wants to skip a detail."""
    text = (user_message or "").strip().lower()
    if not text:
        return False

    # Only treat short explicit intents as skip/unknown requests.
    # This avoids false positives when long narratives contain words like "unknown".
    if len(text) > 40:
        return False

    normalized = " ".join(text.split())

    exact_phrases = {
        "skip",
        "unknown",
        "not sure",
        "dont know",
        "don't know",
        "do not know",
        "no detail",
        "no details",
        "do not have detail",
        "don't have detail",
        "do not have details",
        "don't have details",
        "cannot provide",
        "skip this",
        "no usable detail",
    }
    return normalized in exact_phrases


def _unknown_placeholder_for_field(field_name: str) -> str:
    """Return a neutral placeholder for fields the reporter explicitly leaves unknown."""
    if field_name == "response_details":
        return "No additional response details were provided by the reporter."
    if field_name == "external_party_details":
        return "Reporter confirmed external-party involvement, but did not provide additional details."
    if field_name == "reported_to_details":
        return "Reporter stated it was reported, but specific contact details were not provided."
    if field_name == "impact_scope":
        return "Impact scope details were not provided."
    if field_name == "work_continuity":
        return "Work continuity impact details were not provided."
    if field_name == "location_detail":
        return "Specific location details were not provided."
    return "Reporter did not provide additional details."


def _parse_confirmation_reply(user_message: str) -> Optional[bool]:
    """Parse short user confirmation replies into tri-state decisions.

    Returns:
    - True: user accepted AI classification
    - False: user rejected AI classification
    - None: ambiguous/no clear confirmation intent
    """
    text = (user_message or "").strip().lower()
    if not text:
        return None

    true_values = {
        "yes", "y", "yeah", "yep", "correct", "accept", "accepted", "looks right",
    }
    false_values = {
        "no", "n", "nope", "wrong", "reject", "manual", "choose manually",
    }

    if text in true_values:
        return True
    if text in false_values:
        return False
    if text.startswith(("yes", "yeah", "yep", "correct", "accept")):
        return True
    if text.startswith(("no", "nope", "wrong", "reject", "manual")):
        return False
    return None


def _build_classification_confirmation_message(classification: Dict[str, Any]) -> str:
    """Build a user-facing confirmation prompt for inferred classification."""
    issue_type = str(classification.get("issue_type", "")).strip()
    category = str(classification.get("category", "")).strip()
    confidence = str(classification.get("confidence", "")).strip()
    analysis = str(classification.get("analysis", "")).strip()

    summary_parts = []
    if issue_type:
        summary_parts.append("Cyber Security" if issue_type == "cyber" else "IT Support")
    if category:
        summary_parts.append(category.replace("_", " ").title())
    summary = " > ".join(summary_parts) if summary_parts else "a likely classification"

    details = []
    if confidence:
        details.append(f"Confidence: {confidence}.")
    if analysis:
        details.append(analysis)
    detail_text = " ".join(details).strip()

    base = f"I think this is best classified as {summary}."
    if detail_text:
        base = f"{base} {detail_text}"
    return f"{base} Do you want to accept this classification?"


def _ready_for_classification_confirmation(collected: Dict[str, Any]) -> bool:
    """Guardrail for when classification can be surfaced to the user.

    We intentionally wait for core factual context (description/time/incident_active
    and impact scope) before asking for confirmation, so early guesses do not
    derail the intake flow.
    """
    if not can_infer_category_and_severity(collected):
        return False
    if not str(collected.get("impact_scope", "")).strip():
        return False
    return True


def _prune_irrelevant_domain_fields(collected: Dict[str, Any]) -> List[str]:
    """Remove fields that belong exclusively to the other issue domain."""
    issue_type = str(collected.get("issue_type", "")).strip().lower()
    if issue_type not in {"cyber", "it_support"}:
        return []

    cyber_only = {
        "data_involved_flag",
        "data_involved",
        "data_other_text",
        "external_party_involved",
        "external_party_details",
        "already_reported_to_it",
        "reported_to_details",
    }
    it_support_only = {"affected_asset", "error_symptom"}
    irrelevant = it_support_only if issue_type == "cyber" else cyber_only

    removed: List[str] = []
    for field_name in irrelevant:
        if field_name in collected:
            collected.pop(field_name, None)
            removed.append(field_name)
    return removed


def get_pending_prompt(state: Dict[str, Any]) -> Tuple[Optional[str], Optional[str], Dict[str, Any]]:
    """Return a pending confirmation/manual-resolution prompt when applicable."""
    pending = state.get("pending_classification")
    if isinstance(pending, dict) and pending.get("issue_type"):
        return (
            "__classification_confirmation__",
            _build_classification_confirmation_message(pending),
            {
                "type": "boolean",
                "options": [
                    {"value": True, "label": "Yes"},
                    {"value": False, "label": "No"},
                ],
                "placeholder": "Accept the AI classification or choose no to set the report type manually.",
            },
        )

    if state.get("needs_manual_issue_type"):
        return (
            "issue_type",
            "No problem. Please choose the report type manually so I can continue with the right track.",
            {
                "type": "enum",
                "options": [
                    {"value": "cyber", "label": "Cyber Security"},
                    {"value": "it_support", "label": "IT Support"},
                ],
                "placeholder": "Choose the report type that fits best.",
            },
        )

    return None, None, {}


def _handle_pending_interaction(
    user_message: str,
    state: Dict[str, Any],
) -> Optional[Tuple[Dict[str, Any], Dict[str, Any], str, Dict[str, Any]]]:
    """Process pending confirmation/manual-resolution sub-flows before extraction.

    This function handles two temporary UI states:
    - AI classification confirmation (yes/no)
    - manual issue type selection fallback

    If neither state is active, returns None so normal extraction proceeds.
    """
    pending = state.get("pending_classification")
    if isinstance(pending, dict) and pending.get("issue_type"):
        decision = _parse_confirmation_reply(user_message)
        updated_state = {
            **state,
            "collected": dict(state.get("collected", {})),
            "messages": list(state.get("messages", [])),
            "pending_classification": None,
            "needs_manual_issue_type": False,
        }

        if decision is True:
            for field_name in ("issue_type", "category"):
                value = pending.get(field_name)
                if value:
                    updated_state["collected"][field_name] = value
            updated_state["classification_confirmed"] = True
            updated_state["missing"] = compute_missing_fields(updated_state["collected"])
            updated_state["active_missing"] = _active_missing(
                updated_state["missing"], updated_state.get("deferred_fields", [])
            )
            updated_state["expected_field"] = choose_next_field(
                updated_state["collected"], updated_state["active_missing"]
            )
            updated_state["failed_attempts"] = 0
            return (
                updated_state,
                {k: pending[k] for k in ("issue_type", "category") if pending.get(k)},
                "Understood. I have applied that classification and will continue with the next question.",
                {"expected_field": updated_state.get("expected_field"), "previous_missing": list(state.get("missing", [])), "failed_attempts": 0},
            )

        if decision is False:
            updated_state["classification_confirmed"] = False
            updated_state["needs_manual_issue_type"] = True
            updated_state["expected_field"] = "issue_type"
            updated_state["failed_attempts"] = 0
            return (
                updated_state,
                {},
                "No problem. Please choose the report type manually: Cyber Security or IT Support.",
                {"expected_field": "issue_type", "previous_missing": list(state.get("missing", [])), "failed_attempts": 0},
            )

        return (
            state,
            {},
            "Please answer Yes to accept the suggested classification, or No to choose the report type manually.",
            {"expected_field": "__classification_confirmation__", "previous_missing": list(state.get("missing", [])), "failed_attempts": 0},
        )

    if state.get("needs_manual_issue_type"):
        normalized = (user_message or "").strip().lower().replace(" ", "_")
        if normalized in {"cyber", "cyber_security"}:
            issue_type = "cyber"
        elif normalized in {"it_support", "it", "support"}:
            issue_type = "it_support"
        else:
            return (
                state,
                {},
                "Please choose one of these options so I stay on the right track: Cyber Security or IT Support.",
                {"expected_field": "issue_type", "previous_missing": list(state.get("missing", [])), "failed_attempts": 0},
            )

        updated_state = {
            **state,
            "collected": dict(state.get("collected", {})),
            "messages": list(state.get("messages", [])),
            "needs_manual_issue_type": False,
            "classification_confirmed": True,
        }
        updated_state["collected"]["issue_type"] = issue_type
        updated_state["missing"] = compute_missing_fields(updated_state["collected"])
        updated_state["active_missing"] = _active_missing(
            updated_state["missing"], updated_state.get("deferred_fields", [])
        )
        updated_state["expected_field"] = choose_next_field(
            updated_state["collected"], updated_state["active_missing"]
        )
        updated_state["failed_attempts"] = 0
        return (
            updated_state,
            {"issue_type": issue_type},
            "Thanks. I will use that report type and continue.",
            {"expected_field": updated_state.get("expected_field"), "previous_missing": list(state.get("missing", [])), "failed_attempts": 0},
        )

    return None


def _finalize_turn(updated_state: Dict[str, Any], user_message: str, assistant_message: str) -> Dict[str, Any]:
    """Append user/assistant messages and increment the turn counter."""
    updated_state["messages"].append({"role": "user", "content": user_message})
    updated_state["messages"].append({"role": "assistant", "content": assistant_message})
    updated_state["turn"] += 1
    return updated_state


def _advance_state(
    user_message: str,
    state: Dict[str, Any],
) -> Tuple[Dict[str, Any], Dict[str, Any], Optional[str], Dict[str, Any]]:
    """Advance extraction/inference/clarification state without generating final assistant text.

    Returns:
        (updated_state, extracted_patch, immediate_assistant_message_or_none, context)

    Pipeline sequence:
    1) Handle pending confirmation/manual issue-type interactions
    2) Extract explicit fields from the current user message
    3) Apply deterministic derived-field inference
    4) Recompute missing fields via flow engine
    5) Apply clarification/skip-defer behavior when answer quality is low
    """
    pending_result = _handle_pending_interaction(user_message, state)
    if pending_result is not None:
        return pending_result

    previous_missing = list(state.get("missing", []))
    previous_deferred = list(state.get("deferred_fields", []))
    previous_active = _active_missing(previous_missing, previous_deferred)

    expected_field = state.get("expected_field") or (previous_active[0] if previous_active else None)
    failed_attempts = int(state.get("failed_attempts", 0))

    extraction_targets = list(previous_active)
    if expected_field and expected_field in extraction_targets:
        extraction_targets = [expected_field] + [f for f in extraction_targets if f != expected_field]

    turn_patch = extract_fields(user_message, state.get("collected", {}), extraction_targets)

    updated_state = {
        "collected": dict(state.get("collected", {})),
        "missing": list(previous_missing),
        "active_missing": list(previous_active),
        "deferred_fields": list(previous_deferred),
        "messages": list(state.get("messages", [])),
        "turn": int(state.get("turn", 0)),
        "expected_field": expected_field,
        "failed_attempts": failed_attempts,
        "pending_classification": state.get("pending_classification"),
        "pending_issue_type_arbitration": state.get("pending_issue_type_arbitration"),
        "needs_manual_issue_type": bool(state.get("needs_manual_issue_type", False)),
        "classification_confirmed": bool(state.get("classification_confirmed", False)),
    }

    updated_state["collected"].update(turn_patch)

    inferred_patch = infer_derived_fields(updated_state["collected"])
    if inferred_patch:
        updated_state["collected"].update(inferred_patch)

    # Stage 1 (early coarse routing): infer top-level issue_type as soon as we
    # have a meaningful description, so users don't need to provide time/scope
    # before seeing an initial domain decision.
    current_issue_type = str(updated_state["collected"].get("issue_type", "")).strip().lower()
    if current_issue_type not in {"cyber", "it_support"}:
        inferred_issue_type = infer_issue_type_from_collected(
            updated_state["collected"], allow_reclassification=True
        )
        if inferred_issue_type in {"cyber", "it_support"}:
            updated_state["collected"]["issue_type"] = inferred_issue_type
            inferred_patch["issue_type"] = inferred_issue_type
        elif has_valid_description(updated_state["collected"]):
            # Never leave issue_type unresolved once a usable description exists.
            updated_state["collected"]["issue_type"] = "it_support"
            inferred_patch["issue_type"] = "it_support"

    patch = {**turn_patch, **inferred_patch}
    removed_domain_fields = _prune_irrelevant_domain_fields(updated_state["collected"])
    if removed_domain_fields:
        patch = {k: v for k, v in patch.items() if k not in removed_domain_fields}

    updated_state["missing"] = compute_missing_fields(updated_state["collected"])

    if (
        not updated_state.get("classification_confirmed")
        and not updated_state["collected"].get("category")
        and _ready_for_classification_confirmation(updated_state["collected"])
    ):
        classification = classify_report_with_ai(updated_state["collected"])
        if classification.get("strong_arbitration_pending"):
            updated_state["pending_issue_type_arbitration"] = {
                "status": "pending",
                "kind": classification.get("strong_arbitration_kind", "issue_type_only"),
                "direct_issue_type": {
                    "intent": classification.get("strong_arbitration_ai_intent", ""),
                    "confidence": classification.get("issue_type_confidence", 0.0),
                    "reason": classification.get("issue_type_reason", ""),
                },
                "local_issue_type": classification.get("strong_arbitration_local_issue_type", ""),
                "collected_snapshot": dict(updated_state["collected"]),
            }
        applied_classification = False
        for field_name in ("issue_type", "category"):
            value = classification.get(field_name)
            if value and not updated_state["collected"].get(field_name):
                updated_state["collected"][field_name] = value
                patch[field_name] = value
                applied_classification = True

        if applied_classification:
            updated_state["classification_confirmed"] = True
            updated_state["pending_classification"] = None
            removed_domain_fields = _prune_irrelevant_domain_fields(updated_state["collected"])
            if removed_domain_fields:
                patch = {k: v for k, v in patch.items() if k not in removed_domain_fields}
            updated_state["missing"] = compute_missing_fields(updated_state["collected"])

    should_continue, clarification_field, clarification_message = evaluate_reply_quality(
        user_message,
        expected_field,
        patch,
        updated_state["missing"],
        previous_missing=previous_missing,
        failed_attempts=failed_attempts,
    )

    # If the expected field is unclear but this turn still produced other
    # structured facts, continue the flow instead of forcing a rigid retry.
    if not should_continue and clarification_field:
        extracted_other_fields = any(field != clarification_field for field in patch.keys())
        if extracted_other_fields:
            should_continue = True

    if not should_continue and clarification_field:
        if clarification_field in patch and clarification_field in updated_state["collected"]:
            updated_state["collected"].pop(clarification_field, None)
            patch = {k: v for k, v in patch.items() if k != clarification_field}
            updated_state["missing"] = compute_missing_fields(updated_state["collected"])

        next_failed_attempts = failed_attempts + 1

        if next_failed_attempts >= 2 and _user_requests_skip_or_unknown(user_message):
            if clarification_field in {
                "response_details",
                "external_party_details",
                "reported_to_details",
                "impact_scope",
                "work_continuity",
                "location_detail",
            }:
                updated_state["collected"][clarification_field] = _unknown_placeholder_for_field(clarification_field)
            else:
                if clarification_field not in updated_state["deferred_fields"]:
                    updated_state["deferred_fields"].append(clarification_field)

            updated_state["missing"] = compute_missing_fields(updated_state["collected"])
            updated_state["deferred_fields"] = [
                field for field in updated_state["deferred_fields"] if field in updated_state["missing"]
            ]
            updated_state["active_missing"] = _active_missing(updated_state["missing"], updated_state["deferred_fields"])
            updated_state["expected_field"] = choose_next_field(
                updated_state["collected"], updated_state["active_missing"]
            )

            if updated_state["expected_field"]:
                assistant_message = (
                    "Understood. I will mark this detail as unavailable for now and continue. "
                    "Please answer this next question."
                )
                follow_up = generate_assistant_message(
                    "",
                    updated_state["collected"],
                    updated_state["active_missing"],
                    {},
                    expected_field=updated_state["expected_field"],
                    previous_missing=updated_state["missing"],
                    failed_attempts=0,
                )
                assistant_message = f"{assistant_message}\n\n{follow_up}" if follow_up else assistant_message
            else:
                assistant_message = (
                    "Understood. I have recorded that detail as unavailable. "
                    "Your report is now ready for submission."
                )

            updated_state["failed_attempts"] = 0
            context = {
                "expected_field": updated_state.get("expected_field"),
                "previous_missing": previous_missing,
                "failed_attempts": failed_attempts,
            }
            return updated_state, patch, assistant_message, context

        updated_state["deferred_fields"] = [
            field for field in updated_state["deferred_fields"] if field in updated_state["missing"]
        ]
        updated_state["active_missing"] = _active_missing(updated_state["missing"], updated_state["deferred_fields"])
        updated_state["expected_field"] = clarification_field
        updated_state["failed_attempts"] = next_failed_attempts

        assistant_message = clarification_message or "Could you please provide a bit more detail?"
        context = {
            "expected_field": clarification_field,
            "previous_missing": previous_missing,
            "failed_attempts": next_failed_attempts,
        }
        return updated_state, patch, assistant_message, context

    updated_state["deferred_fields"] = [
        field for field in updated_state["deferred_fields"] if field in updated_state["missing"]
    ]
    updated_state["active_missing"] = _active_missing(updated_state["missing"], updated_state["deferred_fields"])
    updated_state["expected_field"] = choose_next_field(
        updated_state["collected"], updated_state["active_missing"]
    )
    updated_state["failed_attempts"] = 0

    context = {
        "expected_field": expected_field,
        "previous_missing": previous_missing,
        "failed_attempts": failed_attempts,
    }
    return updated_state, patch, None, context


def _process_turn(user_message: str, state: Dict[str, Any]) -> Tuple[Dict[str, Any], str, Dict[str, Any]]:
    """Advance one conversation turn and return finalized state + reply + patch."""
    updated_state, patch, immediate_message, context = _advance_state(user_message, state)

    if immediate_message is not None:
        finalized = _finalize_turn(updated_state, user_message, immediate_message)
        return finalized, immediate_message, patch

    assistant_message = generate_assistant_message(
        user_message,
        updated_state["collected"],
        updated_state["active_missing"],
        patch,
        expected_field=context.get("expected_field"),
        previous_missing=context.get("previous_missing"),
        failed_attempts=int(context.get("failed_attempts", 0)),
    )
    finalized = _finalize_turn(updated_state, user_message, assistant_message)
    return finalized, assistant_message, patch


def process_user_message(
    user_message: str,
    state: Dict[str, Any],
) -> Tuple[Dict[str, Any], str, Dict[str, Any]]:
    """Process a user message and return updated state + assistant reply + extracted patch."""
    return _process_turn(user_message, state)


def process_user_message_stream(user_message: str, state: Dict[str, Any]):
    """Process a user message with streaming response."""
    try:
        yield {"type": "status", "message": "processing"}
        updated_state, patch, immediate_message, context = _advance_state(user_message, state)

        for field, value in patch.items():
            yield {"type": "field_update", "field": field, "value": value}

        if immediate_message is not None:
            assistant_message = immediate_message
            if assistant_message:
                yield {"type": "chunk", "content": assistant_message}
            finalized = _finalize_turn(updated_state, user_message, assistant_message)
            yield {"type": "done", "assistant_message": assistant_message, "state": finalized}
            return

        collected_chunks: List[str] = []
        for chunk in stream_assistant_message(
            user_message,
            updated_state["collected"],
            updated_state["active_missing"],
            extracted_patch=patch,
            expected_field=context.get("expected_field"),
            previous_missing=context.get("previous_missing"),
            failed_attempts=int(context.get("failed_attempts", 0)),
        ):
            collected_chunks.append(chunk)
            yield {"type": "chunk", "content": chunk}

        assistant_message = "".join(collected_chunks).strip()

        # Three-layer fallback: stream empty → AI fallback → pure template.
        # Ensures the frontend never displays the raw status text "processing".
        if not assistant_message:
            try:
                assistant_message = generate_assistant_message(
                    user_message,
                    updated_state["collected"],
                    updated_state["active_missing"],
                    extracted_patch=patch,
                    expected_field=context.get("expected_field"),
                    previous_missing=context.get("previous_missing"),
                    failed_attempts=int(context.get("failed_attempts", 0)),
                )
            except Exception:
                assistant_message = ""

        # Layer 3: pure template — no AI call, always succeeds.
        if not assistant_message:
            _, template_q, _ = get_next_question(updated_state["collected"], updated_state["active_missing"])
            assistant_message = f"Thank you for the information. {template_q}".strip() if template_q else "Thank you for the information."

        if collected_chunks == [] and assistant_message:
            # Emit as a single chunk so the frontend streaming display works correctly.
            yield {"type": "chunk", "content": assistant_message}

        finalized = _finalize_turn(updated_state, user_message, assistant_message)
        yield {"type": "done", "assistant_message": assistant_message, "state": finalized}

    except Exception as exc:
        yield {"type": "error", "message": str(exc)}


def is_complete(state: Dict[str, Any]) -> bool:
    """Check whether all required fields have been collected."""
    return len(state.get("missing", [])) == 0


def apply_issue_type_arbitration_result(
    state: Dict[str, Any],
    arbitration_result: Dict[str, Any],
) -> Dict[str, Any]:
    """Apply a background issue-type arbitration result to conversation state."""
    issue_type = str(arbitration_result.get("issue_type", "")).strip().lower()
    if issue_type not in {"cyber", "it_support"}:
        return state

    updated_state = {
        **state,
        "collected": dict(state.get("collected", {})),
        "messages": list(state.get("messages", [])),
    }
    collected = updated_state["collected"]
    previous_issue_type = str(collected.get("issue_type", "")).strip().lower()
    changed = previous_issue_type != issue_type

    collected["issue_type"] = issue_type
    if changed:
        category = str(collected.get("category", "")).strip().lower()
        if category and not is_category_allowed_for_issue_type(category, issue_type):
            collected.pop("category", None)
            collected.pop("category_other_text", None)
            collected.pop("severity", None)
        _prune_irrelevant_domain_fields(collected)
        updated_state["classification_confirmed"] = False

    pending = dict(updated_state.get("pending_issue_type_arbitration") or {})
    pending.update(
        {
            "status": "completed",
            "result_issue_type": issue_type,
            "analysis": str(arbitration_result.get("analysis", "")).strip(),
            "changed_issue_type": changed,
        }
    )
    updated_state["pending_issue_type_arbitration"] = pending
    updated_state["missing"] = compute_missing_fields(collected)
    updated_state["deferred_fields"] = [
        field
        for field in updated_state.get("deferred_fields", [])
        if field in updated_state["missing"]
    ]
    updated_state["active_missing"] = _active_missing(
        updated_state["missing"], updated_state.get("deferred_fields", [])
    )
    updated_state["expected_field"] = choose_next_field(
        collected, updated_state["active_missing"]
    )
    updated_state["failed_attempts"] = 0
    return updated_state
