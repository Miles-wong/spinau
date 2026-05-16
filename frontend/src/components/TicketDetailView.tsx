/**
 * TicketDetailView.tsx - Shared ticket detail component used by both admin and reporter pages.
 *
 * Renders ticket metadata, comments thread, and file attachments.
 * Behavior controlled by props:
 * - canEdit    true for admins; enables status change, field editing, and comment submission.
 * - showAudit  true for admins; shows the Audit Log tab with timestamped action history.
 *
 * Resolves all UID references (created_by, updated_by, assigned_to, commenters)
 * to display names via resolveUserLabels so the UI never shows raw Firebase UIDs.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  claimTicket,
  getReporterMissingFieldKeys,
  getTicketDetail,
  updateTicketAdminFields,
  updateTicketReporterMissingFields,
} from "../services/TicketService";
import { getTicketComments, addTicketComment, deleteTicketComment } from "../services/CommentService";
import { getTicketAttachments, addTicketAttachment, downloadTicketAttachment } from "../services/AttachmentService";
import { getTicketAuditLogs } from "../services/AuditService";
import { listUsersByRole, resolveUserLabels } from "../services/AuthService";
import type { AuditLog, FirestoreValue, TicketAttachment, TicketComment } from "../services/ServiceTypes";
import { useToast } from "./toastContext";
import { trackUxEvent } from "../services/uxTelemetry";
import { toUserFacingMessage } from "../services/userFacingMessage";

const fmt = (v: unknown) =>
  String(v ?? "").replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase()) || "—";

function fmtDatetime(value: unknown): string {
  if (!value) return "-";
  try {
    const maybeTimestamp = value as { toDate?: () => Date };
    const d = typeof maybeTimestamp.toDate === "function"
      ? maybeTimestamp.toDate()
      : new Date(String(value));
    if (isNaN(d.getTime())) return String(value);
    return d.toLocaleString("en-AU", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: true,
    });
  } catch {
    return String(value);
  }
}

function normalizeUpdateHint(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const lowered = raw.toLowerCase();
  if (lowered === "updated" || lowered === "update" || lowered === "updated ticket") {
    return "";
  }
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function hasMeaningfulUpdateHint(value: unknown): boolean {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return false;
  return raw !== "updated" && raw !== "update" && raw !== "updated ticket";
}
import type { UserInfo } from "../types/auth";

type TicketDetailViewProps = {
  ticketId: string;
  user: UserInfo;
  backPath: string;
  canEdit: boolean;
  showAudit: boolean;
};

type TicketDetailNavState = {
  fromNotification?: boolean;
  updateHint?: string;
};

type LoadState = "idle" | "loading" | "ok" | "error" | "missing";
type TicketData = Record<string, unknown>;
type DetailItem = { label: string; value: string };
type ActivityTab = "details" | "comments" | "attachments" | "audit";
type AttachmentPreviewState = {
  attachment: TicketAttachment;
  kind: "image" | "pdf" | "text" | "unsupported";
  textContent?: string;
};
type UserRoleOption = {
  email: string;
  label: string;
};

const STATUS_OPTIONS = ["open", "assigned", "investigating", "resolved", "closed"];
const ISSUE_TYPE_OPTIONS = ["cyber", "it_support"];
const CATEGORY_OPTIONS = ["phishing", "malware", "email_exposure", "credential_compromise", "unauthorized_access", "data_breach", "device_loss", "suspicious_activity", "policy_violation", "infrastructure_issue", "hardware_issue", "network_issue", "software_issue", "access_account_issue", "communication", "performance_issue", "service_request", "technical_incident", "general_technical_support", "other"];
const SEVERITY_OPTIONS = ["low", "medium", "high", "critical"];
const LOCATION_OPTIONS = ["email", "device", "network", "physical", "cloud", "other"];
const CONTACT_OPTIONS = ["phone", "email", "in_person", "teams"];

type ReporterFieldConfig = {
  label: string;
  type: "text" | "textarea" | "select" | "boolean";
  options?: string[];
  placeholder?: string;
};

const REPORTER_EDITABLE_FIELD_CONFIG: Record<string, ReporterFieldConfig> = {
  description: { label: "Description", type: "textarea", placeholder: "Add more context to help triage" },
  noticed_time: { label: "When noticed", type: "text", placeholder: "e.g. 2026-04-11 09:30" },
  category: { label: "Category", type: "select", options: CATEGORY_OPTIONS },
  category_other_text: { label: "Category detail", type: "text", placeholder: "Describe the category" },
  severity: { label: "Severity", type: "select", options: SEVERITY_OPTIONS },
  location_type: { label: "Location type", type: "select", options: LOCATION_OPTIONS },
  location_detail: { label: "Location detail", type: "text", placeholder: "Device, mailbox, system, or place" },
  response_taken: { label: "Response taken", type: "boolean" },
  response_details: { label: "Response details", type: "textarea", placeholder: "What action did you take?" },
  affected_asset: { label: "Affected asset", type: "text", placeholder: "Laptop, account, app, service..." },
  error_symptom: { label: "Error symptom", type: "text", placeholder: "What error or symptom appeared?" },
  incident_active: { label: "Incident still active", type: "boolean" },
  data_involved_flag: { label: "Sensitive data involved", type: "boolean" },
  data_other_text: { label: "Other data details", type: "text", placeholder: "Describe other data involved" },
  work_continuity: { label: "Work continuity", type: "text", placeholder: "How work is impacted" },
  impact_scope: { label: "Impact scope", type: "text", placeholder: "Team, department, users, systems..." },
  external_party_involved: { label: "External party involved", type: "boolean" },
  external_party_details: { label: "External party details", type: "textarea", placeholder: "Who is involved externally?" },
  already_reported_to_it: { label: "Reported to IT", type: "boolean" },
  reported_to_details: { label: "IT report details", type: "textarea", placeholder: "Who, when, and reference details" },
  preferred_contact_method: { label: "Preferred contact", type: "select", options: CONTACT_OPTIONS },
  phone_number: { label: "Phone number", type: "text", placeholder: "Phone number" },
  contact_email: { label: "Contact email", type: "text", placeholder: "name@company.com" },
};

function toReporterDraftValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value;
  return "";
}

function asText(value: unknown, fallback: string = "-") {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return fallback;
}

function asRawText(value: unknown, fallback: string = "") {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return fallback;
}

function asList(value: unknown, fallback: string = "-") {
  if (Array.isArray(value) && value.length > 0) {
    return value.map((item) => asText(item, "")).filter(Boolean).join(", ");
  }
  return fallback;
}

function createSection(label: string, value: unknown, fallback: string = "-"): DetailItem {
  return { label, value: Array.isArray(value) ? asList(value, fallback) : asText(value, fallback) };
}

function isPermissionError(message: string) {
  const lowered = message.toLowerCase();
  return lowered.includes("missing or insufficient permissions") || lowered.includes("permission-denied");
}

function detectAttachmentPreviewKind(attachment: TicketAttachment): AttachmentPreviewState["kind"] {
  const contentType = String(attachment.content_type || "").toLowerCase();
  const fileName = String(attachment.name || "").toLowerCase();

  if (contentType.startsWith("image/")) return "image";
  if (contentType === "application/pdf" || fileName.endsWith(".pdf")) return "pdf";
  if (
    contentType.startsWith("text/") ||
    ["json", "log", "txt", "csv", "md"].some((ext) => fileName.endsWith(`.${ext}`))
  ) {
    return "text";
  }

  return "unsupported";
}

function formatAttachmentMeta(attachment: TicketAttachment): string {
  const meta: string[] = [];
  if (typeof attachment.size === "number" && Number.isFinite(attachment.size)) {
    meta.push(`${(attachment.size / 1024 / 1024).toFixed(2)} MB`);
  }
  if (attachment.content_type) {
    meta.push(String(attachment.content_type));
  }
  return meta.join(" | ");
}

function getAuditTitle(action: string) {
  const map: Record<string, string> = {
    create_ticket: "Report created",
    add_comment: "Comment added",
    add_attachment: "Attachment uploaded",
    download_attachment: "Attachment downloaded",
    update_ticket_status: "Status updated",
    admin_update_ticket: "Admin edited report",
  };
  return map[action] || action.replaceAll("_", " ");
}

function FieldBlock({ label, value }: DetailItem) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-900">{value}</div>
    </div>
  );
}

function TextInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <label className="block text-sm text-slate-700">
      <span className="mb-1 block font-medium">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-slate-300 px-3 py-2"
      />
    </label>
  );
}

function TextAreaInput({ label, value, onChange, rows = 4, placeholder }: { label: string; value: string; onChange: (value: string) => void; rows?: number; placeholder?: string }) {
  return (
    <label className="block text-sm text-slate-700">
      <span className="mb-1 block font-medium">{label}</span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="w-full rounded-md border border-slate-300 px-3 py-2"
      />
    </label>
  );
}

function SelectInput({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[] }) {
  return (
    <label className="block text-sm text-slate-700">
      <span className="mb-1 block font-medium">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2">
        <option value="">Select</option>
        {options.map((option) => (
          <option value={option} key={option}>
            {fmt(option)}
          </option>
        ))}
      </select>
    </label>
  );
}

function BooleanInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="block text-sm text-slate-700">
      <span className="mb-2 block font-medium">{label}</span>
      <div className="bool-radio-group">
        <label>
          <input type="radio" value="true" checked={value === "true"} onChange={() => onChange("true")} />
          Yes
        </label>
        <label>
          <input type="radio" value="false" checked={value === "false"} onChange={() => onChange("false")} />
          No
        </label>
        {value !== "true" && value !== "false" && (
          <label>
            <input type="radio" value="" checked onChange={() => {}} />
            <span className="text-slate-400">Not set</span>
          </label>
        )}
      </div>
    </div>
  );
}

function UserSelectInput({ label, value, onChange, options }: {
  label: string;
  value: string;
  onChange: (email: string) => void;
  options: UserRoleOption[];
}) {
  return (
    <label className="block text-sm text-slate-700">
      <span className="mb-1 block font-medium">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-md border border-slate-300 px-3 py-2"
      >
        <option value="">Unassigned</option>
        {options.map((option) => (
          <option key={option.email} value={option.email}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function TicketDetailView({ ticketId, user, backPath, canEdit, showAudit }: TicketDetailViewProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { showToast } = useToast();

  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [success, setSuccess] = useState("");
  const [ticket, setTicket] = useState<TicketData | null>(null);
  const [comments, setComments] = useState<TicketComment[]>([]);
  const [attachments, setAttachments] = useState<TicketAttachment[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [loadWarnings, setLoadWarnings] = useState<string[]>([]);
  const [commentInput, setCommentInput] = useState("");
  const [newFiles, setNewFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [commentSubmitting, setCommentSubmitting] = useState(false);
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(null);
  const [filesUploading, setFilesUploading] = useState(false);
  const [downloadingAttachmentId, setDownloadingAttachmentId] = useState<string | null>(null);
  const [previewingAttachmentId, setPreviewingAttachmentId] = useState<string | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<AttachmentPreviewState | null>(null);
  const isEditing = false;
  const [showAllAudit, setShowAllAudit] = useState(false);
  const [activeTab, setActiveTab] = useState<ActivityTab>("details");
  const [showReporterCompleteEditor, setShowReporterCompleteEditor] = useState(false);
  const [quickIssueType, setQuickIssueType] = useState("cyber");
  const [quickStatus, setQuickStatus] = useState("open");
  const [quickSeverity, setQuickSeverity] = useState("");
  const [quickCategory, setQuickCategory] = useState("");
  const [quickAssignedToEmail, setQuickAssignedToEmail] = useState("");
  const [reporterDraft, setReporterDraft] = useState<Record<string, string>>({});
  const [reporterSaving, setReporterSaving] = useState(false);
  const [userLabels, setUserLabels] = useState<Record<string, string>>({});
  const [adminUsers, setAdminUsers] = useState<UserRoleOption[]>([]);

  const loadAll = useCallback(async () => {
    setState("loading");
    setError("");
    setLoadWarnings([]);

    try {
      const ticketData = await getTicketDetail(ticketId);
      setTicket(ticketData as TicketData);

      const tasks: PromiseSettledResult<unknown>[] = await Promise.allSettled([
        getTicketComments(ticketId),
        getTicketAttachments(ticketId),
        showAudit ? getTicketAuditLogs(ticketId) : Promise.resolve([]),
      ]);

      const nextWarnings: string[] = [];

      const commentsResult = tasks[0];
      if (commentsResult.status === "fulfilled") {
        setComments(commentsResult.value as TicketComment[]);
      } else {
        setComments([]);
        const message = commentsResult.reason instanceof Error ? commentsResult.reason.message : String(commentsResult.reason);
        nextWarnings.push(isPermissionError(message) ? "Comments are temporarily unavailable." : `Comments could not be loaded: ${message}`);
      }

      const attachmentsResult = tasks[1];
      if (attachmentsResult.status === "fulfilled") {
        setAttachments(attachmentsResult.value as TicketAttachment[]);
      } else {
        setAttachments([]);
        const message = attachmentsResult.reason instanceof Error ? attachmentsResult.reason.message : String(attachmentsResult.reason);
        nextWarnings.push(isPermissionError(message) ? "Attachments are temporarily unavailable." : `Attachments could not be loaded: ${message}`);
      }

      const auditResult = tasks[2];
      if (auditResult.status === "fulfilled") {
        setAuditLogs(auditResult.value as AuditLog[]);
      } else {
        setAuditLogs([]);
        const message = auditResult.reason instanceof Error ? auditResult.reason.message : String(auditResult.reason);
        nextWarnings.push(isPermissionError(message) ? "Audit history is temporarily unavailable." : `Audit trail could not be loaded: ${message}`);
      }

      setLoadWarnings(nextWarnings);

      // Resolve all UIDs to human-readable labels
      const uidSet = new Set<string>();
      const maybeAdd = (v: unknown) => { if (typeof v === "string" && v) uidSet.add(v); };
      const td = ticketData as Record<string, unknown>;
      maybeAdd(td.created_by_email);
      maybeAdd(td.assigned_to_email);
      maybeAdd(td.closed_by_email);
      maybeAdd(td.updated_by_email);
      if (auditResult.status === "fulfilled") {
        (auditResult.value as AuditLog[]).forEach((log) => maybeAdd(log.actor_email));
      }
      const labels = await resolveUserLabels([...uidSet]);
      setUserLabels(labels);

      setState("ok");
    } catch (err) {
      const message = toUserFacingMessage(err, {
        fallback: "Unable to load this ticket right now. Please try again.",
      });
      if (message.toLowerCase().includes("not found")) {
        setState("missing");
      } else {
        setState("error");
        setError(message);
        showToast({
          type: "error",
          title: "Ticket failed to load.",
          message,
          action: {
            label: "Retry",
            onClick: () => {
              void loadAll();
            },
          },
        });
        trackUxEvent("ticket_detail_load_failed", {
          page: canEdit ? "admin_ticket_detail" : "reporter_ticket_detail",
          action: "load",
          outcome: "error",
          message,
        });
      }
    }
  }, [canEdit, showAudit, showToast, ticketId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Auto-dismiss success message after 3 seconds
  useEffect(() => {
    if (success) {
      const timer = setTimeout(() => setSuccess(""), 3000);
      return () => clearTimeout(timer);
    }
  }, [success]);

  useEffect(() => {
    if (!canEdit) return;
    listUsersByRole("admin")
      .then((users) => {
        setAdminUsers(users);
      })
      .catch(() => {
        setAdminUsers([]);
      });
  }, [canEdit]);

  useEffect(() => {
    if (info && !commentSubmitting && !filesUploading && !downloadingAttachmentId) {
      const timer = setTimeout(() => setInfo(""), 2000);
      return () => clearTimeout(timer);
    }
  }, [commentSubmitting, downloadingAttachmentId, filesUploading, info]);

  useEffect(() => {
    if (!showAudit && activeTab === "audit") {
      setActiveTab("details");
    }
  }, [activeTab, showAudit]);

  useEffect(() => {
    if (!ticket) return;
    setQuickIssueType(asRawText(ticket.issue_type, "cyber"));
    setQuickStatus(asRawText(ticket.status, "open"));
    setQuickSeverity(asRawText(ticket.severity));
    setQuickCategory(asRawText(ticket.category));
    setQuickAssignedToEmail(asRawText(ticket.assigned_to_email));
  }, [ticket]);

  useEffect(() => {
    if (canEdit) {
      setShowReporterCompleteEditor(false);
    }
  }, [canEdit]);

  useEffect(() => {
    if (!ticket || canEdit) return;
    const nextDraft: Record<string, string> = {};
    Object.keys(REPORTER_EDITABLE_FIELD_CONFIG).forEach((field) => {
      nextDraft[field] = toReporterDraftValue(ticket[field]);
    });
    setReporterDraft(nextDraft);
  }, [canEdit, ticket]);

  const labelFor = (v: unknown): string => {
    const str = String(v ?? "");
    return str ? (userLabels[str] || str) : "-";
  };

  const labelForAssignedTo = (): string => {
    const assignedName = String(ticket?.assigned_to_name || "").trim();
    if (assignedName) return assignedName;
    return labelFor(ticket?.assigned_to_email);
  };

  const summary = useMemo(() => {
    if (!ticket) return null;
    return {
      ticketId: asText(ticket.ticket_id, ticketId),
      issueType: asText(ticket.issue_type, "cyber"),
      status: asText(ticket.status),
      severity: asText(ticket.severity),
      category: asText(ticket.category),
      createdAt: asText(ticket.created_at),
      updatedAt: asText(ticket.updated_at),
      createdBy: labelFor(ticket.created_by_email),
      assignedTo: labelForAssignedTo(),
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket, ticketId, userLabels]);

  const assigneeOptions = useMemo(() => {
    const map = new Map<string, string>();
    adminUsers.forEach((userOption) => {
      map.set(userOption.email, userOption.label);
    });

    if (quickAssignedToEmail && !map.has(quickAssignedToEmail)) {
      map.set(quickAssignedToEmail, userLabels[quickAssignedToEmail] || quickAssignedToEmail);
    }

    return [...map.entries()].map(([email, label]) => ({ email, label }));
  }, [adminUsers, quickAssignedToEmail, userLabels]);

  const navState = (location.state as TicketDetailNavState | null) ?? null;
  const notificationHint = normalizeUpdateHint(navState?.updateHint);
  const ticketHint = normalizeUpdateHint(ticket?.last_update_hint);
  const updatedByEmail = String(ticket?.updated_by_email || "").trim();
  const ticketUpdatedByOther = !canEdit && !!updatedByEmail && updatedByEmail !== user.email;
  const ticketUpdateUnknownActorButMeaningful = !canEdit && !updatedByEmail && hasMeaningfulUpdateHint(ticket?.last_update_hint);
  const fromNotification = !canEdit && !!navState?.fromNotification && !!notificationHint;
  const reporterUpdateHint = fromNotification
    ? notificationHint
    : ((ticketUpdatedByOther || ticketUpdateUnknownActorButMeaningful) ? ticketHint : "");
  const canClaimTicket = canEdit && state === "ok" && !String(ticket?.assigned_to_email || "").trim();

  const activityTabs = useMemo(() => {
    const tabs: Array<{ key: ActivityTab; label: string; count: number }> = [
      { key: "details", label: "Full Details", count: 1 },
      { key: "comments", label: "Comments", count: comments.length },
      { key: "attachments", label: "Attachments", count: attachments.length },
    ];

    if (showAudit) {
      tabs.push({ key: "audit", label: "Audit History", count: auditLogs.length });
    }

    return tabs;
  }, [attachments.length, auditLogs.length, comments.length, showAudit]);

  const workspaceSubtitle = showAudit
    ? "Top panels are processing views. Tabs below are the raw record workspace."
    : "Top panels are processing views. Tabs below are the raw record workspace.";

  const reporterMissingFieldKeys = useMemo(() => {
    if (!ticket || canEdit) return [];
    return getReporterMissingFieldKeys(ticket).filter((field) => field in REPORTER_EDITABLE_FIELD_CONFIG);
  }, [canEdit, ticket]);

  const reporterVisibleMissingFieldKeys = useMemo(() => {
    if (!ticket || canEdit) return [];

    return reporterMissingFieldKeys.filter((field) => {
      if (field === "category_other_text") {
        const categoryValue = String(reporterDraft.category || ticket.category || "").trim().toLowerCase();
        return categoryValue === "other";
      }
      if (field === "response_details") {
        const responseTaken = reporterDraft.response_taken || toReporterDraftValue(ticket.response_taken);
        return responseTaken === "true";
      }
      if (field === "external_party_details") {
        const externalPartyInvolved =
          reporterDraft.external_party_involved || toReporterDraftValue(ticket.external_party_involved);
        return externalPartyInvolved === "true";
      }
      if (field === "reported_to_details") {
        const alreadyReported =
          reporterDraft.already_reported_to_it || toReporterDraftValue(ticket.already_reported_to_it);
        return alreadyReported === "true";
      }
      if (field === "data_other_text") {
        const dataInvolved = reporterDraft.data_involved_flag || toReporterDraftValue(ticket.data_involved_flag);
        return dataInvolved === "true";
      }
      if (field === "phone_number") {
        const preferredContact = String(reporterDraft.preferred_contact_method || ticket.preferred_contact_method || "").toLowerCase();
        return preferredContact === "phone";
      }
      return true;
    });
  }, [canEdit, reporterDraft, reporterMissingFieldKeys, ticket]);

  const handleReporterDraftField = (field: string, value: string) => {
    setReporterDraft((prev) => ({ ...prev, [field]: value }));
  };

  const handleReporterMissingUpdate = async () => {
    if (reporterSaving || reporterVisibleMissingFieldKeys.length === 0) return;

    const updates: Record<string, FirestoreValue> = {};
    reporterVisibleMissingFieldKeys.forEach((field) => {
      const config = REPORTER_EDITABLE_FIELD_CONFIG[field];
      const raw = reporterDraft[field] ?? "";

      if (config.type === "boolean") {
        if (raw === "true" || raw === "false") {
          updates[field] = raw === "true";
        }
        return;
      }

      const trimmed = raw.trim();
      if (!trimmed) return;
      updates[field] = trimmed;
    });

    if (Object.keys(updates).length === 0) {
      setError("Please fill at least one missing field before saving.");
      return;
    }

    setReporterSaving(true);
    setError("");
    setInfo("Saving missing fields...");
    setSuccess("");
    try {
      await updateTicketReporterMissingFields(ticketId, updates, user.email || "");
      await loadAll();
      setSuccess("Missing fields were updated successfully.");
      showToast({
        type: "success",
        title: "Missing fields saved.",
        durationMs: 2200,
      });
    } catch (err) {
      const message = toUserFacingMessage(err, {
        fallback: "Unable to save missing fields right now. Please try again.",
      });
      setError(message);
      showToast({
        type: "error",
        title: "Save failed.",
        message,
      });
    } finally {
      setReporterSaving(false);
    }
  };

  const displaySections = useMemo(() => {
    if (!ticket) return [];
    const issueType = String(ticket.issue_type || "cyber").trim().toLowerCase();
    const isITSupport = issueType === "it_support";

    // Hide a child item when its parent boolean is not explicitly true.
    const when = (condition: unknown, item: DetailItem): DetailItem | null =>
      condition === true ? item : null;

    // Build a section and filter out items that have no meaningful content.
    // Both "-" (asText fallback) and "—" (fmt fallback) are treated as empty.
    const makeSection = (
      title: string,
      rawItems: (DetailItem | null)[]
    ): { title: string; items: DetailItem[] } | null => {
      const lowSignalNo = new Set([
        "Incident still active",
        "Response taken",
        "External party involved",
        "Reported to IT",
        "Sensitive data involved",
      ]);

      const items = rawItems.filter(
        (item): item is DetailItem =>
          item !== null &&
          item.value !== "-" &&
          item.value !== "—" &&
          item.value !== "" &&
          !(item.value === "No" && lowSignalNo.has(item.label))
      );
      return items.length > 0 ? { title, items } : null;
    };

    const dataInvolvedList = Array.isArray(ticket.data_involved)
      ? (ticket.data_involved as string[])
          .map((v) => fmt(v))
          .filter((s) => s !== "—")
          .join(", ")
      : "";
    const hasOtherData =
      Array.isArray(ticket.data_involved) &&
      (ticket.data_involved as string[]).includes("other");

    const sections = [
      // Description is already shown in the dedicated card above; omit here.
      makeSection(isITSupport ? "Core Support Request" : "Core Incident", [
        createSection("Issue type", fmt(ticket.issue_type)),
        createSection("Classification", ticket.classification),
        createSection("When noticed", fmt(ticket.noticed_time)),
        ticket.location_type
          ? createSection("Location type", fmt(ticket.location_type))
          : null,
        ticket.location_type && ticket.location_detail
          ? createSection("Location detail", ticket.location_detail)
          : null,
        ticket.category === "other"
          ? createSection("Category detail", ticket.category_other_text)
          : null,
      ]),

      makeSection(isITSupport ? "Impact & Technical Scope" : "Impact & Data", [
        createSection("Impact scope", ticket.impact_scope),
        createSection("Work continuity", ticket.work_continuity),
        isITSupport ? createSection("Affected asset", ticket.affected_asset) : null,
        isITSupport ? createSection("Error symptom", ticket.error_symptom) : null,
        // Show the flag itself; if true, also show the breakdown list.
        !isITSupport ? createSection("Sensitive data involved", ticket.data_involved_flag) : null,
        ticket.data_involved_flag === true && dataInvolvedList
          ? createSection("Types of data", dataInvolvedList)
          : null,
        ticket.data_involved_flag === true && hasOtherData
          ? createSection("Other data details", ticket.data_other_text)
          : null,
      ]),

      makeSection(isITSupport ? "Response Details" : "Response & Escalation", [
        createSection("Incident still active", ticket.incident_active),
        createSection("Response taken", ticket.response_taken),
        when(
          ticket.response_taken,
          createSection("Response details", ticket.response_details)
        ),
        !isITSupport ? createSection("External party involved", ticket.external_party_involved) : null,
        !isITSupport && ticket.external_party_involved === true
          ? createSection("External party details", ticket.external_party_details)
          : null,
        !isITSupport ? createSection("Reported to IT", ticket.already_reported_to_it) : null,
        !isITSupport && ticket.already_reported_to_it === true
          ? createSection("IT report details", ticket.reported_to_details)
          : null,
      ]),

      makeSection("Contact & Ownership", [
        ticket.preferred_contact_method
          ? createSection(
              "Preferred contact",
              ticket.preferred_contact_method === "email" && ticket.contact_email
                ? `Email (${ticket.contact_email})`
                : fmt(ticket.preferred_contact_method)
            )
          : null,
        ticket.preferred_contact_method === "phone"
          ? createSection("Phone", ticket.phone_number)
          : null,
        ticket.preferred_contact_method !== "email"
          ? createSection("Contact email", ticket.contact_email)
          : null,
        createSection("Assigned to", labelForAssignedTo()),
      ]),
    ];

    return sections.filter((s): s is NonNullable<typeof s> => s !== null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket, userLabels]);

  const handleAddComment = async () => {
    if (!commentInput.trim()) return;
    setCommentSubmitting(true);
    setError("");
    setInfo("Submitting comment......");
    setSuccess("");
    try {
      await addTicketComment(ticketId, commentInput, user.email || "");
      setCommentInput("");
      // only reload comments, no full page reload
      const freshComments = await getTicketComments(ticketId);
      setComments(freshComments);
      setSuccess("Comment posted successfully.");
      showToast({
        type: "success",
        title: "Comment posted.",
        durationMs: 2200,
      });
      trackUxEvent("ticket_comment_added", {
        page: canEdit ? "admin_ticket_detail" : "reporter_ticket_detail",
        action: "add_comment",
        outcome: "success",
      });
    } catch (err) {
      const message = toUserFacingMessage(err, {
        fallback: "Unable to post comment right now. Please try again.",
      });
      setError(message);
      showToast({
        type: "error",
        title: "Comment failed.",
        message,
      });
      trackUxEvent("ticket_comment_failed", {
        page: canEdit ? "admin_ticket_detail" : "reporter_ticket_detail",
        action: "add_comment",
        outcome: "error",
        message,
      });
    } finally {
      setCommentSubmitting(false);
    }
  };

  const handleAddFiles = async () => {
    if (newFiles.length === 0) return;
    const filesToUpload = [...newFiles];
    setFilesUploading(true);
    setError("");
    setInfo(`Uploading ${filesToUpload.length} file(s)...`);
    setSuccess("");
    try {
      await Promise.all(filesToUpload.map((file) => addTicketAttachment(ticketId, file, user.email || "", user.email)));
      setNewFiles([]);
      // only reload attachments, no full page reload
      const freshAttachments = await getTicketAttachments(ticketId);
      setAttachments(freshAttachments);
      setSuccess(`Uploaded ${filesToUpload.length} file(s) successfully.`);
      showToast({
        type: "success",
        title: "Files uploaded.",
        message: `${filesToUpload.length} file(s) uploaded successfully.`,
        durationMs: 2500,
      });
      trackUxEvent("ticket_attachment_uploaded", {
        page: canEdit ? "admin_ticket_detail" : "reporter_ticket_detail",
        action: "upload_attachment",
        outcome: "success",
      });
    } catch (err) {
      const message = toUserFacingMessage(err, {
        fallback: "Unable to upload files right now. Please try again.",
      });
      setError(message);
      showToast({
        type: "error",
        title: "File upload failed.",
        message,
      });
      trackUxEvent("ticket_attachment_upload_failed", {
        page: canEdit ? "admin_ticket_detail" : "reporter_ticket_detail",
        action: "upload_attachment",
        outcome: "error",
        message,
      });
    } finally {
      setFilesUploading(false);
    }
  };

  const handleDeleteComment = async (comment: TicketComment) => {
    if (!comment.id) return;
    setDeletingCommentId(comment.id);
    setError("");
    setInfo("Deleting comment...");
    setSuccess("");
    try {
      await deleteTicketComment(ticketId, comment.id, user.email || "");
      const freshComments = await getTicketComments(ticketId);
      setComments(freshComments);
      setSuccess("Comment deleted successfully.");
      showToast({
        type: "success",
        title: "Comment deleted.",
        durationMs: 2200,
      });
      trackUxEvent("ticket_comment_deleted", {
        page: canEdit ? "admin_ticket_detail" : "reporter_ticket_detail",
        action: "delete_comment",
        outcome: "success",
      });
    } catch (err) {
      const message = toUserFacingMessage(err, {
        fallback: "Unable to delete comment right now. Please try again.",
      });
      setError(message);
      showToast({
        type: "error",
        title: "Delete failed.",
        message,
      });
      trackUxEvent("ticket_comment_delete_failed", {
        page: canEdit ? "admin_ticket_detail" : "reporter_ticket_detail",
        action: "delete_comment",
        outcome: "error",
        message,
      });
    } finally {
      setDeletingCommentId(null);
    }
  };


  const handleDownloadAttachment = async (attachment: TicketAttachment) => {
    const fileName = attachment.name || "attachment";
    setDownloadingAttachmentId(attachment.id);
    setError("");
      setInfo(`Preparing download for ${fileName}...`);
    setSuccess("");
    try {
      const blob = await downloadTicketAttachment(ticketId, attachment.id);
      const blobUrl = window.URL.createObjectURL(blob);

      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();

      // Revoke after click so browser has time to consume the object URL.
      window.setTimeout(() => {
        window.URL.revokeObjectURL(blobUrl);
      }, 1000);
      setSuccess(`${fileName} download started.`);
      showToast({
        type: "success",
        title: "Download started.",
        message: fileName,
        durationMs: 2000,
      });
      trackUxEvent("ticket_attachment_download_started", {
        page: canEdit ? "admin_ticket_detail" : "reporter_ticket_detail",
        action: "download_attachment",
        outcome: "success",
      });
    } catch (err) {
      const message = toUserFacingMessage(err, {
        fallback: "Unable to download this file right now. Please try again.",
      });
      setError(message || "Failed to download file");
      showToast({
        type: "error",
        title: "Download failed.",
        message,
      });
      trackUxEvent("ticket_attachment_download_failed", {
        page: canEdit ? "admin_ticket_detail" : "reporter_ticket_detail",
        action: "download_attachment",
        outcome: "error",
        message,
      });
    } finally {
      setDownloadingAttachmentId(null);
    }
  };

  const handlePreviewAttachment = async (attachment: TicketAttachment) => {
    const previewKind = detectAttachmentPreviewKind(attachment);
    setError("");
    setSuccess("");
    setInfo("");

    if (previewKind === "unsupported") {
      showToast({
        type: "warning",
        title: "Preview unavailable.",
        message: "This file type cannot be previewed here yet, but you can still download it.",
        durationMs: 2600,
      });
      return;
    }

    setPreviewingAttachmentId(attachment.id);
    try {
      if (previewKind === "text") {
        const response = await fetch(attachment.download_url);
        if (!response.ok) throw new Error(`Preview failed: ${response.status}`);
        const textContent = await response.text();
        setAttachmentPreview({
          attachment,
          kind: previewKind,
          textContent,
        });
      } else {
        setAttachmentPreview({
          attachment,
          kind: previewKind,
        });
      }
    } catch (err) {
      const message = toUserFacingMessage(err, {
        fallback: "Unable to preview this file right now. Please try downloading it instead.",
      });
      setError(message);
      showToast({
        type: "error",
        title: "Preview failed.",
        message,
      });
    } finally {
      setPreviewingAttachmentId(null);
    }
  };
  const handleQuickAdminUpdate = async () => {
    setBusy(true);
    setError("");
    try {
      await updateTicketAdminFields(
        ticketId,
        {
          issue_type: quickIssueType,
          status: quickStatus,
          severity: quickSeverity,
          category: quickCategory,
          assigned_to_email: quickAssignedToEmail.trim() || null,
          assigned_to_name: quickAssignedToEmail.trim()
            ? (assigneeOptions.find((option) => option.email === quickAssignedToEmail)?.label || quickAssignedToEmail)
            : null,
        },
        user.email || ""
      );
      await loadAll();
      showToast({
        type: "success",
        title: "Triage fields updated.",
        message: "Status, severity, category and assignment were saved.",
        durationMs: 2200,
      });
      trackUxEvent("ticket_admin_quick_update_success", {
        page: "admin_ticket_detail",
        action: "quick_update",
        outcome: "success",
      });
    } catch (err) {
      const message = toUserFacingMessage(err, {
        fallback: "Unable to save triage fields right now. Please try again.",
      });
      setError(message);
      showToast({
        type: "error",
        title: "Quick update failed.",
        message,
      });
      trackUxEvent("ticket_admin_quick_update_failed", {
        page: "admin_ticket_detail",
        action: "quick_update",
        outcome: "error",
        message,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleClaimTicket = async () => {
    setBusy(true);
    setError("");
    try {
      await claimTicket(ticketId);
      await loadAll();
      showToast({
        type: "success",
        title: "Ticket claimed.",
        message: "This ticket is now assigned to you.",
        durationMs: 2200,
      });
      trackUxEvent("ticket_claim_success", {
        page: "admin_ticket_detail",
        action: "claim_ticket",
        outcome: "success",
      });
    } catch (err) {
      const message = toUserFacingMessage(err, {
        fallback: "Unable to claim this ticket right now. It may already be assigned.",
      });
      setError(message);
      showToast({
        type: "error",
        title: "Claim failed.",
        message,
      });
      trackUxEvent("ticket_claim_failed", {
        page: "admin_ticket_detail",
        action: "claim_ticket",
        outcome: "error",
        message,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-8">
      <div className="mx-auto max-w-7xl space-y-4">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 flex-1 space-y-3">
              <button onClick={() => navigate(backPath)} className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
                Back
              </button>
              <div>
                <div className="text-xs uppercase tracking-[0.24em] text-slate-500">Case Workspace</div>
                <h1 className="mt-2 text-4xl font-extrabold tracking-tight text-slate-900">{summary?.ticketId || ticketId}</h1>
                <p className="mt-2 max-w-3xl text-sm text-slate-600">
                  Created: {fmtDatetime(ticket?.created_at)} | Reporter: {summary?.createdBy || "-"}
                </p>
              </div>
            </div>

            <div className="w-full lg:basis-[38%] lg:pl-4">
              <div className="flex flex-wrap items-center justify-start gap-2 lg:justify-end">
                <span className="rounded-full bg-blue-100 px-3 py-1 text-xs font-semibold text-blue-800">Status: {fmt(summary?.status)}</span>
                <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800">Severity: {fmt(summary?.severity)}</span>
                <span className="rounded-full bg-slate-200 px-3 py-1 text-xs font-semibold text-slate-700">Category: {fmt(summary?.category)}</span>
                <span className="rounded-full bg-cyan-100 px-3 py-1 text-xs font-semibold text-cyan-800">Type: {fmt(summary?.issueType)}</span>
              </div>
              <div className="mt-3 text-sm text-slate-600 lg:text-right">
                Assigned to: <span className="font-semibold text-slate-900">{summary?.assignedTo || "-"}</span>
              </div>
              {canClaimTicket && (
                <div className="mt-3 flex justify-start lg:justify-end">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleClaimTicket()}
                    className="rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busy ? "Claiming..." : "Claim Ticket"}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        {info && <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-700">{info}</div>}
        {success && <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{success}</div>}
        {state === "ok" && reporterUpdateHint && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Recent update: {reporterUpdateHint}
          </div>
        )}
        {loadWarnings.map((warning) => <div key={warning} className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{warning}</div>)}
        {state === "missing" && <div className="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-600">Ticket not found.</div>}

        {state === "ok" && (
          <div className="space-y-5">
            {canEdit && !isEditing ? (
              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="grid grid-cols-1 items-stretch gap-5 xl:grid-cols-2">
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
                    <h2 className="text-xl font-semibold text-slate-900">Triage Decision View</h2>
                    <p className="mt-1 text-sm text-slate-600">Fast decision summary only.</p>

                    <div className="mt-4 space-y-4 min-h-[430px]">
                      <div className="rounded-xl border border-slate-200 bg-white p-4">
                        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Core Signal</div>
                        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <FieldBlock label="Issue type" value={fmt(ticket?.issue_type)} />
                          <FieldBlock label="Category" value={fmt(ticket?.category)} />
                          <FieldBlock label="Severity" value={fmt(ticket?.severity)} />
                          <FieldBlock label="Status" value={fmt(ticket?.status)} />
                          <FieldBlock label="Reporter" value={summary?.createdBy || "-"} />
                        </div>
                      </div>

                      <div className="rounded-xl border border-slate-200 bg-white p-4">
                        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Risk Summary</div>
                        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <FieldBlock label="Impact" value={fmt(ticket?.impact_scope)} />
                          <FieldBlock label="Work continuity" value={asText(ticket?.work_continuity)} />
                          <FieldBlock label="Incident active" value={asText(ticket?.incident_active)} />
                          {String(ticket?.issue_type || "").toLowerCase() === "it_support" ? (
                            <>
                              <FieldBlock label="Affected asset" value={asText(ticket?.affected_asset)} />
                            </>
                          ) : null}
                        </div>
                        <div className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-900">
                          {asText(ticket?.description)}
                        </div>
                        {ticket?.response_taken === true ? (
                          <div className="mt-3 text-sm text-slate-700">
                            Response details: {asText(ticket?.response_details)}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
                    <h2 className="text-xl font-semibold text-slate-900">Admin Quick Actions</h2>
                    <p className="mt-1 text-sm text-slate-600">Primary action panel for status and assignment updates.</p>
                    <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Status Update</div>
                      <div className="mt-3 grid grid-cols-1 gap-4">
                        <SelectInput label="Issue type" value={quickIssueType} onChange={setQuickIssueType} options={ISSUE_TYPE_OPTIONS} />
                        <SelectInput label="Status" value={quickStatus} onChange={setQuickStatus} options={STATUS_OPTIONS} />
                        <SelectInput label="Severity" value={quickSeverity} onChange={setQuickSeverity} options={SEVERITY_OPTIONS} />
                        <SelectInput label="Category" value={quickCategory} onChange={setQuickCategory} options={CATEGORY_OPTIONS} />
                        <UserSelectInput
                          label="Assigned to"
                          value={quickAssignedToEmail}
                          onChange={setQuickAssignedToEmail}
                          options={assigneeOptions}
                        />
                      </div>
                    </div>

                    <div className="mt-5 flex flex-wrap gap-3">
                      <button
                        type="button"
                        onClick={handleQuickAdminUpdate}
                        disabled={busy}
                        className="rounded-md bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-60"
                      >
                        Save Triage Updates
                      </button>
                    </div>

                    <div className="mt-5 rounded-xl border border-slate-200 bg-white/70 p-4">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Metadata</div>
                      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <FieldBlock label="Assigned to" value={summary?.assignedTo || "-"} />
                        <FieldBlock label="Updated at" value={summary?.updatedAt || "-"} />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="flex flex-col gap-6 xl:flex-row xl:items-stretch">
                  <div className="min-w-0 flex-[1.35] rounded-2xl border border-slate-200 bg-slate-50 p-5">
                    <div className="text-sm font-semibold uppercase tracking-wide text-slate-500">Description</div>
                    <div className="mt-3 min-h-[10rem] whitespace-pre-wrap break-words rounded-2xl bg-white p-5 text-base leading-7 text-slate-900 shadow-sm">
                      {asText(ticket?.description)}
                    </div>
                  </div>
                  <div className="flex-1 rounded-2xl border border-slate-200 bg-white p-5">
                    <div>
                      <h2 className="text-xl font-semibold text-slate-900">Key Report Snapshot</h2>
                      <p className="mt-1 text-sm text-slate-600">Show the main facts first, then switch to the detailed workspace below.</p>
                    </div>
                    <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <FieldBlock label="Issue type" value={fmt(ticket?.issue_type)} />
                      <FieldBlock label="Incident active" value={asText(ticket?.incident_active)} />
                      <FieldBlock label="When noticed" value={fmt(ticket?.noticed_time)} />
                      <FieldBlock label="Impact scope" value={asText(ticket?.impact_scope)} />
                      <FieldBlock label="Work continuity" value={asText(ticket?.work_continuity)} />
                      {String(ticket?.issue_type || "").toLowerCase() === "it_support" ? (
                        <>
                          <FieldBlock label="Affected asset" value={asText(ticket?.affected_asset)} />
                          <FieldBlock label="Error symptom" value={asText(ticket?.error_symptom)} />
                        </>
                      ) : null}
                      <FieldBlock label="Created by" value={summary?.createdBy || "-"} />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {null}

            <div className="rounded-3xl border border-slate-200 bg-white shadow-sm overflow-hidden">
              <div className="border-b border-slate-100 bg-slate-50/80 px-6 py-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <h2 className="text-xl font-semibold text-slate-900">Case Workspace Panels</h2>
                    <p className="mt-1 text-sm text-slate-600">{workspaceSubtitle}</p>
                    <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Default: Full Details (Raw Record)</p>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
                    <div className="flex flex-wrap gap-2">
                    {activityTabs.map((tab) => {
                      const active = activeTab === tab.key;
                      return (
                        <button
                          key={tab.key}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setActiveTab(tab.key)}
                          className={`inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 ${active ? "border-slate-900 bg-slate-900 text-white shadow-sm" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-100"}`}
                        >
                          <span>{tab.label}</span>
                          <span className={`rounded-full px-2 py-0.5 text-xs ${active ? "bg-white/15 text-white" : "bg-white text-slate-600"}`}>{tab.count}</span>
                        </button>
                      );
                    })}
                    </div>
                  </div>
                </div>
              </div>

              <div className="p-6">
                {activeTab === "details" && (
                  <div className="space-y-4">
                    {!canEdit && reporterVisibleMissingFieldKeys.length > 0 && !showReporterCompleteEditor && (
                      <div className="rounded-3xl border border-amber-200 bg-amber-50 px-6 py-5 shadow-sm">
                        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                          <div className="min-w-0">
                            <h3 className="text-lg font-semibold text-amber-900">There are missing fields to complete</h3>
                            <p className="mt-1 text-sm text-amber-800">
                              {reporterVisibleMissingFieldKeys.length} field(s) are still missing. Click below to enter completion mode.
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => setShowReporterCompleteEditor(true)}
                            className="rounded-md bg-amber-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-amber-700"
                          >
                            Complete Missing Info
                          </button>
                        </div>
                      </div>
                    )}

                    {!canEdit && reporterVisibleMissingFieldKeys.length > 0 && showReporterCompleteEditor && (
                      <div className="rounded-3xl border border-amber-200 bg-amber-50 shadow-sm overflow-hidden">
                        <div className="border-b border-amber-200 bg-amber-100/70 px-6 py-5">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <h3 className="text-xl font-semibold text-amber-900">Complete Missing Fields</h3>
                            <button
                              type="button"
                              onClick={() => setShowReporterCompleteEditor(false)}
                              className="rounded-md border border-amber-300 bg-white px-4 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-100"
                            >
                              Back to Details
                            </button>
                          </div>
                          <p className="mt-1 text-sm text-amber-800">
                            You can only fill fields that are currently missing. Existing values remain locked.
                          </p>
                        </div>
                        <div className="p-6">
                          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                            {reporterVisibleMissingFieldKeys.map((field) => {
                              const config = REPORTER_EDITABLE_FIELD_CONFIG[field];
                              if (!config) return null;

                              if (config.type === "textarea") {
                                return (
                                  <TextAreaInput
                                    key={field}
                                    label={config.label}
                                    value={reporterDraft[field] || ""}
                                    onChange={(value) => handleReporterDraftField(field, value)}
                                    rows={3}
                                    placeholder={config.placeholder}
                                  />
                                );
                              }

                              if (config.type === "select") {
                                return (
                                  <SelectInput
                                    key={field}
                                    label={config.label}
                                    value={reporterDraft[field] || ""}
                                    onChange={(value) => handleReporterDraftField(field, value)}
                                    options={config.options || []}
                                  />
                                );
                              }

                              if (config.type === "boolean") {
                                return (
                                  <BooleanInput
                                    key={field}
                                    label={config.label}
                                    value={reporterDraft[field] || ""}
                                    onChange={(value) => handleReporterDraftField(field, value)}
                                  />
                                );
                              }

                              return (
                                <TextInput
                                  key={field}
                                  label={config.label}
                                  value={reporterDraft[field] || ""}
                                  onChange={(value) => handleReporterDraftField(field, value)}
                                  placeholder={config.placeholder}
                                />
                              );
                            })}
                          </div>

                          <div className="mt-5 flex flex-wrap gap-3">
                            <button
                              type="button"
                              onClick={handleReporterMissingUpdate}
                              disabled={reporterSaving || busy}
                              className="rounded-md bg-amber-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-amber-700 disabled:opacity-60"
                            >
                              {reporterSaving ? "Saving..." : "Save Missing Fields"}
                            </button>
                            <button
                              type="button"
                              onClick={() => void loadAll()}
                              disabled={reporterSaving || busy}
                              className="rounded-md border border-amber-300 bg-white px-5 py-2.5 text-sm font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-60"
                            >
                              Refresh
                            </button>
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="rounded-3xl border border-slate-200 bg-white shadow-sm overflow-hidden">
                      <div className="border-b border-slate-100 bg-slate-50/70 px-6 py-5">
                        <h3 className="text-xl font-semibold text-slate-900">Full Details</h3>
                        <p className="mt-1 text-sm text-slate-600">Only fields with recorded information are shown. Empty and not-applicable fields are hidden.</p>
                      </div>
                      {displaySections.length === 0 ? (
                        <div className="px-6 py-8 text-sm text-slate-500">
                          All key details are shown in the snapshot above. No additional recorded information.
                        </div>
                      ) : (
                        displaySections.map((section, idx) => (
                          <div key={section.title}>
                            {idx > 0 && <div className="border-t border-slate-100" />}
                            <div className="p-6">
                              <h4 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-500">{section.title}</h4>
                              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                                {section.items.map((item) => (
                                  <FieldBlock key={`${section.title}-${item.label}`} label={item.label} value={item.value} />
                                ))}
                              </div>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}

                {activeTab === "comments" && (
                  <div>
                    <div className="max-h-[30rem] space-y-3 overflow-y-auto pr-1">
                      {comments.length === 0 && <div className="text-sm text-slate-500">No comments yet.</div>}
                      {comments.map((comment) => {
                        const canDeleteOwnComment = comment.created_by_email === user.email;
                        const deleting = deletingCommentId === comment.id;
                        return (
                        <div key={comment.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="text-sm text-slate-800">{comment.message}</div>
                              <div className="mt-2 text-xs text-slate-500">{asText(comment.created_by_email)} | {asText(comment.created_at)}</div>
                            </div>
                            {canDeleteOwnComment && (
                              <button
                                type="button"
                                onClick={() => void handleDeleteComment(comment)}
                                disabled={deleting || commentSubmitting || filesUploading || busy}
                                className="rounded-md border border-rose-200 bg-white px-3 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {deleting ? "Deleting..." : "Delete"}
                              </button>
                            )}
                          </div>
                        </div>
                      );})}
                    </div>
                    <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
                      <textarea value={commentInput} onChange={(e) => setCommentInput(e.target.value)} rows={3} className="w-full rounded-md border border-slate-300 px-3 py-2" placeholder="Add a follow-up note" />
                      <button onClick={handleAddComment} disabled={commentSubmitting || filesUploading || busy || !commentInput.trim()} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60">
                        {commentSubmitting ? "Posting..." : "Add Comment"}
                      </button>
                    </div>
                  </div>
                )}

                {activeTab === "attachments" && (
                  <div>
                    <div className="max-h-[30rem] space-y-3 overflow-y-auto pr-1">
                      {attachments.length === 0 && <div className="text-sm text-slate-500">No attachments yet.</div>}
                      {attachmentPreview && (
                        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-semibold text-slate-900">
                                Previewing {attachmentPreview.attachment.name}
                              </div>
                              <div className="mt-1 text-xs text-slate-500">
                                {formatAttachmentMeta(attachmentPreview.attachment) || "Preview ready"}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => void handleDownloadAttachment(attachmentPreview.attachment)}
                                disabled={downloadingAttachmentId === attachmentPreview.attachment.id}
                                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-wait disabled:opacity-60"
                              >
                                {downloadingAttachmentId === attachmentPreview.attachment.id ? "Preparing..." : "Download"}
                              </button>
                              <button
                                type="button"
                                onClick={() => setAttachmentPreview(null)}
                                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                              >
                                Close Preview
                              </button>
                            </div>
                          </div>

                          {attachmentPreview.kind === "image" && (
                            <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-slate-100 p-2">
                              <img
                                src={attachmentPreview.attachment.download_url}
                                alt={attachmentPreview.attachment.name}
                                className="max-h-[28rem] w-full object-contain"
                              />
                            </div>
                          )}

                          {attachmentPreview.kind === "pdf" && (
                            <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
                              <iframe
                                src={attachmentPreview.attachment.download_url}
                                title={attachmentPreview.attachment.name}
                                className="h-[32rem] w-full bg-white"
                              />
                            </div>
                          )}

                          {attachmentPreview.kind === "text" && (
                            <pre className="mt-4 max-h-[32rem] overflow-auto rounded-xl border border-slate-200 bg-slate-950 p-4 text-xs text-slate-100 whitespace-pre-wrap">
                              {attachmentPreview.textContent || "(Empty file)"}
                            </pre>
                          )}
                        </div>
                      )}
                      {attachments.map((attachment) => (
                        <div key={attachment.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-semibold text-slate-900">{attachment.name}</div>
                              <div className="mt-1 text-xs text-slate-500">{asText(attachment.uploaded_by_email)} | {asText(attachment.uploaded_at)}</div>
                              <div className="mt-1 text-xs text-slate-400">
                                {formatAttachmentMeta(attachment) || "No preview metadata available"}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => void handlePreviewAttachment(attachment)}
                                disabled={previewingAttachmentId === attachment.id}
                                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-wait disabled:opacity-60"
                              >
                                {previewingAttachmentId === attachment.id ? "Opening..." : "Preview"}
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleDownloadAttachment(attachment)}
                                disabled={downloadingAttachmentId === attachment.id}
                                className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-wait disabled:bg-blue-400"
                              >
                                {downloadingAttachmentId === attachment.id ? "Preparing..." : "Download"}
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
                      <input type="file" multiple onChange={(e) => setNewFiles(Array.from(e.target.files || []))} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200" />
                      {newFiles.length > 0 && (
                        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-3">
                          <div className="text-sm font-semibold text-amber-900">Ready to upload {newFiles.length} file{newFiles.length > 1 ? "s" : ""}</div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {newFiles.map((file) => (
                              <span key={`${file.name}-${file.size}`} className="rounded-full bg-white px-3 py-1 text-xs text-slate-700 shadow-sm">{file.name}</span>
                            ))}
                          </div>
                        </div>
                      )}
                      <button onClick={handleAddFiles} disabled={commentSubmitting || filesUploading || busy || newFiles.length === 0} className="rounded-md bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-60">
                        {filesUploading ? "Uploading..." : "Upload Files"}
                      </button>
                    </div>
                  </div>
                )}

                {activeTab === "audit" && showAudit && (
                  <div>
                    <div className="space-y-3 overflow-y-auto pr-1" style={{ maxHeight: showAllAudit ? "none" : "30rem" }}>
                      {auditLogs.length === 0 && <div className="text-sm text-slate-500">No audit records found.</div>}
                      {(showAllAudit ? auditLogs : auditLogs.slice(0, 20)).map((log) => (
                        <div key={log.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-sm font-semibold text-slate-900">{getAuditTitle(String(log.action || "unknown"))}</div>
                            <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">{asText(log.status, "success")}</span>
                          </div>
                          <div className="mt-1 text-xs text-slate-500">Actor: {labelFor(log.actor_email)} | {log.created_at ? new Date(String(log.created_at)).toLocaleString() : "-"}</div>
                          {log.action === "admin_update_ticket" && (() => {
                            const details = (log.details || {}) as Record<string, unknown>;
                            const changes = typeof details.changes === "object" && details.changes
                              ? Object.entries(details.changes as Record<string, { before: unknown; after: unknown }>)
                              : [];
                            return changes.length > 0 ? (
                              <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 text-xs">
                                <div className="grid grid-cols-3 bg-slate-100 px-3 py-1.5 font-semibold text-slate-600">
                                  <span>Field</span><span>Before</span><span>After</span>
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
                            ) : null;
                          })()}
                        </div>
                      ))}
                    </div>
                    {auditLogs.length > 20 && (
                      <button onClick={() => setShowAllAudit((p) => !p)} className="mt-3 text-xs font-semibold text-blue-600 hover:underline">
                        {showAllAudit ? "Show less" : `Show all ${auditLogs.length} entries`}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
