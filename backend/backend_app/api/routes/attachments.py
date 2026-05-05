"""Ticket attachment download route.

Endpoint
--------
GET /api/tickets/<ticket_id>/attachments/<attachment_id>/download
    Authenticated, role-checked download with a stable Content-Disposition header.

Why a server-side proxy instead of a direct signed URL?
- Enforces role-based access control on ticket ownership.
- Guarantees ``Content-Disposition: attachment`` for consistent browser behaviour.
- Logs every download into the audit trail.
"""

import os
import time
import traceback
from urllib.parse import quote
from urllib.request import urlopen

import firebase_admin
from firebase_admin import storage
from flask import Blueprint, Response, g, jsonify

from backend_app.services.firestore_service import get_firestore_db, log_action
from backend_app.core.logger import get_logger
from backend_app.api.middleware.auth import require_auth
from backend_app.services.permissions import can_view_ticket

logger = get_logger(__name__)
bp = Blueprint("attachments", __name__)


def _resolve_ticket_owner_uid(ticket_data: dict) -> str:
    """Resolve ticket owner UID from current and legacy schema fields."""
    return str(
        ticket_data.get("created_by_uid")
        or ticket_data.get("created_by")
        or ticket_data.get("createdByUid")
        or ""
    )


def _resolve_bucket_name(attachment_doc: dict) -> str:
    """Best-effort resolution of the Firebase Storage bucket name."""
    # 1) Explicit env override.
    env_bucket = os.getenv("FIREBASE_STORAGE_BUCKET", "").strip()
    if env_bucket:
        return env_bucket

    # 2) Value stored in the firebase_admin app options.
    try:
        app_options = getattr(firebase_admin.get_app(), "options", {}) or {}
        option_bucket = str(app_options.get("storageBucket", "")).strip()
        if option_bucket:
            return option_bucket
    except Exception:
        pass

    # 3) Parse from the persisted download_url:
    #    https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<path>?token=…
    try:
        download_url = str(attachment_doc.get("download_url", ""))
        marker = "/v0/b/"
        if marker in download_url:
            tail = download_url.split(marker, 1)[1]
            parsed = tail.split("/", 1)[0].strip()
            if parsed:
                return parsed
    except Exception:
        pass

    return ""


@bp.get("/api/tickets/<ticket_id>/attachments/<attachment_id>/download")
@require_auth
def download_ticket_attachment(ticket_id: str, attachment_id: str):
    """Stream a ticket attachment to the browser with role-based access control."""
    uid = g.uid
    db = get_firestore_db()
    started_at = time.perf_counter()

    def mark_timing(step: str) -> None:
        elapsed_ms = round((time.perf_counter() - started_at) * 1000, 1)
        logger.info(
            "download_ticket_attachment timing",
            ticket_id=ticket_id,
            attachment_id=attachment_id,
            step=step,
            elapsed_ms=elapsed_ms,
        )

    try:
        ticket_ref = db.collection("tickets").document(ticket_id)
        ticket_doc = ticket_ref.get()
        if not ticket_doc.exists:
            return jsonify({"error": "Ticket not found"}), 404
        mark_timing("ticket lookup done")

        ticket_data = ticket_doc.to_dict() or {}
        created_by_uid = _resolve_ticket_owner_uid(ticket_data)
        if not can_view_ticket(uid, created_by_uid):
            return jsonify({"error": "Permission denied"}), 403

        attachment_ref = ticket_ref.collection("attachments").document(attachment_id)
        attachment_doc = attachment_ref.get()
        if not attachment_doc.exists:
            return jsonify({"error": "Attachment not found"}), 404
        mark_timing("attachment lookup done")

        attachment    = attachment_doc.to_dict() or {}
        storage_path  = str(attachment.get("storage_path", ""))
        download_url  = str(attachment.get("download_url", ""))
        file_name     = str(attachment.get("name", "attachment"))
        content_type  = str(attachment.get("content_type", "application/octet-stream"))
        file_size     = attachment.get("size", 0)

        if not storage_path and not download_url:
            return jsonify({"error": "Invalid attachment metadata"}), 400

        bucket_name = _resolve_bucket_name(attachment)
        file_bytes  = b""

        # Primary: read directly from Firebase Storage SDK.
        if bucket_name and storage_path:
            bucket = storage.bucket(bucket_name)
            blob = bucket.blob(storage_path)
            if blob.exists():
                file_bytes = blob.download_as_bytes()
                mark_timing("storage sdk download done")

        # Fallback: fetch via persisted signed URL.
        if not file_bytes and download_url:
            with urlopen(download_url, timeout=20) as resp:
                file_bytes = resp.read()
            mark_timing("signed url download done")

        if not file_bytes:
            return jsonify({"error": "Attachment file not found"}), 404

        try:
            log_action(
                uid=uid,
                action="download_attachment",
                resource_type="ticket",
                resource_id=ticket_id,
                details={
                    "attachment_id": attachment_id,
                    "file_name":     file_name,
                    "file_size":     file_size,
                    "content_type":  content_type,
                },
                status="success",
            )
            mark_timing("audit done")
        except Exception as audit_err:
            logger.warning("Failed to write download audit log", exc_info=audit_err)

        encoded_name = quote(file_name)
        headers = {
            "Content-Disposition": (
                f'attachment; filename="{file_name}"; '
                f"filename*=UTF-8''{encoded_name}"
            ),
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        }
        mark_timing("response done")
        return Response(file_bytes, headers=headers, mimetype=content_type)

    except Exception as exc:
        logger.error(
            "download_ticket_attachment error",
            ticket_id=ticket_id,
            attachment_id=attachment_id,
            exc_info=exc,
        )
        traceback.print_exc()
        return jsonify({"error": "Failed to download attachment"}), 500
