"""Compatibility shim for the preserved lightweight RAG module."""

from backend_app.services.firestore_service import get_firestore_db

__all__ = ["get_firestore_db"]
