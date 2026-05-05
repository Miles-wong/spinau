"""LLM client factory for the form_service pipeline.

Reads MODEL_PROVIDER from env (openai | deepseek | gemini | local)
and EXTRACTION_SPEED (fast | balanced | accurate) then selects
the appropriate model names and builds lazily-initialized
OpenAI-compatible client singletons.
"""

import os

from dotenv import load_dotenv
from openai import OpenAI

from .schema import EXTRACTION_SPEED_MODE

load_dotenv(override=True)

_openai_client = None
_deepseek_client = None
_gemini_client = None
_local_client = None


def _env(name: str) -> str:
    """Read an env var as a trimmed string (empty string if not set)."""
    return os.environ.get(name, "").strip()


def _require_env(name: str) -> str:
    """Read a required env var and raise a clear configuration error if missing."""
    value = _env(name)
    if not value:
        raise ValueError(f"{name} not configured in .env")
    return value


def _normalize_model_name(model_name: str, provider: str) -> str:
    """Normalize model name for case-insensitive provider/model inputs.

    Hosted providers use lowercase model IDs in practice, so we normalize to
    lowercase there. Local providers may depend on case-sensitive aliases, so
    we preserve the original case for local.
    """
    cleaned = model_name.strip()
    if provider in {"openai", "deepseek", "gemini"}:
        return cleaned.lower()
    return cleaned


MODEL_PROVIDER = (_env("MODEL_PROVIDER") or "openai").lower()
AI_DEBUG = _env("AI_DEBUG").lower() in {"1", "true", "yes", "on"}


# -----------------------------
# Model selection
# -----------------------------
MODEL_NAME = _normalize_model_name(_require_env("MODEL_NAME"), MODEL_PROVIDER)
EXTRACTION_MODEL = MODEL_NAME
ASSISTANT_MODEL = MODEL_NAME

if AI_DEBUG:
    print(
        f"[CONFIG] provider={MODEL_PROVIDER} speed={EXTRACTION_SPEED_MODE} "
        f"model=({EXTRACTION_MODEL}/{ASSISTANT_MODEL})"
    )


# -----------------------------
# Client factories
# -----------------------------
def get_openai_client() -> OpenAI:
    """Get or create OpenAI client (ChatGPT)."""
    global _openai_client
    if _openai_client is None:
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            raise ValueError("OPENAI_API_KEY not configured in .env")
        _openai_client = OpenAI(api_key=api_key, timeout=10.0, max_retries=2)
    return _openai_client


def get_deepseek_client() -> OpenAI:
    """Get or create DeepSeek client."""
    global _deepseek_client
    if _deepseek_client is None:
        api_key = os.environ.get("DEEPSEEK_API_KEY")
        if not api_key:
            raise ValueError("DEEPSEEK_API_KEY not configured in .env")
        _deepseek_client = OpenAI(
            api_key=api_key,
            base_url="https://api.deepseek.com",
            timeout=12.0,
            max_retries=2,
        )
    return _deepseek_client


def get_gemini_client() -> OpenAI:
    """Get or create Gemini client via OpenAI-compatible endpoint."""
    global _gemini_client
    if _gemini_client is None:
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise ValueError("GEMINI_API_KEY not configured in .env")
        _gemini_client = OpenAI(
            api_key=api_key,
            base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
            timeout=8.0,
            max_retries=1,
        )
    return _gemini_client


def get_local_client() -> OpenAI:
    """Get or create local model client via LM Studio local server."""
    global _local_client
    if _local_client is None:
        _local_client = OpenAI(
            api_key="not-needed",
            base_url="http://localhost:1234/v1",
            timeout=20.0,
            max_retries=1,
        )
    return _local_client


# -----------------------------
# Unified client getter
# -----------------------------
def get_client() -> OpenAI:
    """Get the active client based on MODEL_PROVIDER setting."""
    if MODEL_PROVIDER == "openai":
        return get_openai_client()
    if MODEL_PROVIDER == "deepseek":
        return get_deepseek_client()
    if MODEL_PROVIDER == "local":
        return get_local_client()
    return get_gemini_client()