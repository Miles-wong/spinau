"""Shared LLM backend helpers.

This module centralises provider-specific chat-completion mechanics so business
modules can focus on intake logic, prompts, and validation rather than raw SDK
calls.
"""

import json
import time
from typing import Any, Dict, Generator, List, Optional, Tuple

from .ai import (
    ASSISTANT_MODEL,
    EXTRACTION_MODEL,
    MODEL_PROVIDER,
    get_client,
    get_openai_client,
)


def _tokens_param(model: str, value: int) -> Dict[str, int]:
    """Return the correct token-limit kwarg for the given model.

    Newer OpenAI models (o-series, gpt-5+) require ``max_completion_tokens``
    while older models and all other providers use ``max_tokens``.
    """
    new_style = MODEL_PROVIDER == "openai" and (
        model.startswith("o")
        or (model.startswith("gpt-") and _major_version(model) >= 5)
    )
    key = "max_completion_tokens" if new_style else "max_tokens"
    return {key: value}


def _major_version(model: str) -> int:
    """Extract the major version integer from a model name like 'gpt-5' or 'gpt-4o'."""
    try:
        part = model.split("-")[1]          # e.g. "5", "4o", "4"
        return int("".join(c for c in part if c.isdigit()) or "0")
    except (IndexError, ValueError):
        return 0


def _is_new_openai_model(model: str) -> bool:
    """Return True for OpenAI o-series and gpt-5+ models.

    These models do not support the ``temperature`` parameter and require
    ``max_completion_tokens`` instead of ``max_tokens``.
    """
    return MODEL_PROVIDER == "openai" and (
        model.startswith("o")
        or (model.startswith("gpt-") and _major_version(model) >= 5)
    )


def _build_chat_kwargs(model: str, max_tokens: int, temperature: float, **extra) -> Dict[str, Any]:
    """Build the kwargs dict for chat.completions.create, omitting unsupported params.

    New OpenAI models (o-series / gpt-5+) reject ``temperature`` and ``max_tokens``.
    All other models / providers accept both.
    """
    kwargs: Dict[str, Any] = {"model": model, **extra}
    if _is_new_openai_model(model):
        kwargs["max_completion_tokens"] = max_tokens
        # temperature is not supported — omit it entirely
    else:
        kwargs["max_tokens"] = max_tokens
        kwargs["temperature"] = temperature
    return kwargs


def request_text_completion(
    messages: List[Dict[str, str]],
    *,
    model: Optional[str] = None,
    temperature: float = 0.4,
    max_tokens: int = 200,
    timeout: float = 5.0,
) -> Tuple[str, float]:
    """Run a standard text completion and return content plus API duration."""
    client = get_client()
    selected_model = model or ASSISTANT_MODEL

    api_start = time.time()
    response = client.chat.completions.create(
        **_build_chat_kwargs(selected_model, max_tokens, temperature,
                             messages=messages, timeout=timeout),
    )
    api_time = time.time() - api_start
    content = (response.choices[0].message.content or "").strip()
    return content, api_time


def stream_text_completion(
    messages: List[Dict[str, str]],
    *,
    model: Optional[str] = None,
    temperature: float = 0.4,
    max_tokens: int = 300,
    timeout: float = 5.0,
) -> Generator[str, None, int]:
    """Stream text completion chunks and return the final chunk count."""
    client = get_client()
    selected_model = model or ASSISTANT_MODEL

    try:
        stream = client.chat.completions.create(
            **_build_chat_kwargs(selected_model, max_tokens, temperature,
                                 messages=messages, stream=True, timeout=timeout),
        )

        chunk_count = 0
        for chunk in stream:
            delta = chunk.choices[0].delta
            if delta:
                content = getattr(delta, "content", None)
                if content:
                    chunk_count += 1
                    yield content

        return chunk_count
    except Exception:
        raise


def request_json_completion(
    messages: List[Dict[str, str]],
    *,
    model: Optional[str] = None,
    temperature: float = 0.0,
    top_p: float = 1.0,
    max_tokens: int = 220,
    timeout: float = 5.0,
    use_gemini_fallback: bool = False,
) -> Tuple[Dict[str, Any], float, bool]:
    """Run a JSON-oriented completion with optional Gemini-to-OpenAI fallback.

    Returns:
        (parsed_json, api_duration_seconds, used_fallback)
    """
    selected_model = model or EXTRACTION_MODEL
    client = get_client()

    try:
        api_start = time.time()
        response = client.chat.completions.create(
            **_build_chat_kwargs(selected_model, max_tokens, temperature,
                                 messages=messages, top_p=top_p, timeout=timeout),
        )
        api_time = time.time() - api_start
        response_text = response.choices[0].message.content or ""
        return _parse_json_object(response_text), api_time, False
    except Exception:
        if not (use_gemini_fallback and MODEL_PROVIDER == "gemini"):
            raise

        fb_start = time.time()
        fb_client = get_openai_client()
        fb_response = fb_client.chat.completions.create(
            **_build_chat_kwargs("gpt-4o-mini", max_tokens, temperature,
                                 messages=messages, top_p=1.0, timeout=timeout),
        )
        api_time = time.time() - fb_start
        response_text = fb_response.choices[0].message.content or ""
        return _parse_json_object(response_text), api_time, True


def _parse_json_object(text: str) -> Dict[str, Any]:
    """Parse a JSON object from a model response, with loose fallback extraction."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start_idx = text.find("{")
        end_idx = text.rfind("}")
        if start_idx >= 0 and end_idx > start_idx:
            return json.loads(text[start_idx : end_idx + 1])
    return {}
