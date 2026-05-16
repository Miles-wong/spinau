/**
 * ReporterTicketsPage.tsx - Reporter's own ticket list with AG Grid.
 *
 * Shows only tickets created by the logged-in reporter (filtered by created_by_email).
 * Clicking a row navigates to /tickets/:id for full details and comments.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
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
import { getTickets } from "../services/TicketService";
import { useToast } from "../components/toastContext";
import { trackUxEvent } from "../services/uxTelemetry";
import { toUserFacingMessage } from "../services/userFacingMessage";
import { warmupConversation } from "../services/ConversationWarmupService";
import "./ReporterTicketsPage.css";

ModuleRegistry.registerModules([
  AllCommunityModule,
  RowGroupingModule,
  MasterDetailModule,
  ExcelExportModule,
]);

type ReporterTicketsPageProps = {
  user: UserInfo;
  role: "reporter";
  onLogout: () => void;
};

type TicketRow = {
  id: string;
  ticket_id: string;
  issue_type?: string;
  status: string;
  severity: string;
  category: string;
  location_type?: string;
  location_detail?: string;
  description?: string;
  created_at: string;
  updated_at: string;
  updated_at_ms?: number;
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
  "created_at",
  "location",
  "updated_at",
] as const;

const fmt = (v: unknown) =>
  String(v ?? "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

const formatDateTime = (value: unknown) => {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]} ${isoMatch[2]}`;
  }

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;

  const pad2 = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
};

const shortText = (value: unknown, maxLen: number = 100) => {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
};

const toEpochMs = (value: unknown): number | null => {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isNaN(parsed) ? null : parsed;
};

const formatAge = (createdAt: unknown) => {
  const createdMs = toEpochMs(createdAt);
  if (!createdMs) return "";

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
  if (!locationType && !locationDetail) return "";
  if (!locationType) return locationDetail;
  if (!locationDetail) return fmt(locationType);
  return `${fmt(locationType)} - ${locationDetail}`;
};

function statusBadge(s: string) {
  const key = (s || "").toLowerCase();
  const cls = `rt-badge rt-badge-${
    ["open", "assigned", "investigating", "resolved", "closed"].includes(key)
      ? key
      : "secondary"
  }`;
  return <span className={cls}>{fmt(s)}</span>;
}

function severityBadge(s: string) {
  const key = (s || "").toLowerCase();
  const cls = `rt-badge rt-badge-${
    ["critical", "high", "medium", "low"].includes(key)
      ? key
      : "secondary"
  }`;
  return <span className={cls}>{fmt(s)}</span>;
}

type BadgeRendererProps = { value: string };
const StatusBadgeRenderer = (props: BadgeRendererProps) => statusBadge(props.value);
const SeverityBadgeRenderer = (props: BadgeRendererProps) =>
  severityBadge(props.value);

function DetailPanel(props: ICellRendererParams<TicketRow>) {
  const row = props.data;
  if (!row) return null;

  const descriptionText = String(row.description ?? "").trim();
  const shortDescription = descriptionText || "";

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
            {shortDescription}
          </div>
        </div>
        <div>
          <strong>Current Status:</strong> {fmt(row.status)}
        </div>
        <div>
          <strong>Last Updated:</strong> {formatDateTime(row.updated_at)}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={() => props.context?.navigate?.(`/tickets/${row.id}`)}
          className="rt-view-btn"
        >
          Open Full Detail
        </button>
      </div>
    </div>
  );
}

export default function ReporterTicketsPage({
  user,
  role,
  onLogout,
}: ReporterTicketsPageProps) {
  const navigate = useNavigate();

  const warmupNewReport = () => {
    void warmupConversation().catch(() => {
      // The report page handles initialization errors if the warm-up fails.
    });
  };

  const openNewReport = () => {
    warmupNewReport();
    navigate("/report-chat");
  };
  const { showToast } = useToast();

  const [rows, setRows] = useState<TicketRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [issueTypeFilter, setIssueTypeFilter] = useState("all");
  const [groupField, setGroupField] = useState<
    "none" | "status" | "severity" | "category"
  >("none");
  const [gridApi, setGridApi] = useState<GridApi | null>(null);
  const [pageSize, setPageSize] = useState(15);

  const clickTimerRef = useRef<number | null>(null);

  const loadTickets = useCallback(async () => {
    setLoading(true);
    setErrMsg("");

    try {
      const collectedRows: TicketRow[] = [];
      let cursor: Awaited<ReturnType<typeof getTickets>>["nextCursor"] = null;
      let hasMore = true;

      while (hasMore && collectedRows.length < MAX_FETCH_ROWS) {
        const response = await getTickets({
          createdByEmail: (user.email || "").trim().toLowerCase(),
          pageSize: FETCH_BATCH_SIZE,
          cursor,
        });

        const batch = (response.rows || []) as TicketRow[];
        collectedRows.push(...batch);
        hasMore = Boolean(response.hasMore);
        cursor = response.nextCursor;

        if (!response.nextCursor) break;
      }

      setRows(collectedRows.slice(0, MAX_FETCH_ROWS));
    } catch (error) {
      const message = toUserFacingMessage(error, {
        fallback: "Unable to load your submitted reports right now. Please try again.",
      });

      setErrMsg(message);
      setRows([]);

      showToast({
        type: "error",
        title: "Unable to load your reports.",
        message,
        action: { label: "Retry", onClick: () => void loadTickets() },
      });

      trackUxEvent("reporter_tickets_load_failed", {
        page: "reporter_tickets",
        action: "load",
        outcome: "error",
        message,
      });
    } finally {
      setLoading(false);
    }
  }, [user.email, showToast]);

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
    return rows.filter((r) => {
      const st = (r.status || "").toLowerCase();
      const sv = (r.severity || "").toLowerCase();

      if (statusFilter !== "all" && st !== statusFilter) return false;
      if (severityFilter !== "all" && sv !== severityFilter) return false;
      if (categoryFilter !== "all" && r.category !== categoryFilter) return false;
      if (issueTypeFilter !== "all" && (r.issue_type || "cyber").toLowerCase() !== issueTypeFilter) return false;

      const q = search.trim().toLowerCase();
      if (!q) return true;

      return [r.ticket_id, r.issue_type, r.category, r.status, r.severity]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [rows, search, statusFilter, severityFilter, categoryFilter, issueTypeFilter]);

  const statusSummary = useMemo(() => {
    const counts = { open: 0, assigned: 0, investigating: 0, resolved: 0, closed: 0 };
    rows.forEach((row) => {
      const key = String(row.status || "").toLowerCase();
      if (key === "open" || key === "assigned" || key === "resolved" || key === "closed") {
        counts[key] += 1;
        return;
      }
      if (key === "investigating") {
        counts.investigating += 1;
      }
    });
    return counts;
  }, [rows]);

  useEffect(() => {
    if (gridApi) {
      gridApi.paginationGoToFirstPage();
    }
  }, [statusFilter, severityFilter, categoryFilter, issueTypeFilter, search, gridApi]);

  const handleGridReady = (params: GridReadyEvent) => {
    setGridApi(params.api);
    params.api.setGridOption("paginationPageSize", pageSize);
  };

  const getExportColumnIds = useCallback(() => {
    if (!gridApi) return [...CORE_EXPORT_COLUMN_IDS];

    const allowed = new Set<string>(CORE_EXPORT_COLUMN_IDS);
    const displayed = gridApi
      .getAllDisplayedColumns()
      .map((column) => column.getColId())
      .filter((colId) => allowed.has(colId));

    return displayed.length > 0 ? displayed : [...CORE_EXPORT_COLUMN_IDS];
  }, [gridApi]);

  const exportTickets = useCallback(
    (mode: "currentPage") => {
      if (!gridApi) return;

      const columnKeys = getExportColumnIds();
      const now = new Date();
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
      const pageStart = gridApi.paginationGetCurrentPage() * gridApi.paginationGetPageSize();
      const pageEnd = pageStart + gridApi.paginationGetPageSize() - 1;
      const pageScoped = mode === "currentPage";

      gridApi.exportDataAsExcel({
        fileName:
          mode === "currentPage"
            ? `my-tickets-current-page-${stamp}.xlsx`
            : `my-tickets-current-page-${stamp}.xlsx`,
        sheetName: "My Tickets",
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

  const baseCellStyle = useMemo(() => ({
    fontSize: "14px",
    display: "flex",
    alignItems: "center",
    color: "#334155",
    fontWeight: 400,
  } as const), []);

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
        width: 130,
        minWidth: 120,
        maxWidth: 140,
        pinned: "left",
        sortable: true,
        cellStyle: {
          ...baseCellStyle,
          fontWeight: 600,
        },
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
        cellStyle: baseCellStyle,
        valueFormatter: ({ value }) => fmt(value),
      },
      {
        field: "category",
        headerName: "Category",
        width: 160,
        minWidth: 150,
        maxWidth: 180,
        sortable: true,
        cellStyle: baseCellStyle,
        valueFormatter: ({ value }) => fmt(value),
      },
      {
        field: "created_at",
        headerName: "Created Date",
        flex: 1.1,
        minWidth: 170,
        sortable: true,
        sort: "desc",
        cellStyle: baseCellStyle,
        valueFormatter: (params) => formatDateTime(params.value),
      },
      {
        colId: "location",
        headerName: "Location",
        flex: 1.1,
        minWidth: 170,
        sortable: false,
        cellStyle: baseCellStyle,
        valueGetter: ({ data }) => (data ? formatLocation(data) : ""),
      },
      {
        field: "updated_at",
        headerName: "Updated Date",
        flex: 1.1,
        minWidth: 170,
        sortable: true,
        cellStyle: baseCellStyle,
        valueFormatter: (params) => formatDateTime(params.value),
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
  }, [groupField, baseCellStyle]);

  return (
    <Layout user={user} role={role} onLogout={onLogout}>
      <div className="rt-page">
        <div className="rt-header">
          <div className="rt-header-copy">
            <div className="rt-title-block">
              <h1 className="rt-title">My Tickets</h1>
              <p className="rt-subtitle">
                {loading
                  ? "Loading..."
                  : `${rows.length} ticket${rows.length !== 1 ? "s" : ""} found`}
              </p>
            </div>
            {!loading && (
              <div className="rt-header-stats">
                <span className="rt-stat-pill">Open {statusSummary.open}</span>
                <span className="rt-stat-pill">Assigned {statusSummary.assigned}</span>
                <span className="rt-stat-pill">Investigating {statusSummary.investigating}</span>
                <span className="rt-stat-pill">Resolved {statusSummary.resolved}</span>
              </div>
            )}
          </div>

          <div className="rt-header-actions">
            <button
              className="rt-refresh-btn"
              onClick={() => void loadTickets()}
              disabled={loading}
            >
              Refresh
            </button>
            <button
              className="rt-new-btn"
              onMouseEnter={warmupNewReport}
              onFocus={warmupNewReport}
              onClick={openNewReport}
            >
              + New Report
            </button>
          </div>
        </div>

        <div className="card p-3">
          {/* Quick Type Filter */}
          <div className="mb-4 flex items-center gap-2 border-b border-slate-200 pb-3">
            <span className="text-sm font-medium text-slate-700">Quick Filter:</span>
            <button
              onClick={() => setIssueTypeFilter("all")}
              className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                issueTypeFilter === "all"
                  ? "bg-blue-600 text-white"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
            >
              All
            </button>
            <button
              onClick={() => setIssueTypeFilter("cyber")}
              className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                issueTypeFilter === "cyber"
                  ? "bg-purple-600 text-white"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
            >
              Cyber Security
            </button>
            <button
              onClick={() => setIssueTypeFilter("it_support")}
              className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                issueTypeFilter === "it_support"
                  ? "bg-cyan-600 text-white"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
            >
              IT Support
            </button>
          </div>

          <div className="flex flex-wrap gap-2 items-center">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between w-full">
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
                <button
                  onClick={() => exportTickets("currentPage")}
                  className="toolbar-button rounded-md border border-slate-300 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Export Current Page
                </button>

                <button
                  onClick={() => {
                    setSearch("");
                    setStatusFilter("all");
                    setSeverityFilter("all");
                    setCategoryFilter("all");
                    setIssueTypeFilter("all");
                    setGroupField("none");
                  }}
                  className="toolbar-button rounded-md border border-slate-300 text-sm font-medium text-slate-600 hover:bg-slate-50"
                >
                  Reset
                </button>
              </div>
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
                className="rounded border border-slate-300 px-2 py-1 text-sm"
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
            className="ag-theme-quartz reporter-tickets-grid"
            style={{ width: "100%", overflowX: "auto" }}
          >
            <AgGridReact<TicketRow>
              context={{ navigate }}
              domLayout="autoHeight"
              columnDefs={columnDefs}
              rowData={filtered}
              onGridReady={handleGridReady}
              pagination={true}
              paginationPageSize={pageSize}
              paginationPageSizeSelector={false}
              alwaysShowVerticalScroll={false}
              rowHeight={54}
              headerHeight={50}
              defaultColDef={{
                sortable: true,
                resizable: true,
                suppressMovable: false,
                cellStyle: baseCellStyle,
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

                navigate(`/tickets/${event.data.id}`);
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
