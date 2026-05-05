"""form_service package — conversational incident-intake pipeline.

Module layout
-------------
ai.py             LLM client factory (OpenAI / DeepSeek / Gemini).
schema.py         Field definitions, question priority ordering, and extraction config.
extraction.py     Parse user messages into structured field values (fast-path + LLM).
classification.py Domain classification and category/severity recommendation rules.
prompts/          Prompt builders for extraction and classification.
question_flow.py  Determine the next unanswered field and generate its question text.
assistant.py      Build AI-generated or fallback assistant responses.
clarification.py  Evaluate reply quality and produce re-ask prompts.
conversation.py   Stateful turn-processing orchestrator (the main entry point).
tracker.py        Per-session AI call timing instrumentation.
flow_engine.py    Deterministic missing-field and priority selection logic.
inference_engine.py  Derived field inference once enough factual context exists.
llm_backend.py    Shared transport helpers for text and JSON model calls.
"""

from .assistant import (
    build_fallback_assistant_message,
    generate_assistant_message,
    stream_assistant_message,
)
from .conversation import (
    create_initial_state,
    get_pending_prompt,
    is_complete,
    process_user_message,
    process_user_message_stream,
)
from .extraction import extract_fields
from .flow_engine import select_next_field
from .inference_engine import infer_derived_fields
from .question_flow import (
    compute_missing_fields,
    generate_ai_suggestion_tip,
    generate_next_question_with_ai,
    get_next_question,
)
from .tracker import _ai_tracker

__all__ = [
    "_ai_tracker",
    "build_fallback_assistant_message",
    "compute_missing_fields",
    "create_initial_state",
    "extract_fields",
    "generate_assistant_message",
    "generate_ai_suggestion_tip",
    "get_pending_prompt",
    "generate_next_question_with_ai",
    "get_next_question",
    "infer_derived_fields",
    "is_complete",
    "process_user_message",
    "process_user_message_stream",
    "select_next_field",
    "stream_assistant_message",
]
