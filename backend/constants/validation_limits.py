"""Validation limits and constraints for ticket creation and operations.

This module centralizes business rules around ticket data validation,
preventing magic numbers scattered through the codebase.
"""

# Description field constraints
MIN_DESCRIPTION_LENGTH = 10
MAX_DESCRIPTION_LENGTH = 5000

# RAG / similar tickets retrieval
# top_k for pre-creation validation (quick summary)
RAG_SEARCH_TOP_K_VALIDATE = 3

# top_k for post-creation admin view (more detailed comparison)
RAG_SEARCH_TOP_K_ADMIN = 5

# How many similar tickets to display after filtering self
RAG_SIMILAR_TICKETS_DISPLAY_LIMIT = 3

# AI summary truncation
AI_SUMMARY_DESCRIPTION_MAX_LENGTH = 300
AI_SUMMARY_RESOLUTION_MAX_LENGTH = 240

# Rate limiting for ticket creation (per user)
RATE_LIMIT_CREATE_TICKET_PER_WINDOW = 5
RATE_LIMIT_WINDOW_SECONDS = 60

# User role cache TTL (Firestore queries are expensive)
USER_ROLE_CACHE_TTL_SECONDS = 60


def get_validation_errors() -> dict:
    """Pre-formatted error messages for common validation failures."""
    return {
        "description_too_short": f"Description must be at least {MIN_DESCRIPTION_LENGTH} characters",
        "description_too_long": f"Description must be less than {MAX_DESCRIPTION_LENGTH} characters",
        "empty_request": "Request body is required",
        "insufficient_permissions": "Insufficient permissions for this operation",
        "rate_limit_exceeded": f"Too many requests. Maximum {RATE_LIMIT_CREATE_TICKET_PER_WINDOW} tickets per minute",
    }
