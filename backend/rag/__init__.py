"""Local retrieval helpers for ticket similarity and lightweight RAG context."""

from .search import build_suggested_action, get_similar_ticket_context, search_similar_tickets

__all__ = ["search_similar_tickets", "get_similar_ticket_context", "build_suggested_action"]
