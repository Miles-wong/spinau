"""
Role and permission management utilities.

Simplified to match frontend architecture:
- admin: Full access
- reporter: Can create and view own tickets
"""

from backend_app.services.firestore_service import get_user_role, check_rate_limit
from backend_app.core.logger import get_logger

logger = get_logger(__name__)

# User roles (same as frontend)
ROLE_ADMIN = "admin"
ROLE_REPORTER = "reporter"

VALID_ROLES = {ROLE_ADMIN, ROLE_REPORTER}

# Permissions by role
PERMISSIONS = {
    ROLE_ADMIN: {
        "create_ticket",
        "view_all_tickets",
        "update_ticket_status",
        "assign_ticket",
        "close_ticket",
    },
    ROLE_REPORTER: {
        "create_ticket",
        "view_own_tickets",
    },
}


def has_permission(uid: str, permission: str) -> bool:
    """
    Check if user has specific permission.
    
    Args:
        uid: Firebase user ID
        permission: Permission name
    
    Returns:
        bool: True if user has permission
    """
    role = get_user_role(uid)
    has_perm = permission in PERMISSIONS.get(role, set())
    logger.info("Permission check", uid=uid, permission=permission, role=role, allowed=has_perm)
    return has_perm


def can_create_ticket(uid: str) -> bool:
    """Check if user can create a ticket."""
    can_create = has_permission(uid, "create_ticket")
    logger.info("Create-ticket permission evaluated", uid=uid, allowed=can_create)
    return can_create


def can_view_ticket(uid: str, ticket_created_by_uid: str) -> bool:
    """
    Check if user can view a specific ticket.
    
    - Admin can see all tickets
    - Reporter can only see own tickets
    """
    role = get_user_role(uid)
    
    if role == ROLE_ADMIN:
        return True
    
    # Reporter can only see own tickets
    return uid == ticket_created_by_uid


def can_update_ticket(uid: str) -> bool:
    """Check if user can update a ticket (only admin)."""
    return has_permission(uid, "update_ticket_status")


def enforce_rate_limit(uid: str, action: str = "create_ticket", limit: int = 5, window: int = 60) -> None:
    """
    Enforce rate limit - raise exception if exceeded.
    
    Args:
        uid: User ID
        action: Action name
        limit: Max actions in window (default: 5)
        window: Time window in seconds (default: 60)
    
    Raises:
        Exception: If rate limit exceeded
    """
    if not check_rate_limit(uid, action, limit=limit, window_seconds=window):
        raise Exception(
            f"Rate limit exceeded: maximum {limit} {action} per {window} seconds"
        )

