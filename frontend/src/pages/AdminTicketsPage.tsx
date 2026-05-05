import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AgGridReact } from "ag-grid-react";
import type {
  ColDef,
  GridReadyEvent,
  GridApi,
  ICellRendererParams,
} from "ag-grid-community";
import { ModuleRegistry, AllCommunityModule } from "ag-grid-community";
import {
  RowGroupingModule,
  MasterDetailModule,
  ExcelExportModule,
} from "ag-grid-enterprise";

import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-quartz.css";

import type { UserInfo } from "../types/auth";
import Layout from "../components/Layout";
import { claimTicket, getTickets } from "../services/TicketService";
import { resolveUserLabels } from "../services/AuthService";
import { downloadFullAdminTicketsExport, saveBlobToFile } from "../services/ExportService";
import { useToast } from "../components/toastContext";
import { trackUxEvent } from "../services/uxTelemetry";
import { toUserFacingMessage } from "../services/userFacingMessage";
import "./AdminTicketsPage.css";

ModuleRegistry.registerModules([
  AllCommunityModule,
  RowGroupingModule,
  MasterDetailModule,
  ExcelExportModule,
]);

const fmt = (v: unknown) =>
  String(v ?? "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase()) || "Unassigned";

const formatDateTimeShort = (value: unknown) => {
  const raw = String(value ?? "").trim();
  if (!raw) return "Unassigned";

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;

  // Keep grid dates compact but preserve time for fast triage scanning.
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${minute}`;
};

type TicketRow = {
  id: string;
  ticket_id: string;
  issue_type?: string;
  intake_mode?: string;
  status: string;
  severity: string;
  category: string;
  location_type?: string;
  location_detail?: string;
  description?: string;
  created_at: string;
  updated_at: string;
  attachment_count?: number;
  attachments_count?: number;
  latest_comment?: unknown;
  last_comment?: unknown;
  assigned_to_uid: string;
  created_by_uid: string;
};

type AdminTicketsPageProps = {
  user: UserInfo;
  role: "admin";
  onLogout: () => void;
};

const PAGE_SIZE_OPTIONS = [10, 15, 25, 50];
const FETCH_BATCH_SIZE = 200;
const MAX_FETCH_ROWS = 1000;
const CORE_EXPORT_COLUMN_IDS = [
  "ticket_id",
  "issue_type",
  "category",
  "severity",
  "status",
  "created_by_uid",
  "created_at",
  "location",
  "assigned_to_uid",
  "updated_at",
] as const;
const OPTIONAL_EXPORT_COLUMN_IDS = ["short_description", "age"] as const;

function statusBadge(s: string) {
  const key = (s || "").toLowerCase();
  const cls = `badge badge-${
    key === "open"
      ? "open"
      : key === "assigned"
        ? "assigned"
        : key === "investigating"
          ? "investigating"
          : key === "resolved"
            ? "resolved"
            : "closed"
  }`;
  return <span className={cls}>{s || "Unassigned"}</span>;
}

function severityBadge(s: string) {
  const key = (s || "").toLowerCase();
  const cls = `badge badge-${
    ["critical", "high", "medium", "low"].includes(key) ? key : "secondary"
  }`;
  return <span className={cls}>{s || "Unassigned"}</span>;
}

type BadgeRendererProps = { value: string };
const StatusBadgeRenderer = (props: BadgeRendererProps) => statusBadge(props.value);
const SeverityBadgeRenderer = (props: BadgeRendererProps) => severityBadge(props.value);

const IntakeModeRenderer = (props: BadgeRendererProps) => {
  const mode = String(props.value || "").toLowerCase();
  if (mode === "fast") {
    return <span className="intake-mode-chip intake-mode-fast" title="Fast submission mode">FAST</span>;
  }
  return <span className="intake-mode-chip intake-mode-standard" title="Standard submission mode">STANDARD</span>;
};

const shortText = (value: unknown, maxLen: number = 90) => {
  const text = String(value ?? "").trim();
  if (!text) return "Unassigned";
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
};

const toEpochMs = (value: unknown): number | null => {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isNaN(parsed) ? null : parsed;
};

const formatAge = (createdAt: unknown) => {
  const createdMs = toEpochMs(createdAt);
  if (!createdMs) return "Unassigned";

  const diff = Math.max(0, Date.now() - createdMs);
  const totalHours = Math.floor(diff / 3600000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;

  if (days > 0) {
    return `${days} day${days === 1 ? "" : "s"}, ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${hours} hour${hours === 1 ? "" : "s"}`;
};

const formatLocation = (row: TicketRow) => {
  const locationType = String(row.location_type ?? "").trim();
  const locationDetail = String(row.location_detail ?? "").trim();
  if (!locationType && !locationDetail) return "Unassigned";
  if (!locationType) return locationDetail;
  if (!locationDetail) return fmt(locationType);
  return `${fmt(locationType)} - ${locationDetail}`;
};

const getLatestCommentSummary = (row: TicketRow) => {
  const candidate = row.latest_comment ?? row.last_comment;
  if (typeof candidate === "string") {
    return shortText(candidate, 80);
  }
  if (candidate && typeof candidate === "object") {
    const record = candidate as Record<string, unknown>;
    const text =
      record.text ??
      record.content ??
      record.comment ??
      record.message;
    if (typeof text === "string") {
      return shortText(text, 80);
    }
  }
  return "No comments yet";
};

const getAttachmentCount = (row: TicketRow) => {
  if (typeof row.attachment_count === "number") return row.attachment_count;
  if (typeof row.attachments_count === "number") return row.attachments_count;
  return 0;
};

function DetailPanel(props: ICellRendererParams<TicketRow>) {
  const row = props.data;
  if (!row) return null;

  const context = (props.context || {}) as {
    navigate?: (path: string) => void;
    userLabels?: Record<string, string>;
    claimTicket?: (ticketId: string) => void;
  };
  const userLabels = context.userLabels || {};
  const reportedBy = userLabels[row.created_by_uid] || row.created_by_uid || "Unassigned";
  const assignedTo = userLabels[row.assigned_to_uid] || row.assigned_to_uid || "Unassigned";

  return (
    <div
      style={{
        padding: 16,
        background: "#f9fafb",
        borderLeft: "4px solid #cbd5e1",
        margin: "6px 12px",
        borderRadius: 8,
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <div>
          <strong>Description:</strong>
          <div
            style={{
              marginTop: 4,
              whiteSpace: "normal",
              wordBreak: "break-word",
              overflowWrap: "anywhere",
              lineHeight: 1.45,
            }}
          >
            {shortText(row.description, Number.MAX_SAFE_INTEGER)}
          </div>
        </div>
        <div>
          <strong>Reported By:</strong> {reportedBy}
        </div>
        <div>
          <strong>Assigned To:</strong> {assignedTo}
        </div>
        <div>
          <strong>Attachments:</strong> {getAttachmentCount(row)}
        </div>
        <div>
          <strong>Latest Comment:</strong> {getLatestCommentSummary(row)}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          onClick={() => context.navigate?.(`/admin/tickets/${row.id}`)}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
        >
          Open Full Detail
        </button>
        {!String(row.assigned_to_uid || "").trim() && (
          <button
            type="button"
            onClick={() => context.claimTicket?.(row.id)}
            className="claim-btn"
          >
            Claim
          </button>
        )}
      </div>
    </div>
  );
}

export default function AdminTicketsPage({
  user,
  role,
  onLogout,
}: AdminTicketsPageProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { showToast } = useToast();

  const [rows, setRows] = useState<TicketRow[]>([]);
  const [userLabels, setUserLabels] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState("");

  const [activeFilter, setActiveFilter] =
    useState<"all" | "opening" | "finished" | "highRisk" | "unassigned">("all");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [issueTypeFilter, setIssueTypeFilter] = useState("all");
  const [intakeModeFilter, setIntakeModeFilter] = useState("all");
  const [statusGroupFilter, setStatusGroupFilter] =
    useState<"all" | "finished">("all");
  const [severityGroupFilter, setSeverityGroupFilter] =
    useState<"all" | "criticalHigh">("all");
  const [updatedWithinDays, setUpdatedWithinDays] = useState<number | null>(null);

  const [gridApi, setGridApi] = useState<GridApi | null>(null);
  const [pageSize, setPageSize] = useState(15);
  const [groupField, setGroupField] = useState<"none" | "status" | "severity" | "category">("none");
  const [isFullExporting, setIsFullExporting] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const clickTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!exportMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [exportMenuOpen]);

  useEffect(() => {
    const prefilter = searchParams.get("prefilter");
    const status = searchParams.get("status");
    const severity = searchParams.get("severity");
    const category = searchParams.get("category");
    const issueType = searchParams.get("issue_type");
    const intakeMode = searchParams.get("intakeMode");
    const statusGroup = searchParams.get("statusGroup");
    const severityGroup = searchParams.get("severityGroup");
    const updatedDaysRaw = searchParams.get("updatedWithinDays");
    const q = searchParams.get("q");

    const updatedDays = updatedDaysRaw ? Number(updatedDaysRaw) : null;

    setActiveFilter(
      prefilter === "all" ||
        prefilter === "opening" ||
        prefilter === "finished" ||
        prefilter === "highRisk" ||
        prefilter === "unassigned"
        ? prefilter
        : "all"
    );
    setStatusFilter(status ? status.toLowerCase() : "all");
    setSeverityFilter(severity ? severity.toLowerCase() : "all");
    setCategoryFilter(category || "all");
    setIssueTypeFilter(issueType || "all");
    setIntakeModeFilter(intakeMode || "all");
    setStatusGroupFilter(statusGroup === "finished" ? "finished" : "all");
    setSeverityGroupFilter(
      severityGroup === "criticalHigh" ? "criticalHigh" : "all"
    );
    setUpdatedWithinDays(updatedDays && !Number.isNaN(updatedDays) ? updatedDays : null);
    setSearch(q || "");
  }, [searchParams]);

  const loadTickets = useCallback(async () => {
    setLoading(true);
    setErrMsg("");

    try {
      const collectedRows: TicketRow[] = [];
      let cursor: Awaited<ReturnType<typeof getTickets>>["nextCursor"] = null;
      let hasMore = true;

      while (hasMore && collectedRows.length < MAX_FETCH_ROWS) {
        const response = await getTickets({
          pageSize: FETCH_BATCH_SIZE,
          cursor,
        });

        const batch = (response.rows || []) as TicketRow[];
        collectedRows.push(...batch);

        hasMore = Boolean(response.hasMore);
        cursor = response.nextCursor;

        if (!response.nextCursor) break;
      }

      const nextRows = collectedRows.slice(0, MAX_FETCH_ROWS);
      setRows(nextRows);

      const uidSet = new Set<string>();
      nextRows.forEach((r) => {
        if (r.created_by_uid) uidSet.add(r.created_by_uid);
        if (r.assigned_to_uid) uidSet.add(r.assigned_to_uid);
      });

      const labels = await resolveUserLabels([...uidSet]);
      setUserLabels(labels);
    } catch (e) {
      const msg = toUserFacingMessage(e, {
        fallback: "Unable to load tickets right now. Please try again.",
      });

      setErrMsg(msg);
      setRows([]);

      showToast({
        type: "error",
        title: "Ticket list failed to load.",
        message: msg,
        action: {
          label: "Retry",
          onClick: () => {
            void loadTickets();
          },
        },
      });

      trackUxEvent("admin_tickets_load_failed", {
        page: "admin_tickets",
        action: "load",
        outcome: "error",
        message: msg,
      });
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void loadTickets();
  }, [loadTickets]);

  useEffect(() => {
    return () => {
      if (clickTimerRef.current) {
        window.clearTimeout(clickTimerRef.current);
      }
    };
  }, []);

  const uniqueCategories = useMemo(
    () => [...new Set(rows.map((r) => r.category).filter(Boolean))].sort(),
    [rows]
  );

  const filtered = useMemo(() => {
    const OPENING = new Set(["open", "assigned", "investigating", "opening"]);
    const FINISHED = new Set(["resolved", "closed", "finished"]);
    const HIGH_RISK = new Set(["high", "critical", "medium", "medium-high"]);

    return rows.filter((r) => {
      const st = (r.status || "").toLowerCase();
      const sv = (r.severity || "").toLowerCase();
      const updatedMs = Date.parse(String(r.updated_at || ""));

      if (activeFilter === "opening" && !OPENING.has(st)) return false;
      if (activeFilter === "finished" && !FINISHED.has(st)) return false;
      if (activeFilter === "highRisk" && !HIGH_RISK.has(sv)) return false;
      if (activeFilter === "unassigned" && String(r.assigned_to_uid || "").trim()) return false;

      if (statusGroupFilter === "finished" && !FINISHED.has(st)) return false;
      if (
        severityGroupFilter === "criticalHigh" &&
        !["critical", "high"].includes(sv)
      ) {
        return false;
      }

      if (updatedWithinDays !== null) {
        const cutoff = Date.now() - updatedWithinDays * 86400000;
        if (Number.isNaN(updatedMs) || updatedMs < cutoff) return false;
      }

      if (statusFilter !== "all" && st !== statusFilter) return false;
      if (severityFilter !== "all" && sv !== severityFilter) return false;
      if (categoryFilter !== "all" && r.category !== categoryFilter) return false;
      if (issueTypeFilter !== "all" && (r.issue_type || "cyber").toLowerCase() !== issueTypeFilter) return false;
      if (intakeModeFilter !== "all" && (r.intake_mode || "").toLowerCase() !== intakeModeFilter.toLowerCase()) return false;

      const q = search.trim().toLowerCase();
      if (!q) return true;

      const creator = userLabels[r.created_by_uid] || r.created_by_uid || "";
      const assignee = userLabels[r.assigned_to_uid] || r.assigned_to_uid || "";

      return [r.ticket_id, r.issue_type, r.category, r.status, r.severity, creator, assignee]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [
    rows,
    activeFilter,
    statusFilter,
    severityFilter,
    categoryFilter,
    issueTypeFilter,
    intakeModeFilter,
    statusGroupFilter,
    severityGroupFilter,
    updatedWithinDays,
    search,
    userLabels,
  ]);

  useEffect(() => {
    if (gridApi) {
      gridApi.paginationGoToFirstPage();
    }
  }, [
    activeFilter,
    statusFilter,
    severityFilter,
    categoryFilter,
    issueTypeFilter,
    intakeModeFilter,
    statusGroupFilter,
    severityGroupFilter,
    updatedWithinDays,
    search,
    gridApi,
  ]);

  const handleGridReady = (params: GridReadyEvent) => {
    setGridApi(params.api);
    params.api.setGridOption("paginationPageSize", pageSize);
  };

  const getExportColumnIds = useCallback(
    (includeOptionalColumns: boolean) => {
      if (!gridApi) {
        return includeOptionalColumns
          ? [...CORE_EXPORT_COLUMN_IDS, ...OPTIONAL_EXPORT_COLUMN_IDS]
          : [...CORE_EXPORT_COLUMN_IDS];
      }

      const allowed = new Set<string>([
        ...CORE_EXPORT_COLUMN_IDS,
        ...(includeOptionalColumns ? OPTIONAL_EXPORT_COLUMN_IDS : []),
      ]);

      const displayed = gridApi
        .getAllDisplayedColumns()
        .map((column) => column.getColId())
        .filter((colId) => allowed.has(colId));

      const fallback = [...CORE_EXPORT_COLUMN_IDS].filter((colId) => allowed.has(colId));
      const base = displayed.length > 0 ? displayed : fallback;

      if (!includeOptionalColumns) return base;

      const extras = OPTIONAL_EXPORT_COLUMN_IDS.filter((colId) => !base.includes(colId));
      return [...base, ...extras];
    },
    [gridApi]
  );

  const exportTickets = useCallback(
    (mode: "currentPage" | "filteredResults") => {
      if (!gridApi) return;

      const includeOptional = mode === "filteredResults";
      const columnKeys = getExportColumnIds(includeOptional);
      const now = new Date();
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
      const pageStart = gridApi.paginationGetCurrentPage() * gridApi.paginationGetPageSize();
      const pageEnd = pageStart + gridApi.paginationGetPageSize() - 1;
      const pageScoped = mode === "currentPage";

      gridApi.exportDataAsExcel({
        fileName:
          mode === "currentPage"
            ? `admin-tickets-current-page-${stamp}.xlsx`
            : mode === "filteredResults"
              ? `admin-tickets-filtered-results-${stamp}.xlsx`
              : `admin-tickets-current-page-${stamp}.xlsx`,
        sheetName: "Tickets",
        exportedRows: "filteredAndSorted",
        columnKeys,
        shouldRowBeSkipped:
          pageScoped
            ? ({ node }) => {
                const idx = node.rowIndex ?? -1;
                return Boolean(node.group) || idx < pageStart || idx > pageEnd;
              }
            : ({ node }) => Boolean(node.group),
      });
    },
    [getExportColumnIds, gridApi]
  );

  const handleFullAdminExport = useCallback(async () => {
    if (isFullExporting) return;

    setIsFullExporting(true);
    try {
      const { blob, filename } = await downloadFullAdminTicketsExport({
        includeInternal: true,
      });
      saveBlobToFile(blob, filename);

      showToast({
        type: "success",
        title: "Full admin export ready",
        message: `Downloaded ${filename}`,
      });

      trackUxEvent("admin_full_export_success", {
        page: "admin_tickets",
        action: "export",
        outcome: "success",
      });
    } catch (error) {
      const message = toUserFacingMessage(error, {
        fallback: "Unable to export full admin dataset right now. Please try again.",
      });

      showToast({
        type: "error",
        title: "Full admin export failed",
        message,
      });

      trackUxEvent("admin_full_export_failed", {
        page: "admin_tickets",
        action: "export",
        outcome: "error",
        message,
      });
    } finally {
      setIsFullExporting(false);
    }
  }, [isFullExporting, showToast]);

  const handleClaimTicket = useCallback(async (ticketId: string) => {
    try {
      await claimTicket(ticketId);
      showToast({
        type: "success",
        title: "Ticket claimed.",
        message: "This ticket is now assigned to you.",
        durationMs: 2200,
      });
      await loadTickets();
    } catch (error) {
      const message = toUserFacingMessage(error, {
        fallback: "Unable to claim this ticket right now. It may already be assigned.",
      });
      showToast({
        type: "error",
        title: "Claim failed.",
        message,
      });
      trackUxEvent("admin_tickets_claim_failed", {
        page: "admin_tickets",
        action: "claim_ticket",
        outcome: "error",
        message,
      });
    }
  }, [loadTickets, showToast]);

  const columnDefs = useMemo<ColDef<TicketRow>[]>(() => {
  const cols: ColDef<TicketRow>[] = [
    {
      colId: "group_status",
      headerName: "",
      field: "status",
      rowGroup: groupField === "status",
      hide: true,
    },
    {
      colId: "group_severity",
      headerName: "",
      field: "severity",
      rowGroup: groupField === "severity",
      hide: true,
    },
    {
      colId: "group_category",
      headerName: "",
      field: "category",
      rowGroup: groupField === "category",
      hide: true,
      valueFormatter: ({ value }) => fmt(value),
    },
    {
      field: "ticket_id",
      headerName: "Ticket ID",
      width: 154,
      minWidth: 140,
      maxWidth: 180,
      pinned: "left",
      sortable: true,
      cellRenderer: (params: ICellRendererParams<TicketRow>) => String(params.value || "").trim() || "Unassigned",
      cellClass: "ticket-id-cell",
      cellStyle: { color: "#334155" },
    },
    {
      field: "status",
      headerName: "Status",
      width: 146,
      minWidth: 136,
      maxWidth: 160,
      sortable: true,
      showRowGroup: true,
      cellRenderer: "agGroupCellRenderer",
      cellRendererParams: {
        suppressCount: true,
        innerRenderer: StatusBadgeRenderer,
      },
    },
    {
      field: "severity",
      headerName: "Severity",
      width: 118,
      minWidth: 108,
      maxWidth: 126,
      sortable: true,
      cellRenderer: SeverityBadgeRenderer,
    },
    {
      field: "issue_type",
      headerName: "Type",
      width: 120,
      minWidth: 110,
      maxWidth: 130,
      sortable: true,
      cellStyle: { color: "#334155" },
      valueFormatter: ({ value }) => fmt(value),
    },
    {
      field: "category",
      headerName: "Category",
      width: 160,
      minWidth: 150,
      maxWidth: 180,
      sortable: true,
      cellStyle: { color: "#334155" },
      valueFormatter: ({ value }) => fmt(value),
    },
    {
      field: "created_by_uid",
      headerName: "Reporter",
      flex: 1.1,
      minWidth: 115,
      sortable: true,
      cellStyle: { color: "#334155" },
      valueFormatter: ({ value }) => userLabels[String(value)] || "Unassigned",
    },
    {
      field: "assigned_to_uid",
      headerName: "Assigned To",
      flex: 1.1,
      minWidth: 115,
      sortable: true,
      cellStyle: { color: "#334155" },
      valueFormatter: ({ value }) => userLabels[String(value)] || "Unassigned",
    },
    {
      colId: "location",
      headerName: "Location",
      flex: 1.2,
      minWidth: 160,
      sortable: false,
      valueGetter: ({ data }) => (data ? formatLocation(data) : "Unassigned"),
      cellStyle: { color: "#334155" },
    },
    {
      field: "created_at",
      headerName: "Created Date",
      flex: 1.2,
      minWidth: 140,
      sortable: true,
      sort: "desc",
      cellStyle: { color: "#334155" },
      valueFormatter: ({ value }) => formatDateTimeShort(value),
    },
    {
      field: "updated_at",
      headerName: "Updated Date",
      flex: 1.2,
      minWidth: 140,
      sortable: true,
      cellStyle: { color: "#334155" },
      valueFormatter: ({ value }) => formatDateTimeShort(value),
    },
    {
      field: "intake_mode",
      headerName: "Intake",
      width: 76,
      minWidth: 72,
      maxWidth: 82,
      sortable: true,
      cellRenderer: IntakeModeRenderer,
      cellStyle: { display: "flex", alignItems: "center", justifyContent: "center" },
    },
    {
      colId: "actions",
      headerName: "Actions",
      width: 116,
      minWidth: 108,
      maxWidth: 128,
      sortable: false,
      filter: false,
      cellRenderer: (params: ICellRendererParams<TicketRow>) => {
        const row = params.data;
        if (!row || String(row.assigned_to_uid || "").trim()) {
          return <span className="text-xs text-slate-400">-</span>;
        }

        return (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void handleClaimTicket(row.id);
            }}
            className="claim-btn"
          >
            Claim
          </button>
        );
      },
      cellStyle: { display: "flex", alignItems: "center" },
    },
    {
      colId: "short_description",
      headerName: "Short Description",
      hide: true,
      valueGetter: ({ data }) => shortText(data?.description, 100),
    },
    {
      colId: "age",
      headerName: "Age",
      hide: true,
      valueGetter: ({ data }) => formatAge(data?.created_at),
    },
  ];

  return cols;
}, [groupField, handleClaimTicket, userLabels]);

  return (
    <Layout user={user} role={role} onLogout={onLogout}>
      <div className="page-content space-y-4">
        <div className="card p-3">
          {(statusGroupFilter !== "all" ||
            severityGroupFilter !== "all" ||
            updatedWithinDays !== null ||
            activeFilter !== "all" ||
            issueTypeFilter !== "all") && (
            <div className="mb-3 flex flex-wrap gap-2 text-xs text-slate-600">
              <span className="rounded-full bg-slate-100 px-2.5 py-1">
                Dashboard filter applied
              </span>
              {activeFilter === "opening" && (
                <span className="rounded-full bg-amber-50 px-2.5 py-1 text-amber-800">
                  Active cases
                </span>
              )}
              {activeFilter === "finished" && (
                <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-emerald-800">
                  Resolved / Closed
                </span>
              )}
              {activeFilter === "highRisk" && (
                <span className="rounded-full bg-rose-50 px-2.5 py-1 text-rose-800">
                  High risk
                </span>
              )}
              {activeFilter === "unassigned" && (
                <span className="rounded-full bg-blue-50 px-2.5 py-1 text-blue-800">
                  Unassigned only
                </span>
              )}
              {statusGroupFilter === "finished" && (
                <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-emerald-800">
                  Finished only
                </span>
              )}
              {severityGroupFilter === "criticalHigh" && (
                <span className="rounded-full bg-rose-50 px-2.5 py-1 text-rose-800">
                  Critical + High only
                </span>
              )}
              {updatedWithinDays !== null && (
                <span className="rounded-full bg-blue-50 px-2.5 py-1 text-blue-800">
                  Updated within {updatedWithinDays} days
                </span>
              )}
              {issueTypeFilter !== "all" && (
                <span className="rounded-full bg-purple-50 px-2.5 py-1 text-purple-800">
                  {issueTypeFilter === "cyber" ? "Cyber Security" : "IT Support"} only
                </span>
              )}
            </div>
          )}

          {/* Quick Type Filter */}
          <div className="mb-4 flex items-center gap-2 border-b border-slate-200 pb-3">
            <span className="text-sm font-medium text-slate-700">Quick Filter:</span>
            <button
              onClick={() => {
                const params = new URLSearchParams(window.location.search);
                params.delete("issue_type");
                params.delete("prefilter");
                navigate(`/admin/tickets?${params.toString()}`);
              }}
              className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                issueTypeFilter === "all"
                  ? "bg-blue-600 text-white"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
            >
              All
            </button>
            <button
              onClick={() => {
                const params = new URLSearchParams(window.location.search);
                params.set("prefilter", "unassigned");
                navigate(`/admin/tickets?${params.toString()}`);
              }}
              className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                activeFilter === "unassigned"
                  ? "bg-blue-600 text-white"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
            >
              Unassigned
            </button>
            <button
              onClick={() => {
                const params = new URLSearchParams(window.location.search);
                params.set("issue_type", "cyber");
                navigate(`/admin/tickets?${params.toString()}`);
              }}
              className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                issueTypeFilter === "cyber"
                  ? "bg-purple-600 text-white"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
            >
              Cyber Security
            </button>
            <button
              onClick={() => {
                const params = new URLSearchParams(window.location.search);
                params.set("issue_type", "it_support");
                navigate(`/admin/tickets?${params.toString()}`);
              }}
              className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                issueTypeFilter === "it_support"
                  ? "bg-cyan-600 text-white"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
            >
              IT Support
            </button>
          </div>

          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <input
                type="text"
                placeholder="Search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="min-w-[220px] basis-full rounded-md border border-slate-300 px-3 py-2 text-sm lg:basis-[42%] lg:flex-none"
              />

              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="toolbar-select rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="all">Status</option>
                <option value="open">Open</option>
                <option value="assigned">Assigned</option>
                <option value="investigating">Investigating</option>
                <option value="resolved">Resolved</option>
                <option value="closed">Closed</option>
              </select>

              <select
                value={severityFilter}
                onChange={(e) => setSeverityFilter(e.target.value)}
                className="toolbar-select rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="all">Severity</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>

              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="toolbar-select rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="all">Category</option>
                {uniqueCategories.map((c) => (
                  <option key={c} value={c}>
                    {c.replaceAll("_", " ")}
                  </option>
                ))}
              </select>

              <select
                value={groupField}
                onChange={(e) =>
                  setGroupField(
                    e.target.value as "none" | "status" | "severity" | "category"
                  )
                }
                className="toolbar-select rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="none">Group</option>
                <option value="status">Group by Status</option>
                <option value="severity">Group by Severity</option>
                <option value="category">Group by Category</option>
              </select>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {/* Export dropdown */}
              <div className="relative" ref={exportMenuRef}>
                <button
                  onClick={() => setExportMenuOpen((v) => !v)}
                  className="toolbar-button rounded-md border border-slate-300 bg-white text-sm hover:bg-slate-50"
                >
                  Export
                  <svg
                    className={`h-4 w-4 text-slate-500 transition-transform ${exportMenuOpen ? "rotate-180" : ""}`}
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                      clipRule="evenodd"
                    />
                  </svg>
                </button>

                {exportMenuOpen && (
                  <div className="absolute right-0 z-50 mt-1 w-56 rounded-md border border-slate-200 bg-white shadow-lg">
                    <button
                      onClick={() => { exportTickets("currentPage"); setExportMenuOpen(false); }}
                      className="block w-full px-4 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50"
                    >
                      Export Current Page
                    </button>
                    <button
                      onClick={() => { exportTickets("filteredResults"); setExportMenuOpen(false); }}
                      className="block w-full px-4 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50"
                    >
                      Export Filtered Results (All Pages)
                    </button>
                    <button
                      type="button"
                      disabled={isFullExporting}
                      onClick={() => { void handleFullAdminExport(); setExportMenuOpen(false); }}
                      title="Admin-only full export from backend endpoint"
                      className="block w-full px-4 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isFullExporting ? "Exporting Full Data..." : "Full  Export"}
                    </button>
                  </div>
                )}
              </div>

              <button
                onClick={() => {
                  setSearch("");
                  setStatusFilter("all");
                  setSeverityFilter("all");
                  setCategoryFilter("all");
                  setIssueTypeFilter("all");
                  setActiveFilter("all");
                  setStatusGroupFilter("all");
                  setSeverityGroupFilter("all");
                  setUpdatedWithinDays(null);
                  setGroupField("none");
                }}
                className="toolbar-button rounded-md border border-slate-300 text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                Reset
              </button>
            </div>
          </div>
        </div>

        {errMsg && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {errMsg}
          </div>
        )}

        <div className="card overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-100 flex-wrap">
            <div className="flex items-center gap-2 text-sm text-slate-600">
              Show
              <select
                value={pageSize}
                onChange={(e) => {
                  const newSize = Number(e.target.value);
                  setPageSize(newSize);
                  gridApi?.setGridOption("paginationPageSize", newSize);
                }}
                className="toolbar-select rounded border border-slate-300 px-2 py-1 text-sm"
              >
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              entries
            </div>

            <div className="text-sm text-slate-500">
              {loading
                ? "Loading…"
                : `Total: ${filtered.length} ticket${filtered.length !== 1 ? "s" : ""}`}
            </div>
          </div>

          <div
                className="ag-theme-quartz admin-tickets-grid"
                style={{ width: "100%" }}
              >
            <AgGridReact<TicketRow>
              context={{ navigate, userLabels, claimTicket: handleClaimTicket }}
              domLayout="autoHeight"
              columnDefs={columnDefs}
              rowData={filtered}
              onGridReady={handleGridReady}
              pagination={true}
              paginationPageSize={pageSize}
              paginationPageSizeSelector={false}
              alwaysShowVerticalScroll={true}
              
              defaultColDef={{
                sortable: true,
                resizable: true,
                suppressMovable: false,
              }}
              animateRows={true}
              groupDisplayType="custom"
              groupDefaultExpanded={0}
              masterDetail={true}
              detailRowHeight={180}
              detailCellRenderer={DetailPanel}
              suppressAggFuncInHeader={true}
              loading={loading}
              onRowClicked={(event) => {
                if (event.node.group || !event.data?.id) return;

                if (clickTimerRef.current) {
                  window.clearTimeout(clickTimerRef.current);
                }

                clickTimerRef.current = window.setTimeout(() => {
                  event.node.setExpanded(!event.node.expanded);
                  clickTimerRef.current = null;
                }, 200);
              }}
              onRowDoubleClicked={(event) => {
                if (event.node.group || !event.data?.id) return;

                if (clickTimerRef.current) {
                  window.clearTimeout(clickTimerRef.current);
                  clickTimerRef.current = null;
                }

                navigate(`/admin/tickets/${event.data.id}`);
              }}
              noRowsOverlayComponent={() => (
                <div
                  style={{
                    padding: "20px",
                    textAlign: "center",
                    color: "#94a3b8",
                  }}
                >
                  {loading ? "Loading tickets…" : "No tickets match your filters."}
                </div>
              )}
            />
          </div>
        </div>
      </div>
    </Layout>
  );
}
