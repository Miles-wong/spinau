"""Inference engine for derived intake fields.

This module owns non-deterministic or model-assisted field derivation that
should only happen after enough factual context exists.
"""

from typing import Any, Dict

from .classification import classify_report_with_ai, infer_issue_type_from_collected
from .flow_engine import can_infer_category_and_severity, has_minimum_core_facts


def infer_derived_fields(collected: Dict[str, Any]) -> Dict[str, Any]:
    """Infer derived fields from the current collected state when thresholds are met."""
    patch: Dict[str, Any] = {}

    current_issue_type = str(collected.get("issue_type", "")).strip().lower()
    if current_issue_type in {"not_sure", "it_support"} and has_minimum_core_facts(collected):
        inferred_issue_type = infer_issue_type_from_collected(
            collected,
            allow_reclassification=True,
        )
        if current_issue_type == "not_sure" and inferred_issue_type in {"cyber", "it_support"}:
            patch["issue_type"] = inferred_issue_type
        elif current_issue_type == "it_support" and inferred_issue_type == "cyber":
            # Promote to cyber when later turns add strong security evidence.
            patch["issue_type"] = "cyber"

    if not can_infer_category_and_severity(collected):
        return patch

    recommendations = classify_report_with_ai({**collected, **patch})

    issue_type = recommendations.get("issue_type")
    if (
        issue_type in {"cyber", "it_support"}
        and collected.get("issue_type") != issue_type
    ):
        patch["issue_type"] = issue_type

    category = recommendations.get("category")
    if category and not collected.get("category"):
        patch["category"] = category

    severity = recommendations.get("severity")
    if severity and not collected.get("severity"):
        patch["severity"] = severity

    return patch
