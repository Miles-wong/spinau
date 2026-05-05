"""Admin-only data export routes.

Endpoints
---------
GET /api/admin/exports/tickets.csv
    Export all tickets as CSV for admin audit/archive usage.

Notes
-----
- This endpoint is intentionally separate from AG Grid export.
- AG Grid export serves current table views; this endpoint serves full admin export.
"""

import csv
import io
from datetime import datetime, timezone
from typing import Any

from flask import Blueprint, Response, g, jsonify, request, stream_with_context

from backend_app.services.firestore_service import get_firestore_db, get_user_role, log_action
from backend_app.core.logger import get_logger
from backend_app.api.middleware.auth import require_auth

logger = get_logger(__name__)
bp = Blueprint("admin_exports", __name__)

BASE_EXPORT_FIELDS = [
    "ticket_id",
    "issue_type",
    "category",
    "category_other_text",
    "severity",
    "status",
    "created_by_uid",
    "assigned_to_uid",
    "created_at",
    "updated_at",
    "noticed_time",
    "incident_active",
    "response_taken",
    "response_details",
    "location_type",
    "location_detail",
    "description",
    "impact_scope",
    "work_continuity",
    "affected_asset",
    "error_symptom",
    "data_involved_flag",
    "data_involved",
    "data_other_text",
    "external_party_involved",
    "external_party_details",
    "already_reported_to_it",
    "reported_to_details",
    "preferred_contact_method",
    "phone_number",
    "contact_email",
]

INTERNAL_EXPORT_FIELDS = [
    "updated_by_uid",
    "closure_summary",
    "lessons_learned",
    "closed_at",
    "closed_by_uid",
    "duplicate_of_ticket_id",
    "related_ticket_ids",
    "last_update_hint",
]


def _to_iso(value: Any) -> str:
    """Convert Firestore/native date-ish values to ISO-8601 text when possible."""
    if value is None:
        return ""

    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()

    # Firestore python Timestamp supports to_datetime()
    to_datetime = getattr(value, "to_datetime", None)
    if callable(to_datetime):
        try:
            dt = to_datetime()
            if isinstance(dt, datetime):
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt.isoformat()
        except Exception:
            pass

    return str(value)


def _to_csv_scalar(value: Any) -> str:
    """Normalize arbitrary Firestore values into CSV-safe scalars."""
    if value is None:
        return ""

    if isinstance(value, (list, tuple, set)):
        return " | ".join(_to_csv_scalar(v) for v in value)

    if isinstance(value, dict):
        parts = []
        for k in sorted(value.keys()):
            parts.append(f"{k}={_to_csv_scalar(value[k])}")
        return " ; ".join(parts)

    return _to_iso(value)


@bp.get("/api/admin/exports/tickets.csv")
@require_auth
def export_all_tickets_csv():
    """Export all tickets to CSV (admin-only)."""
    uid = g.uid

    role = get_user_role(uid)
    if role != "admin":
        return jsonify({"error": "Permission denied"}), 403

    include_internal = str(
        request.args.get("include_internal", "1")
    ).strip().lower() not in {
        "0",
        "false",
        "no",
    }

    fields = BASE_EXPORT_FIELDS + (INTERNAL_EXPORT_FIELDS if include_internal else [])

    try:
        db = get_firestore_db()
        docs = db.collection("tickets").stream()
        ip_address = request.remote_addr
        user_agent = request.headers.get("User-Agent", "")

        def generate_csv():
            exported_count = 0
            yield "\ufeff"

            header_buffer = io.StringIO()
            writer = csv.DictWriter(
                header_buffer, fieldnames=fields, extrasaction="ignore"
            )
            writer.writeheader()
            yield header_buffer.getvalue()
            header_buffer.close()

            try:
                for doc in docs:
                    data = doc.to_dict() or {}
                    row = {field: _to_csv_scalar(data.get(field)) for field in fields}
                    if not row.get("ticket_id"):
                        row["ticket_id"] = doc.id

                    row_buffer = io.StringIO()
                    row_writer = csv.DictWriter(
                        row_buffer, fieldnames=fields, extrasaction="ignore"
                    )
                    row_writer.writerow(row)
                    yield row_buffer.getvalue()
                    row_buffer.close()
                    exported_count += 1

                log_action(
                    uid=uid,
                    action="admin_export_tickets",
                    resource_type="ticket",
                    resource_id="all",
                    details={
                        "format": "csv",
                        "scope": "all_tickets",
                        "include_internal": include_internal,
                        "exported_count": exported_count,
                    },
                    status="success",
                    ip_address=ip_address,
                    user_agent=user_agent,
                )
            except Exception as stream_exc:
                logger.error(
                    "admin full export stream failed", uid=uid, exc_info=stream_exc
                )
                log_action(
                    uid=uid,
                    action="admin_export_tickets",
                    resource_type="ticket",
                    resource_id="all",
                    details={
                        "format": "csv",
                        "scope": "all_tickets",
                        "include_internal": include_internal,
                        "exported_count_partial": exported_count,
                    },
                    status="failed",
                    error_message=str(stream_exc),
                    ip_address=ip_address,
                    user_agent=user_agent,
                )
                raise

        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        filename = f"admin-full-tickets-{stamp}.csv"
        headers = {
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        }
        return Response(
            stream_with_context(generate_csv()),
            headers=headers,
            mimetype="text/csv; charset=utf-8",
        )

    except Exception as exc:
        logger.error("admin full export failed", uid=uid, exc_info=exc)
        log_action(
            uid=uid,
            action="admin_export_tickets",
            resource_type="ticket",
            resource_id="all",
            details={
                "format": "csv",
                "scope": "all_tickets",
                "include_internal": include_internal,
            },
            status="failed",
            error_message=str(exc),
            ip_address=request.remote_addr,
            user_agent=request.headers.get("User-Agent", ""),
        )
        return jsonify({"error": "Failed to export tickets"}), 500
