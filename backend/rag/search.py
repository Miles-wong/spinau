"""Local similarity search over historical tickets.

This is a lightweight first-pass retrieval layer for the reporting system.
It is intentionally dependency-light so the project can adopt RAG-like flows
without needing FAISS or a hosted vector database on day one.
"""

from __future__ import annotations

from collections import Counter
import json
import re
from typing import Any, Dict, List

from logger import get_logger
from rag.config import (
    DEFAULT_TOP_K,
    INDEX_PATH,
    MIN_QUERY_LENGTH,
    MIN_SIMILARITY_SCORE,
    SCORE_WEIGHT_CATEGORY,
    SCORE_WEIGHT_DESCRIPTION,
    SCORE_WEIGHT_ISSUE_TYPE,
)
from rag.sources import load_ticket_corpus
from rag.utils import compute_tf, cosine_similarity, tokenize

logger = get_logger(__name__)

_INDEX_CACHE: List[Dict[str, Any]] | None = None


def _normalize_issue_type(value: str | None) -> str:
    raw = str(value or "").strip().lower()
    return re.sub(r"[^a-z0-9]+", "_", raw).strip("_")


def _to_counter(value: Any) -> Counter:
    if isinstance(value, dict):
        return Counter({str(k): float(v) for k, v in value.items()})
    return Counter()


def _infer_issue_type_from_query(query: str, records: List[Dict[str, Any]]) -> str:
    normalized_query = _normalize_issue_type(query)
    if not normalized_query:
        return ""

    candidates = {
        _normalize_issue_type(str(record.get("issue_type") or ""))
        for record in records
        if record.get("issue_type")
    }
    candidates.discard("")
    if not candidates:
        return ""

    query_tokens = set(normalized_query.split("_"))
    ranked_matches = []
    for issue in candidates:
        issue_tokens = [tok for tok in issue.split("_") if tok]
        if issue and issue in normalized_query:
            ranked_matches.append((len(issue_tokens), issue))
            continue
        if issue_tokens and all(tok in query_tokens for tok in issue_tokens):
            ranked_matches.append((len(issue_tokens), issue))

    if not ranked_matches:
        return ""
    ranked_matches.sort(reverse=True)
    return ranked_matches[0][1]


def _compute_record_score(query_tf: Counter, record: Dict[str, Any]) -> float:
    full_tf = _to_counter(record.get("tf"))
    description_tf = _to_counter(record.get("tf_description"))
    category_tf = _to_counter(record.get("tf_category"))
    issue_type_tf = _to_counter(record.get("tf_issue_type"))

    if not description_tf:
        description_tf = compute_tf(tokenize(str(record.get("description") or "")))
    if not category_tf:
        category_tf = compute_tf(tokenize(str(record.get("category") or "")))
    if not issue_type_tf:
        issue_type_tf = compute_tf(tokenize(str(record.get("issue_type") or "").replace("_", " ")))

    base_weight = max(0.0, 1.0 - (SCORE_WEIGHT_DESCRIPTION + SCORE_WEIGHT_CATEGORY + SCORE_WEIGHT_ISSUE_TYPE))
    score_full = cosine_similarity(query_tf, full_tf)
    score_description = cosine_similarity(query_tf, description_tf)
    score_category = cosine_similarity(query_tf, category_tf)
    score_issue_type = cosine_similarity(query_tf, issue_type_tf)
    return (
        base_weight * score_full
        + SCORE_WEIGHT_DESCRIPTION * score_description
        + SCORE_WEIGHT_CATEGORY * score_category
        + SCORE_WEIGHT_ISSUE_TYPE * score_issue_type
    )


def _load_index_records() -> List[Dict[str, Any]]:
    global _INDEX_CACHE
    if _INDEX_CACHE is not None:
        return _INDEX_CACHE

    if INDEX_PATH.exists():
        try:
            with INDEX_PATH.open("r", encoding="utf-8") as fh:
                payload = json.load(fh)
            records = payload.get("records", [])
            if isinstance(records, list):
                _INDEX_CACHE = records
                return _INDEX_CACHE
        except Exception as exc:
            logger.warning("Failed to load local ticket index, falling back to live corpus", exc_info=exc)

    live_records: List[Dict[str, Any]] = []
    for row in load_ticket_corpus():
        tokens = tokenize(row.get("search_text", ""))
        desc_tokens = tokenize(str(row.get("description") or ""))
        category_tokens = tokenize(str(row.get("category") or ""))
        issue_type_tokens = tokenize(str(row.get("issue_type") or "").replace("_", " "))
        live_records.append({
            **row,
            "tokens": tokens,
            "tf": dict(compute_tf(tokens)),
            "tf_description": dict(compute_tf(desc_tokens)),
            "tf_category": dict(compute_tf(category_tokens)),
            "tf_issue_type": dict(compute_tf(issue_type_tokens)),
        })
    _INDEX_CACHE = live_records
    return _INDEX_CACHE


def clear_index_cache() -> None:
    global _INDEX_CACHE
    _INDEX_CACHE = None


def search_similar_tickets(
    query: str,
    top_k: int = DEFAULT_TOP_K,
    issue_type: str | None = None,
    category: str | None = None,
    min_score: float = MIN_SIMILARITY_SCORE,
) -> List[Dict[str, Any]]:
    query = (query or "").strip()
    if len(query) < MIN_QUERY_LENGTH:
        return []

    records = _load_index_records()
    if not records:
        return []

    query_tokens = tokenize(query)
    if not query_tokens:
        return []

    query_tf = compute_tf(query_tokens)
    selected_issue_type = _normalize_issue_type(issue_type) or _infer_issue_type_from_query(query, records)
    selected_category = (category or "").strip().lower()
    
    candidates = records
    
    # Filter by issue_type if specified or inferred
    if selected_issue_type:
        filtered = [
            record for record in records
            if _normalize_issue_type(str(record.get("issue_type") or "")) == selected_issue_type
        ]
        if filtered:
            candidates = filtered
    
    # Further filter by category if specified
    if selected_category:
        filtered = [
            record for record in candidates
            if str(record.get("category") or "").strip().lower() == selected_category
        ]
        if filtered:
            candidates = filtered

    ranked: List[Dict[str, Any]] = []
    for record in candidates:
        score = _compute_record_score(query_tf, record)
        if score < max(0.0, min_score):
            continue
        ranked.append({
            "doc_id": record.get("doc_id"),
            "ticket_id": record.get("ticket_id"),
            "title": record.get("title"),
            "issue_type": record.get("issue_type"),
            "category": record.get("category"),
            "priority": record.get("priority"),
            "description": record.get("description"),
            "resolution": record.get("resolution"),
            "location_detail": record.get("location_detail"),
            "matched_issue_type": selected_issue_type or None,
            "matched_category": selected_category or None,
            "score": round(float(score), 4),
        })

    ranked.sort(key=lambda item: item["score"], reverse=True)
    return ranked[:max(1, top_k)]


def get_similar_ticket_context(query: str, top_k: int = DEFAULT_TOP_K, issue_type: str | None = None, category: str | None = None) -> str:
    results = search_similar_tickets(query=query, top_k=top_k, issue_type=issue_type, category=category)
    if not results:
        return ""

    chunks = []
    for idx, item in enumerate(results, start=1):
        summary = [
            f"Similar ticket {idx}:",
            f"ticket_id={item.get('ticket_id')}",
            f"issue_type={item.get('issue_type') or 'unknown'}",
            f"category={item.get('category') or 'unknown'}",
            f"priority={item.get('priority') or 'unknown'}",
        ]
        if item.get("description"):
            summary.append(f"description={item['description']}")
        if item.get("resolution"):
            summary.append(f"resolution={item['resolution']}")
        chunks.append(" | ".join(summary))
    return "\n".join(chunks)


def build_suggested_action(similar_tickets: List[Dict[str, Any]]) -> str:
    """Generate a short suggested action from the best historical match."""
    if not similar_tickets:
        return ""

    top_match = similar_tickets[0]
    resolution = str(top_match.get("resolution") or "").strip()
    category = str(top_match.get("category") or "").strip() or "similar issue"

    if not resolution:
        return ""

    resolution = resolution[:240]
    return f"Suggested action: For a similar {category} case, the previous resolution was: {resolution}"
