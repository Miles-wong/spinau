from __future__ import annotations

import math
import re
from collections import Counter
from typing import Counter as CounterType, Iterable, List

STOP_WORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have",
    "i", "in", "is", "it", "its", "of", "on", "or", "that", "the", "this", "to", "was",
    "were", "will", "with", "my", "our", "your", "their", "after", "before", "into", "out",
    "can", "cannot", "could", "should", "would", "may", "might", "we", "you", "they", "he",
    "she", "them", "me", "do", "did", "done", "not", "no", "yes", "just", "now", "then",
    "ticket", "tickets", "issue", "incident", "report", "reported", "please", "help",
    "thanks", "thank", "hi", "hello", "team", "kindly", "regards", "urgent", "asap",
    "http", "https", "www", "com", "org", "net", "id", "type", "category", "description",
}

_TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_+-]{2,}")


def _is_low_signal_token(token: str) -> bool:
    if token.isdigit():
        return True
    if len(set(token)) == 1 and len(token) >= 3:
        return True
    return False


def tokenize(text: str) -> List[str]:
    raw = (text or "").lower().replace("\n", " ")
    tokens = _TOKEN_PATTERN.findall(raw)
    return [
        token
        for token in tokens
        if token not in STOP_WORDS and not _is_low_signal_token(token)
    ]



def compute_tf(tokens: Iterable[str]) -> CounterType[str]:
    return Counter(tokens)



def cosine_similarity(left: CounterType[str], right: CounterType[str]) -> float:
    if not left or not right:
        return 0.0
    common_terms = set(left).intersection(right)
    dot = sum(left[t] * right[t] for t in common_terms)
    left_norm = math.sqrt(sum(v * v for v in left.values()))
    right_norm = math.sqrt(sum(v * v for v in right.values()))
    if left_norm == 0.0 or right_norm == 0.0:
        return 0.0
    return dot / (left_norm * right_norm)
