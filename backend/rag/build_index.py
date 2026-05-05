"""Build a lightweight local ticket index stored as JSON.

Usage:
    python -m rag.build_index
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from rag.config import INDEX_PATH
from rag.sources import load_ticket_corpus
from rag.utils import compute_tf, tokenize


def build_ticket_index() -> Path:
    corpus = load_ticket_corpus()
    records = []
    for row in corpus:
        tokens = tokenize(row.get("search_text", ""))
        desc_tokens = tokenize(str(row.get("description") or ""))
        category_tokens = tokenize(str(row.get("category") or ""))
        issue_type_tokens = tokenize(str(row.get("issue_type") or "").replace("_", " "))
        records.append({
            **row,
            "tokens": tokens,
            "tf": dict(compute_tf(tokens)),
            "tf_description": dict(compute_tf(desc_tokens)),
            "tf_category": dict(compute_tf(category_tokens)),
            "tf_issue_type": dict(compute_tf(issue_type_tokens)),
        })

    INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "built_at": datetime.now(timezone.utc).isoformat(),
        "records": records,
    }
    with INDEX_PATH.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    return INDEX_PATH


if __name__ == "__main__":
    path = build_ticket_index()
    print(f"Built local ticket index at {path}")
