"""Configuration for lightweight local retrieval."""

from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
STORE_DIR = BASE_DIR / "store"
INDEX_PATH = STORE_DIR / "ticket_index.json"

MAX_DESCRIPTION_CHARS = int(os.environ.get("RAG_MAX_DESCRIPTION_CHARS", "2000"))
MIN_QUERY_LENGTH = int(os.environ.get("RAG_MIN_QUERY_LENGTH", "10"))
DEFAULT_TOP_K = int(os.environ.get("RAG_DEFAULT_TOP_K", "3"))
MAX_CORPUS_SIZE = int(os.environ.get("RAG_MAX_CORPUS_SIZE", "1000"))
MIN_SEARCH_TEXT_CHARS = int(os.environ.get("RAG_MIN_SEARCH_TEXT_CHARS", "30"))
MIN_DESCRIPTION_QUALITY_CHARS = int(os.environ.get("RAG_MIN_DESCRIPTION_QUALITY_CHARS", "20"))
MIN_DOC_TOKEN_COUNT = int(os.environ.get("RAG_MIN_DOC_TOKEN_COUNT", "8"))
MIN_SIMILARITY_SCORE = float(os.environ.get("RAG_MIN_SIMILARITY_SCORE", "0.08"))
TOKEN_WEIGHT_TITLE = float(os.environ.get("RAG_TOKEN_WEIGHT_TITLE", "1.2"))
TOKEN_WEIGHT_CATEGORY = float(os.environ.get("RAG_TOKEN_WEIGHT_CATEGORY", "1.1"))
TOKEN_WEIGHT_RESOLUTION = float(os.environ.get("RAG_TOKEN_WEIGHT_RESOLUTION", "0.8"))
SCORE_WEIGHT_DESCRIPTION = float(os.environ.get("RAG_SCORE_WEIGHT_DESCRIPTION", "0.5"))
SCORE_WEIGHT_CATEGORY = float(os.environ.get("RAG_SCORE_WEIGHT_CATEGORY", "0.2"))
SCORE_WEIGHT_ISSUE_TYPE = float(os.environ.get("RAG_SCORE_WEIGHT_ISSUE_TYPE", "0.2"))
