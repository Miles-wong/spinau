/**
 * AdminDashboardPage.tsx — Admin overview dashboard.
 *
 * Derives all stats and chart data client-side from the same
 * apiService.getTickets() and apiService.getAuditLogs() calls
 * used elsewhere. No new backend endpoints required.
 *
 * Charts: Recharts (AreaChart, BarChart, PieChart / Cell).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from "recharts";
import type { UserInfo } from "../types/auth";
import Layout from "../components/Layout";
import { claimTicket, getTickets } from "../services/TicketService";
import type { TicketRow } from "../services/ServiceTypes";
import { resolveUserLabels } from "../services/AuthService";
import { useToast } from "../components/toastContext";
import { trackUxEvent } from "../services/uxTelemetry";
import { toUserFacingMessage } from "../services/userFacingMessage";

const fmt = (v: unknown) =>
  String(v ?? "").replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase()) || "—";

type AdminDashboardPageProps = {
  user: UserInfo;
  role: "admin";
  onLogout: () => void;
};

const STATUS_COLOURS: Record<string, string> = {
  open: "#3b82f6",
  assigned: "#7c3aed",
  investigating: "#f59e0b",
  resolved: "#22c55e",
  closed: "#94a3b8",
};

const SEVERITY_COLOURS: Record<string, string> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#22c55e",
};

function StatTile({
  label,
  value,
  sub,
  accent,
  onClick,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="card flex w-full flex-col items-center gap-1 p-5 text-center transition hover:shadow-md"
    >
      <div className={`text-xs font-semibold uppercase tracking-widest ${accent}`}>{label}</div>
      <div className="text-3xl font-black text-slate-900 mt-1">{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
    </button>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card p-5">
      <div className="text-sm font-semibold text-slate-700 mb-4">{title}</div>
      {children}
    </div>
  );
}

export default function AdminDashboardPage({ user, role, onLogout }: AdminDashboardPageProps) {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [userLabels, setUserLabels] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setErrMsg("");
    try {
      const response = await getTickets();
      const nextRows = response.rows as TicketRow[];
      setRows(nextRows);

      const emailSet = new Set<string>();
      nextRows.forEach((r) => {
        if (r.created_by_email) emailSet.add(r.created_by_email);
        if (r.assigned_to_email) emailSet.add(r.assigned_to_email);
      });
      const labels = await resolveUserLabels([...emailSet]);
      setUserLabels(labels);
    } catch (e) {
      const message = toUserFacingMessage(e, {
        fallback: "Unable to load dashboard data right now. Please try again.",
      });
      setErrMsg(message);
      showToast({
        type: "error",
        title: "Dashboard failed to load.",
        message,
        action: {
          label: "Retry",
          onClick: () => {
            void load();
          },
        },
      });
      trackUxEvent("admin_dashboard_load_failed", {
        page: "admin_dashboard",
        action: "load",
        outcome: "error",
        message,
      });
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { void load(); }, [load]);

  /* ── Derived stats ── */
  const stats = useMemo(() => {
    const total = rows.length;
    const cyberCount = rows.filter((r) => (r.issue_type || "cyber").toLowerCase() === "cyber").length;
    const itSupportCount = rows.filter((r) => (r.issue_type || "").toLowerCase() === "it_support").length;
    const fastSubmissionCount = rows.filter((r) => (r.intake_mode || "").toLowerCase() === "fast").length;
    const highCriticalOpen = rows.filter((r) => {
      const status = (r.status || "").toLowerCase();
      const severity = (r.severity || "").toLowerCase();
      return ["open", "assigned", "investigating"].includes(status) && ["critical", "high"].includes(severity);
    }).length;

    return { total, cyberCount, itSupportCount, fastSubmissionCount, highCriticalOpen };
  }, [rows]);

  /* ── Chart data ── */

  // Status pie
  const statusPieData = useMemo(() => {
    const counts: Record<string, number> = {};
    rows.forEach((r) => {
      const s = (r.status || "unknown").toLowerCase();
      counts[s] = (counts[s] || 0) + 1;
    });
    return Object.entries(counts).map(([name, value]) => ({ name, value }));
  }, [rows]);

  // Severity bar
  const severityBarData = useMemo(() => {
    const order = ["critical", "high", "medium", "low"];
    const counts: Record<string, number> = {};
    rows.forEach((r) => {
      const s = (r.severity || "unknown").toLowerCase();
      counts[s] = (counts[s] || 0) + 1;
    });
    return order.map((s) => ({ name: s.charAt(0).toUpperCase() + s.slice(1), value: counts[s] || 0, fill: SEVERITY_COLOURS[s] || "#94a3b8" }));
  }, [rows]);

  // Tickets created — last 30 days (area chart)
  const areaData = useMemo(() => {
    const now = Date.now();
    const days: { date: string; Tickets: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const dayStart = now - i * 86400000;
      const dayEnd = dayStart + 86400000;
      const d = new Date(dayStart);
      const label = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      const count = rows.filter((r) => {
        const ms = Date.parse(String(r.created_at || ""));
        return !isNaN(ms) && ms >= dayStart && ms < dayEnd;
      }).length;
      days.push({ date: label, Tickets: count });
    }
    return days;
  }, [rows]);

  // Top categories bar
  const categoryBarData = useMemo(() => {
    const counts: Record<string, number> = {};
    rows.forEach((r) => { if (r.category) counts[r.category] = (counts[r.category] || 0) + 1; });
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, value]) => ({ name: fmt(name), value }));
  }, [rows]);

  // Recent 10 tickets
  const recentTickets = useMemo(() =>
    [...rows]
      .sort((a, b) => Date.parse(String(b.created_at || "")) - Date.parse(String(a.created_at || "")))
      .slice(0, 10),
    [rows]
  );

  const unassignedTickets = useMemo(() =>
    [...rows]
      .filter((row) => !String(row.assigned_to_email || "").trim())
      .sort((a, b) => {
        const severityRank: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
        const severityDelta =
          (severityRank[String(b.severity || "").toLowerCase()] || 0) -
          (severityRank[String(a.severity || "").toLowerCase()] || 0);
        if (severityDelta !== 0) return severityDelta;
        return Date.parse(String(b.created_at || "")) - Date.parse(String(a.created_at || ""));
      }),
    [rows]
  );

  const statusBadge = (s: string) => {
    const key = s.toLowerCase();
    const cls = `badge badge-${key === "open" ? "open" : key === "assigned" ? "assigned" : key === "investigating" ? "investigating" : key === "resolved" ? "resolved" : "closed"}`;
    return <span className={cls}>{s || "—"}</span>;
  };

  const severityBadge = (s: string) => {
    const key = s.toLowerCase();
    const cls = `badge badge-${["critical","high","medium","low"].includes(key) ? key : "secondary"}`;
    return <span className={cls}>{s || "—"}</span>;
  };

  const handleClaimTicket = async (ticketId: string) => {
    try {
      await claimTicket(ticketId);
      showToast({
        type: "success",
        title: "Ticket claimed.",
        message: "This ticket is now assigned to you.",
        durationMs: 2200,
      });
      await load();
    } catch (error) {
      const message = toUserFacingMessage(error, {
        fallback: "Unable to claim this ticket right now. It may already be assigned.",
      });
      showToast({
        type: "error",
        title: "Claim failed.",
        message,
      });
      trackUxEvent("dashboard_claim_ticket_failed", {
        page: "admin_dashboard",
        action: "claim_ticket",
        outcome: "error",
        message,
      });
    }
  };

  return (
    <Layout user={user} role={role} onLogout={onLogout}>
      <div className="page-content space-y-6">

        {errMsg && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{errMsg}</div>}

        {loading ? (
          <div className="text-sm text-slate-500 py-8 text-center">Loading dashboard…</div>
        ) : (
          <>
            {/* Stats tiles */}
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
              <StatTile
                label="Total Reports"
                value={stats.total}
                accent="text-blue-600"
                sub="all time · click to view all"
                onClick={() => navigate("/admin/tickets")}
              />
              <StatTile
                label="Cyber Security Reports"
                value={stats.cyberCount}
                accent="text-purple-600"
                sub="all time · click to filter"
                onClick={() => navigate("/admin/tickets?issue_type=cyber")}
              />
              <StatTile
                label="IT Support Reports"
                value={stats.itSupportCount}
                accent="text-cyan-600"
                sub="all time · click to filter"
                onClick={() => navigate("/admin/tickets?issue_type=it_support")}
              />
              <StatTile
                label="Fast Submissions"
                value={stats.fastSubmissionCount}
                accent="text-emerald-600"
                sub="all time · quick intake mode"
                onClick={() => navigate("/admin/tickets?intakeMode=fast")}
              />
              <StatTile
                label="High / Critical Open"
                value={stats.highCriticalOpen}
                accent="text-red-600"
                sub="needs attention · click to filter"
                onClick={() => navigate("/admin/tickets?severityGroup=criticalHigh&statusGroup=all")}
              />
            </div>

            <div className="card overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
                <div>
                  <div className="text-sm font-semibold text-slate-700">Unassigned Tickets</div>
                  <div className="mt-1 text-xs text-slate-500">{unassignedTickets.length} shown • Scroll right to see all</div>
                </div>
                <button
                  onClick={() => navigate("/admin/tickets?prefilter=unassigned")}
                  className="text-xs font-semibold text-blue-600 hover:underline"
                >
                  View all
                </button>
              </div>
              <div className="overflow-x-auto">
                <div className="flex gap-3 p-4 min-w-max">
                  {unassignedTickets.length === 0 && (
                    <div className="px-2 py-2 text-sm text-slate-400">No unassigned tickets waiting right now.</div>
                  )}
                  {unassignedTickets.map((row) => (
                    <div
                      key={row.id}
                      className="flex-shrink-0 w-80 rounded-lg border border-slate-200 p-4 bg-slate-50 hover:bg-slate-100 hover:border-slate-300 transition"
                    >
                      <button
                        type="button"
                        onClick={() => navigate(`/admin/tickets/${row.id}`)}
                        className="w-full text-left"
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-slate-900">{row.ticket_id}</span>
                          {severityBadge(row.severity)}
                          {statusBadge(row.status)}
                        </div>
                        <div className="mt-2 text-sm text-slate-600">{fmt(row.category)}</div>
                        <div className="mt-1 text-xs text-slate-500">{userLabels[row.created_by_email] || "Reporter"}</div>
                        <div className="mt-1 text-xs text-slate-400">{row.created_at}</div>
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleClaimTicket(row.id)}
                        className="mt-3 w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition"
                      >
                        Claim
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Charts row 1 — Status donut + Severity bars */}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <ChartCard title="Tickets by Status">
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Pie
                      data={statusPieData}
                      cx="50%"
                      cy="45%"
                      innerRadius={60}
                      outerRadius={95}
                      paddingAngle={3}
                      dataKey="value"
                    >
                      {statusPieData.map((entry) => (
                        <Cell key={entry.name} fill={STATUS_COLOURS[entry.name] || "#cbd5e1"} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(value, name) => [`${value} tickets`, fmt(String(name))]} />
                    <Legend formatter={(name) => fmt(String(name))} />
                  </PieChart>
                </ResponsiveContainer>
              </ChartCard>

              <ChartCard title="Tickets by Severity">
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={severityBarData} layout="vertical" margin={{ left: 8, right: 24 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 12 }} allowDecimals={false} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 12 }} width={70} />
                    <Tooltip cursor={{ fill: "#f1f5f9" }} />
                    <Bar dataKey="value" radius={[0, 4, 4, 0]} name="Tickets">
                      {severityBarData.map((entry) => (
                        <Cell key={entry.name} fill={entry.fill} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>

            {/* Chart row 2 — Area chart + Category bar */}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <ChartCard title="Tickets created — last 30 days">
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={areaData} margin={{ left: -10, right: 8 }}>
                    <defs>
                      <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.25} />
                        <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} interval={4} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip />
                    <Area
                      type="monotone"
                      dataKey="Tickets"
                      stroke="#3b82f6"
                      strokeWidth={2}
                      fill="url(#areaGradient)"
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartCard>

              <ChartCard title="Top categories">
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={categoryBarData} layout="vertical" margin={{ left: 8, right: 24 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 12 }} allowDecimals={false} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={110} />
                    <Tooltip cursor={{ fill: "#f1f5f9" }} />
                    <Bar dataKey="value" fill="#6366f1" radius={[0, 4, 4, 0]} name="Tickets" />
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>

            {/* Recent tickets */}
            <div className="card overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
                <div className="text-sm font-semibold text-slate-700">Recent Tickets</div>
                <button
                  onClick={() => navigate("/admin/tickets")}
                  className="text-xs font-semibold text-blue-600 hover:underline"
                >
                  View all →
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      <th className="px-5 py-3">Ticket ID</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Severity</th>
                      <th className="px-4 py-3">Category</th>
                      <th className="px-4 py-3">Reported By</th>
                      <th className="px-4 py-3">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentTickets.length === 0 && (
                      <tr><td colSpan={6} className="px-5 py-6 text-center text-slate-400">No tickets yet.</td></tr>
                    )}
                    {recentTickets.map((row, i) => (
                      <tr
                        key={row.id}
                        className={`border-t border-slate-100 hover:bg-slate-50 cursor-pointer transition ${i % 2 === 1 ? "bg-slate-50/50" : ""}`}
                        onClick={() => navigate(`/admin/tickets/${row.id}`)}
                      >
                        <td className="px-5 py-3 font-semibold text-slate-800">{row.ticket_id}</td>
                        <td className="px-4 py-3">{statusBadge(row.status)}</td>
                        <td className="px-4 py-3">{severityBadge(row.severity)}</td>
                        <td className="px-4 py-3 text-slate-600">{fmt(row.category)}</td>
                        <td className="px-4 py-3 text-slate-600">{userLabels[row.created_by_email] || "—"}</td>
                        <td className="px-4 py-3 text-slate-500 whitespace-nowrap">{row.created_at}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}
