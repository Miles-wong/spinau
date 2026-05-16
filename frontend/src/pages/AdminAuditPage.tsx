/**
 * AdminAuditPage.tsx - Admin audit log viewer.
 *
 * Displays a reverse-chronological list of all audit_logs Firestore documents.
 * Uses localStorage (AUDIT_SEEN_KEY) to track which logs have been read
 * so that the notification badge in Layout can count unseen entries.
 *
 * ACTION_LABELS maps internal action strings to user-friendly display names.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { UserInfo } from "../types/auth";
import Layout from "../components/Layout";
import { getAuditLogs } from "../services/AuditService";
import { resolveUserLabels } from "../services/AuthService";
import { getTicketDetail } from "../services/TicketService";
import type { AuditLog } from "../services/ServiceTypes";
import { useToast } from "../components/toastContext";
import { trackUxEvent } from "../services/uxTelemetry";
import { toUserFacingMessage } from "../services/userFacingMessage";

const AUDIT_SEEN_KEY = "cyber_audit_last_seen";

const ACTION_LABELS: Record<string, string> = {
  create_ticket: "Ticket Created",
  add_comment: "Comment Added",
  add_attachment: "Attachment Uploaded",
  download_attachment: "Attachment Downloaded",
  update_ticket_status: "Status Updated",
  admin_update_ticket: "Admin Edited",
  log_ticket_created: "Ticket Logged",
};

const ACTION_COLORS: Record<string, string> = {
  create_ticket: "bg-emerald-600",
  add_comment: "bg-blue-600",
  add_attachment: "bg-amber-600",
  download_attachment: "bg-cyan-600",
  update_ticket_status: "bg-purple-600",
  admin_update_ticket: "bg-indigo-600",
  log_ticket_created: "bg-emerald-600",
};

type SortOrder = "newest" | "oldest";
type TimeRange = "all" | "today" | "7d" | "30d";
const PAGE_SIZE_OPTIONS = [20, 50, 100];

function asList(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => String(v ?? "")).filter(Boolean).join(", ");
  return String(value ?? "-");
}

function asText(value: unknown, fallback = "-"): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return fallback;
}

function toCsvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

/** Renders the detail section for a log card (no category/severity badges — those live in the card header). */
function renderDetails(action: string, details: Record<string, unknown>) {
  if (action === "admin_update_ticket") {
    const changes = typeof details.changes === "object" && details.changes
      ? Object.entries(details.changes as Record<string, { before: unknown; after: unknown }>)
      : [];

    const changedFields = Array.isArray(details.changed_fields)
      ? (details.changed_fields as string[])
      : changes.map(([k]) => k);

    return (
      <div className="mt-3 space-y-2">
        {changes.length > 0 ? (
          <div className="overflow-hidden rounded-lg border border-slate-200 text-xs">
            <div className="grid grid-cols-3 bg-slate-100 px-3 py-1.5 font-semibold text-slate-600">
              <span>Field</span><span className="text-red-600">Before</span><span className="text-emerald-700">After</span>
            </div>
            {changes.map(([key, val]) => {
              const v = val as { before: unknown; after: unknown };
              return (
                <div key={key} className="grid grid-cols-3 border-t border-slate-100 px-3 py-1.5 text-slate-700">
                  <span className="font-medium">{key.replaceAll("_", " ")}</span>
                  <span className="text-red-600">{Array.isArray(v?.before) ? asList(v.before) : asText(v?.before)}</span>
                  <span className="text-emerald-700">{Array.isArray(v?.after) ? asList(v.after) : asText(v?.after)}</span>
                </div>
              );
            })}
          </div>
        ) : changedFields.length > 0 ? (
          <div className="rounded-lg bg-slate-50 px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-slate-400">Changed fields</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {changedFields.map((f) => (
                <span key={f} className="rounded-full bg-indigo-50 px-2 py-1 text-xs font-semibold text-indigo-700">{f.replaceAll("_", " ")}</span>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  if (!details || Object.keys(details).length === 0) return null;

  return (
    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
      {Object.entries(details)
        .filter(([key]) => !["category", "severity"].includes(key))
        .map(([key, value]) => (
          <div key={key} className="rounded-lg bg-slate-50 px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-slate-400">{key.replaceAll("_", " ")}</div>
            <div className="mt-1 break-words text-sm text-slate-800">
              {Array.isArray(value) ? (value as unknown[]).join(", ") : String(value ?? "-")}
            </div>
          </div>
        ))}
    </div>
  );
}

type AdminAuditPageProps = {
  user: UserInfo;
  role: "admin";
  onLogout: () => void;
};

export default function AdminAuditPage({ user, role, onLogout }: AdminAuditPageProps) {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [keyword, setKeyword] = useState("");
  const [userLabels, setUserLabels] = useState<Record<string, string>>({});
  const [ticketMeta, setTicketMeta] = useState<Record<string, { category?: string; severity?: string }>>({});
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [actorFilter, setActorFilter] = useState<string>("all");
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
  const [pageSize, setPageSize] = useState<number>(20);
  const [currentPage, setCurrentPage] = useState<number>(1);

  const [newBeforeMs] = useState<number>(() =>
    Number(localStorage.getItem(AUDIT_SEEN_KEY) || 0)
  );

  const loadAuditLogs = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await getAuditLogs(400);
      setLogs(data);

      const uidSet = new Set<string>();
      const ticketIds = new Set<string>();
      data.forEach((log) => {
        if (log.actor_email) uidSet.add(String(log.actor_email));
        if (log.resource_id) ticketIds.add(String(log.resource_id));
      });

      const labels = await resolveUserLabels([...uidSet]);
      setUserLabels(labels);

      // Batch-resolve ticket category+severity
      const metaMap: Record<string, { category?: string; severity?: string }> = {};
      await Promise.allSettled(
        [...ticketIds].map(async (tid) => {
          try {
            const t = await getTicketDetail(tid) as Record<string, unknown>;
            metaMap[tid] = {
              category: t.category ? String(t.category) : undefined,
              severity: t.severity ? String(t.severity) : undefined,
            };
          } catch {
            // ignore missing tickets
          }
        })
      );
      setTicketMeta(metaMap);
    } catch (err) {
      const message = toUserFacingMessage(err, {
        fallback: "Unable to load audit logs right now. Please try again.",
      });
      setError(message);
      showToast({
        type: "error",
        title: "Audit logs failed to load.",
        message,
        action: {
          label: "Retry",
          onClick: () => {
            void loadAuditLogs();
          },
        },
      });
      trackUxEvent("admin_audit_load_failed", {
        page: "admin_audit",
        action: "load",
        outcome: "error",
        message,
      });
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void loadAuditLogs();
  }, [loadAuditLogs]);

  const filteredLogs = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    const now = Date.now();

    const rangeStartMs = (() => {
      if (timeRange === "today") {
        const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime();
      }
      if (timeRange === "7d") return now - 7 * 24 * 60 * 60 * 1000;
      if (timeRange === "30d") return now - 30 * 24 * 60 * 60 * 1000;
      return 0;
    })();

    const next = logs.filter((log) => {
      if (actionFilter !== "all" && String(log.action || "") !== actionFilter) return false;
      if (actorFilter !== "all" && String(log.actor_email || "") !== actorFilter) return false;
      const createdMs = Date.parse(String(log.created_at || ""));
      if (rangeStartMs > 0 && (isNaN(createdMs) || createdMs < rangeStartMs)) return false;
      if (!key) return true;
      const actorLabel = userLabels[String(log.actor_email || "")] || String(log.actor_email || "");
      const haystack = [String(log.action || ""), String(log.actor_email || ""), actorLabel, String(log.resource_id || ""), JSON.stringify(log.details || {})].join(" ").toLowerCase();
      return haystack.includes(key);
    });

    next.sort((a, b) => {
      const av = Date.parse(String(a.created_at || "")) || 0;
      const bv = Date.parse(String(b.created_at || "")) || 0;
      return sortOrder === "newest" ? bv - av : av - bv;
    });

    return next;
  }, [keyword, logs, sortOrder, actionFilter, actorFilter, timeRange, userLabels]);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(filteredLogs.length / pageSize)),
    [filteredLogs.length, pageSize]
  );

  const pagedLogs = useMemo(() => {
    const safePage = Math.min(currentPage, totalPages);
    const start = (safePage - 1) * pageSize;
    return filteredLogs.slice(start, start + pageSize);
  }, [filteredLogs, currentPage, totalPages, pageSize]);

  useEffect(() => {
    setCurrentPage(1);
  }, [keyword, sortOrder, actionFilter, actorFilter, timeRange, pageSize]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  // Stats
  const stats = useMemo(() => {
    const now = Date.now();
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();
    const weekMs = now - 7 * 24 * 60 * 60 * 1000;

    const todayCount = logs.filter((l) => {
      const ms = Date.parse(String(l.created_at || ""));
      return !isNaN(ms) && ms >= todayMs;
    }).length;

    const weekCount = logs.filter((l) => {
      const ms = Date.parse(String(l.created_at || ""));
      return !isNaN(ms) && ms >= weekMs;
    }).length;

    const avgPerDay = weekCount > 0 ? (weekCount / 7).toFixed(1) : "0.0";

    return { total: logs.length, todayCount, weekCount, avgPerDay };
  }, [logs]);

  const actionOptions = useMemo(() => [...new Set(logs.map((l) => String(l.action || "unknown")))].sort(), [logs]);
  const actorOptions = useMemo(() => [...new Set(logs.map((l) => String(l.actor_email || "")).filter(Boolean))].sort(), [logs]);

  const isNew = (log: AuditLog): boolean => {
    if (!newBeforeMs) return false;
    const parsed = Date.parse(String(log.created_at || ""));
    return !isNaN(parsed) && parsed > newBeforeMs;
  };

  const handleExportCsv = useCallback(() => {
    if (filteredLogs.length === 0) {
      showToast({
        type: "info",
        title: "No records to export",
        message: "Adjust filters or load audit logs first.",
      });
      return;
    }

    const headers = [
      "timestamp",
      "action_key",
      "action_label",
      "status",
      "actor_email",
      "actor_name",
      "ticket_id",
      "category",
      "severity",
      "details_json",
    ];

    const lines = filteredLogs.map((log) => {
      const actionKey = String(log.action || "");
      const actorEmail = String(log.actor_email || "");
      const ticketId = String(log.resource_id || "");
      const meta = ticketMeta[ticketId] || {};
      const detailsJson = JSON.stringify(log.details || {});

      return [
        log.created_at ? new Date(String(log.created_at)).toISOString() : "",
        actionKey,
        ACTION_LABELS[actionKey] || actionKey,
        String(log.status || "success"),
        actorEmail,
        userLabels[actorEmail] || actorEmail,
        ticketId,
        meta.category || "",
        meta.severity || "",
        detailsJson,
      ].map(toCsvCell).join(",");
    });

    const csv = [headers.map(toCsvCell).join(","), ...lines].join("\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const fileName = `audit-logs-${y}${m}${d}-${hh}${mm}.csv`;

    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [filteredLogs, showToast, ticketMeta, userLabels]);

  return (
    <Layout user={user} role={role} onLogout={onLogout}>
      <div className="page-content space-y-4">
        {/* Stats bar — 4 tiles */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <div className="card p-4">
            <div className="metric-tile-label">Total records</div>
            <div className="metric-tile-value">{stats.total}</div>
          </div>
          <div className="card p-4">
            <div className="metric-tile-label">Actions today</div>
            <div className="metric-tile-value">{stats.todayCount}</div>
          </div>
          <div className="card p-4">
            <div className="metric-tile-label">New this week</div>
            <div className="metric-tile-value">{stats.weekCount}</div>
          </div>
          <div className="card p-4">
            <div className="metric-tile-label">Avg / day (7d)</div>
            <div className="metric-tile-value">{stats.avgPerDay}</div>
          </div>
        </div>

        {/* Filters — single inline row */}
        <div className="card p-3">
          <div className="flex flex-wrap gap-2 items-center">
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="Search action, actor, ticket ID..."
              className="min-w-[200px] flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
            <select value={sortOrder} onChange={(e) => setSortOrder(e.target.value as SortOrder)} className="toolbar-select rounded-md border border-slate-300 px-3 py-2 text-sm">
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
            <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} className="toolbar-select rounded-md border border-slate-300 px-3 py-2 text-sm">
              <option value="all">All actions</option>
              {actionOptions.map((action) => (
                <option key={action} value={action}>{ACTION_LABELS[action] || action.replaceAll("_", " ")}</option>
              ))}
            </select>
            <select value={actorFilter} onChange={(e) => setActorFilter(e.target.value)} className="toolbar-select rounded-md border border-slate-300 px-3 py-2 text-sm">
              <option value="all">All actors</option>
              {actorOptions.map((actorEmail) => (
                <option key={actorEmail} value={actorEmail}>{userLabels[actorEmail] || actorEmail}</option>
              ))}
            </select>
            <select value={timeRange} onChange={(e) => setTimeRange(e.target.value as TimeRange)} className="toolbar-select rounded-md border border-slate-300 px-3 py-2 text-sm">
              <option value="all">All time</option>
              <option value="today">Today</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
            </select>
            <select
              value={String(pageSize)}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="toolbar-select rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>{size} / page</option>
              ))}
            </select>
            <button
              onClick={handleExportCsv}
              className="toolbar-button rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
            >
              Export CSV
            </button>
            {(keyword || actionFilter !== "all" || actorFilter !== "all" || timeRange !== "all") && (
              <button
                onClick={() => { setKeyword(""); setActionFilter("all"); setActorFilter("all"); setTimeRange("all"); }}
                className="toolbar-button rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        <div className="text-sm text-slate-500">
          {loading
            ? "Loading audit logs..."
            : `Showing ${pagedLogs.length} on page ${Math.min(currentPage, totalPages)} / ${totalPages} (${filteredLogs.length} filtered, ${logs.length} total)`}
        </div>

        {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        {!loading && filteredLogs.length === 0 && !error && (
          <div className="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-600">No audit records found.</div>
        )}

        {!loading && filteredLogs.length > 0 && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage <= 1}
              className="toolbar-button rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Prev
            </button>
            <span className="text-sm text-slate-600">
              Page {Math.min(currentPage, totalPages)} of {totalPages}
            </span>
            <button
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage >= totalPages}
              className="toolbar-button rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Next
            </button>
          </div>
        )}

        <div className="space-y-3">
          {pagedLogs.map((log) => {
            const action = String(log.action || "unknown");
            const badgeColor = ACTION_COLORS[action] || "bg-slate-700";
            const label = ACTION_LABELS[action] || action.replaceAll("_", " ");
            const actor = userLabels[String(log.actor_email || "")] || String(log.actor_email || "-");
            const ticketId = String(log.resource_id || "");
            const canNavigate = Boolean(ticketId && ticketId !== "-");
            const newEntry = isNew(log);
            const meta = ticketMeta[ticketId];
            const cardClass = `rounded-xl border bg-white p-4 shadow-sm transition ${newEntry ? "border-blue-300 ring-1 ring-blue-200" : "border-slate-200"} ${canNavigate ? "cursor-pointer hover:border-blue-300 hover:shadow" : ""}`;

            return (
              <div
                key={log.id}
                id={log.id}
                onClick={() => { if (canNavigate) navigate(`/admin/tickets/${ticketId}`); }}
                className={cardClass}
                title={canNavigate ? "Open related ticket" : ""}
                role={canNavigate ? "button" : undefined}
              >
                {/* Card header row — action badge + category/severity + status */}
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded px-2 py-1 text-xs font-semibold text-white ${badgeColor}`}>{label}</span>
                  {newEntry && <span className="rounded bg-blue-100 px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-blue-700">NEW</span>}
                  {meta?.category && <span className="badge badge-secondary">{meta.category}</span>}
                  {meta?.severity && <span className={`badge badge-${meta.severity}`}>{meta.severity}</span>}
                  <span className={`ml-auto rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${String(log.status || "success") === "success" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
                    {String(log.status || "success")}
                  </span>
                </div>

                {/* Meta row */}
                <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500">
                  <span><span className="font-medium text-slate-700">Actor:</span> {actor}</span>
                  {ticketId && <span className="font-medium text-blue-600">Ticket: {ticketId}</span>}
                  <span><span className="font-medium text-slate-700">Time:</span> {log.created_at ? new Date(String(log.created_at)).toLocaleString() : "-"}</span>
                </div>

                {/* Detail section — no category/severity duplication */}
                {renderDetails(action, (log.details || {}) as Record<string, unknown>)}
              </div>
            );
          })}
        </div>
      </div>
    </Layout>
  );
}
