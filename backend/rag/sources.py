"""Load ticket corpus from Firestore for local indexing."""

from __future__ import annotations

import re
from typing import Any, Dict, List

from firestore_service import get_firestore_db
from logger import get_logger
from rag.config import (
    MAX_CORPUS_SIZE,
    MAX_DESCRIPTION_CHARS,
    MIN_DESCRIPTION_QUALITY_CHARS,
    MIN_DOC_TOKEN_COUNT,
    MIN_SEARCH_TEXT_CHARS,
    TOKEN_WEIGHT_CATEGORY,
    TOKEN_WEIGHT_RESOLUTION,
    TOKEN_WEIGHT_TITLE,
)
from rag.utils import tokenize

logger = get_logger(__name__)

_SAMPLE_MARKERS = {
    "sample",
    "dummy",
    "mock",
    "demo",
    "synthetic",
    "generated",
    "lorem ipsum",
    "seed data",
    "test ticket",
}


def _normalize_for_signature(text: str) -> str:
    compact = re.sub(r"\s+", " ", (text or "").strip().lower())
    return re.sub(r"[^a-z0-9 ]+", "", compact)


def _looks_generated_or_sample(ticket: Dict[str, Any]) -> bool:
    ticket_id = str(ticket.get("ticket_id") or "").strip().lower()
    if ticket_id.startswith(("sample", "demo", "mock", "seed", "test", "generated")):
        return True

    title = str(ticket.get("title") or "").lower()
    description = str(ticket.get("description") or "").lower()
    closure_summary = str(ticket.get("closure_summary") or ticket.get("response_details") or "").lower()
    combined = f"{title} {description} {closure_summary}"
    marker_hits = sum(1 for marker in _SAMPLE_MARKERS if marker in combined)
    return marker_hits >= 2


def _is_low_quality_ticket(ticket: Dict[str, Any], search_text: str) -> bool:
    description = str(ticket.get("description") or "").strip()
    if len(description) < MIN_DESCRIPTION_QUALITY_CHARS:
        return True
    if len(search_text.strip()) < MIN_SEARCH_TEXT_CHARS:
        return True
    if len(tokenize(search_text)) < MIN_DOC_TOKEN_COUNT:
        return True
    return False


def _build_search_text(ticket: Dict[str, Any]) -> str:
    title = str(ticket.get("title", "") or "").strip()
    issue_type = str(ticket.get("issue_type", "") or "").strip()
    category = str(ticket.get("category", "") or "").strip()
    severity = str(ticket.get("severity", "") or "").strip()
    description = str(ticket.get("description", "") or "").strip()[:MAX_DESCRIPTION_CHARS]
    closure_summary = str(ticket.get("closure_summary", "") or ticket.get("response_details", "") or "").strip()[:MAX_DESCRIPTION_CHARS]
    location = str(ticket.get("location_detail", "") or "").strip()
    status = str(ticket.get("status", "") or "").strip()
    response_taken = str(ticket.get("response_taken", "") or "").strip()
    incident_active = str(ticket.get("incident_active", "") or "").strip()

    weighted_bits = []
    if title:
        weighted_bits.extend([title] * max(1, round(TOKEN_WEIGHT_TITLE)))
    if issue_type:
        weighted_bits.append(f"issue type {issue_type}")
    if category:
        weighted_bits.extend([f"category {category}"] * max(1, round(TOKEN_WEIGHT_CATEGORY)))
    if severity:
        weighted_bits.append(f"severity {severity}")
    if location:
        weighted_bits.append(f"location {location}")
    if status:
        weighted_bits.append(f"status {status}")
    if response_taken:
        weighted_bits.append(f"response taken {response_taken}")
    if incident_active:
        weighted_bits.append(f"incident active {incident_active}")
    if description:
        weighted_bits.append(description)
    if closure_summary:
        weighted_bits.extend([f"resolution {closure_summary}"] * max(1, round(TOKEN_WEIGHT_RESOLUTION)))
    return "\n".join(bit for bit in weighted_bits if bit)



def load_ticket_corpus(limit: int = MAX_CORPUS_SIZE) -> List[Dict[str, Any]]:
    db = get_firestore_db()
    docs = db.collection("tickets").limit(limit).stream()
    corpus: List[Dict[str, Any]] = []
    seen_signatures = set()
    for doc in docs:
        payload = doc.to_dict() or {}
        if _looks_generated_or_sample(payload):
            continue

        text = _build_search_text(payload)
        if not text.strip():
            continue
        if _is_low_quality_ticket(payload, text):
            continue

        signature = "|".join([
            _normalize_for_signature(str(payload.get("issue_type") or "")),
            _normalize_for_signature(str(payload.get("category") or "")),
            _normalize_for_signature(str(payload.get("description") or "")[:220]),
        ])
        if signature in seen_signatures:
            continue
        seen_signatures.add(signature)

        corpus.append({
            "doc_id": doc.id,
            "ticket_id": payload.get("ticket_id") or doc.id,
            "title": payload.get("title") or "",
            "issue_type": payload.get("issue_type") or "",
            "category": payload.get("category") or "",
            "severity": payload.get("severity") or "",
            "description": payload.get("description") or "",
            "closure_summary": payload.get("closure_summary") or payload.get("response_details") or "",
            "location_detail": payload.get("location_detail") or "",
            "status": payload.get("status") or "",
            "response_taken": payload.get("response_taken") or "",
            "incident_active": payload.get("incident_active") or "",
            "search_text": text,
        })
    logger.info("Loaded ticket corpus for local retrieval", count=len(corpus))
    return corpus
