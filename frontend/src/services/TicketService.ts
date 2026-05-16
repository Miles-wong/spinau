import { db, storage } from "../firebase";
import {
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  where,
  startAfter,
  doc,
  getDoc,
  updateDoc,
  setDoc,
  serverTimestamp,
  deleteField,
  type DocumentData,
  type QueryDocumentSnapshot,
  type QueryConstraint,
} from "firebase/firestore";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { formatFirestoreData } from "./FirestoreUtils";
import { logAuditEntry } from "./AuditService";
import { callBackendAPI } from "./AuthService";
import { logger } from "./logger";
import { buildStorageUploadErrorMessage, assertStorageUploadReady } from "./storageUploadDiagnostics";
import { notifyTicketEvent } from "./NotificationService";
import type { TicketDoc, CreateTicketInput, FirestoreValue, TicketAttachment, TicketRow } from "./ServiceTypes";
import { MAX_FILES, MAX_FILE_SIZE, MAX_TOTAL_SIZE } from "../constants/attachmentConfig";
import { getCategoryOptionsByIssueType } from "../constants/incidentSchema";

const ADMIN_EDITABLE_FIELDS = [
  "issue_type",
  "status",
  "assigned_to_email",
  "assigned_to_name",
  "category",
  "severity",
  "closure_summary",
  "lessons_learned",
  "closed_at",
  "closed_by_email",
  "duplicate_of_ticket_id",
  "related_ticket_ids",
] as const;

const ADMIN_FIELD_HINT_LABELS: Record<(typeof ADMIN_EDITABLE_FIELDS)[number], string> = {
  issue_type: "issue type",
  status: "status",
  assigned_to_email: "assignee",
  assigned_to_name: "assignee name",
  category: "category",
  severity: "severity",
  closure_summary: "closure",
  lessons_learned: "lessons",
  closed_at: "closed time",
  closed_by_email: "closed by",
  duplicate_of_ticket_id: "duplicate link",
  related_ticket_ids: "related tickets",
};

function toHintValue(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) return "-";
  return text.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildAdminUpdateHint(
  changedFields: Record<string, { before: unknown; after: unknown }>
): string {
  const changedKeys = Object.keys(changedFields);
  if (changedKeys.length === 0) return "";

  if (changedKeys.length === 1) {
    const key = changedKeys[0];
    const after = changedFields[key]?.after;

    if (key === "status") {
      return `status changed to ${toHintValue(after)}`;
    }
    if (key === "severity") {
      return `severity changed to ${toHintValue(after)}`;
    }
    if (key === "category") {
      return `category changed to ${toHintValue(after)}`;
    }
    if (key === "assigned_to_email") {
      return "assignee was updated";
    }
    if (key === "assigned_to_name") {
      return "assignee was updated";
    }

    const label = key in ADMIN_FIELD_HINT_LABELS
      ? ADMIN_FIELD_HINT_LABELS[key as keyof typeof ADMIN_FIELD_HINT_LABELS]
      : key.replaceAll("_", " ");
    return `${label} was updated`;
  }

  const labels = changedKeys.map((field) => {
    if (field in ADMIN_FIELD_HINT_LABELS) {
      return ADMIN_FIELD_HINT_LABELS[field as keyof typeof ADMIN_FIELD_HINT_LABELS];
    }
    return field.replaceAll("_", " ");
  });

  return `updated ${labels.slice(0, 3).join(", ")}${labels.length > 3 ? ` +${labels.length - 3} more` : ""}`;
}

function isPermissionDeniedError(error: unknown): boolean {
  const message = String(error || "").toLowerCase();
  return message.includes("permission-denied") || message.includes("missing or insufficient permissions");
}

function notifyTicketEventInBackground(params: {
  eventType: string;
  ticketId: string;
  metadata?: Record<string, unknown>;
}) {
  void notifyTicketEvent(params).catch((error) => {
    logger.warn("Ticket notification creation failed", {
      eventType: params.eventType,
      ticketId: params.ticketId,
      error: String(error),
    });
  });
}

// allowlist for reporter create
const ALLOWED_TICKET_FIELDS = [
  "description",
  "issue_type",
  "intake_mode",
  "category",
  "category_other_text",
  "severity",
  "noticed_time",
  "location_type",
  "location_detail",
  "response_taken",
  "response_details",
  "affected_asset",
  "error_symptom",
  "incident_active",
  "data_involved_flag",
  "data_involved",
  "data_other_text",
  "work_continuity",
  "impact_scope",
  "external_party_involved",
  "external_party_details",
  "already_reported_to_it",
  "reported_to_details",
  "preferred_contact_method",
  "phone_number",
  "contact_email",
  "needs_triage_review",
  "source",
] as const;

const REPORTER_EDITABLE_MISSING_FIELDS = [
  "description",
  "noticed_time",
  "category",
  "category_other_text",
  "severity",
  "location_type",
  "location_detail",
  "response_taken",
  "response_details",
  "affected_asset",
  "error_symptom",
  "incident_active",
  "data_involved_flag",
  "data_other_text",
  "work_continuity",
  "impact_scope",
  "external_party_involved",
  "external_party_details",
  "already_reported_to_it",
  "reported_to_details",
  "preferred_contact_method",
  "phone_number",
  "contact_email",
] as const;

const CYBER_ONLY_FIELDS = [
  "data_involved_flag",
  "data_involved",
  "data_other_text",
  "external_party_involved",
  "external_party_details",
  "already_reported_to_it",
  "reported_to_details",
] as const;

const IT_SUPPORT_ONLY_FIELDS = [
  "affected_asset",
  "error_symptom",
] as const;

function normalizeIssueType(issueType: unknown): "cyber" | "it_support" {
  return String(issueType || "").trim().toLowerCase() === "it_support" ? "it_support" : "cyber";
}

function isCategoryAllowedForIssueType(category: unknown, issueType: unknown): boolean {
  const normalizedCategory = String(category || "").trim().toLowerCase();
  if (!normalizedCategory) return true;
  return getCategoryOptionsByIssueType(normalizeIssueType(issueType))
    .some((option) => option.value === normalizedCategory);
}

function isFieldAllowedForIssueType(field: string, issueType: unknown): boolean {
  const normalizedIssueType = normalizeIssueType(issueType);
  if (normalizedIssueType === "cyber") {
    return !(IT_SUPPORT_ONLY_FIELDS as readonly string[]).includes(field);
  }
  return !(CYBER_ONLY_FIELDS as readonly string[]).includes(field);
}

function addDomainFieldDeletes(payload: Record<string, FirestoreValue>, issueType: unknown) {
  const fieldsToDelete = normalizeIssueType(issueType) === "cyber" ? IT_SUPPORT_ONLY_FIELDS : CYBER_ONLY_FIELDS;
  for (const field of fieldsToDelete) {
    payload[field] = deleteField() as unknown as FirestoreValue;
  }
}

function isMissingFieldValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function hasMeaningfulReporterInput(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function buildReporterUpdateHint(changedFields: string[]): string {
  if (changedFields.length === 0) return "";

  const labels = changedFields
    .map((field) => field.replaceAll("_", " "))
    .slice(0, 3)
    .join(", ");
  const moreCount = changedFields.length > 3 ? ` +${changedFields.length - 3} more` : "";
  return `reporter completed ${labels}${moreCount}`;
}

export function getReporterMissingFieldKeys(ticketData: Record<string, unknown>): string[] {
  const issueType = normalizeIssueType(ticketData.issue_type);
  return REPORTER_EDITABLE_MISSING_FIELDS.filter(
    (field) => isFieldAllowedForIssueType(field, issueType) && isMissingFieldValue(ticketData[field])
  );
}

function pickAllowed<T extends Record<string, unknown>>(
  src: T,
  allowed: readonly string[]
): Record<string, unknown> {
  // Restrict reporter-supplied fields before writing to Firestore.
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    const v = src[key];
    if (v !== undefined && v !== null) out[key] = v;
  }
  return out;
}

async function generateTicketId(category: string): Promise<string> {
  // Keep the same readable format without relying on a shared sequence document.
  // Example: U20260407A3F2
  const categoryLetter = (category?.charAt(0) || "U").toUpperCase();

  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const dateStr = `${year}${month}${day}`;

  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let suffix = "";
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  for (const b of bytes) {
    suffix += charset[b % charset.length];
  }

  return `${categoryLetter}${dateStr}${suffix}`;
}

async function uploadAttachmentDocument(
  ticketId: string,
  file: File,
  uploadedByUid: string,
  uploadedByEmail?: string | null
): Promise<TicketAttachment> {
  const startedAt = performance.now();
  const timingSummary: string[] = [];
  const markTiming = (step: string) => {
    const elapsedMs = Number((performance.now() - startedAt).toFixed(1));
    timingSummary.push(`${step}=${elapsedMs}ms`);
  };

  // Reuse the generated attachment document ID as the stable storage namespace for this file.
  const attachmentRef = doc(collection(db, "tickets", ticketId, "attachments"));
  const attachmentId = attachmentRef.id;
  const storagePath = `tickets/${ticketId}/attachments/${attachmentId}`;

  const storageRef = ref(storage, storagePath);
  assertStorageUploadReady("create_ticket_attachment", storagePath);
  try {
    await uploadBytes(storageRef, file);
    markTiming("uploadBytes done");
  } catch (error) {
    throw buildStorageUploadErrorMessage(error, "create_ticket_attachment", storagePath, file);
  }
  const downloadUrl = await getDownloadURL(storageRef);
  markTiming("getDownloadURL done");

  const payload = {
    name: file.name,
    storage_path: storagePath,
    download_url: downloadUrl,
    content_type: file.type,
    size: file.size,
    uploaded_by_email: uploadedByEmail || uploadedByUid,
    uploaded_at: serverTimestamp(),
  };

  await setDoc(attachmentRef, payload);
  markTiming("setDoc metadata done");
  logger.info("attachment upload timing summary", {
    ticketId,
    attachmentId,
    fileName: file.name,
    fileSizeBytes: file.size,
    summary: timingSummary.join(" | "),
  });

  return {
    id: attachmentId,
    name: payload.name,
    storage_path: payload.storage_path,
    download_url: payload.download_url,
    content_type: payload.content_type,
    size: payload.size,
    uploaded_by_email: payload.uploaded_by_email,
    uploaded_at: payload.uploaded_at as unknown as FirestoreValue,
  };
}

async function uploadAttachments(
  ticketId: string,
  attachmentFiles: File[],
  createdByEmail: string
): Promise<{ uploadedCount: number; failedCount: number; warning?: string }> {
  // Upload all files concurrently so wall-clock time scales with the largest
  // single file rather than the sum of all files.
  const results = await Promise.allSettled(
    attachmentFiles.map((file) => uploadAttachmentDocument(ticketId, file, createdByEmail, createdByEmail))
  );

  const uploadedCount = results.filter((r) => r.status === "fulfilled").length;
  const failures = results.filter((r) => r.status === "rejected");
  const failedCount = failures.length;

  if (failedCount > 0) {
    const reasons = (failures as PromiseRejectedResult[]).map((r) => String(r.reason)).join("; ");
    return {
      uploadedCount,
      failedCount,
      warning: `${failedCount} of ${attachmentFiles.length} attachment(s) failed to upload: ${reasons}`,
    };
  }

  return { uploadedCount, failedCount: 0 };
}

function _formatTicketRows(data: TicketDoc[]): TicketRow[] {
  return data.map((ticket) => {
    const createdAtValue = formatFirestoreData(ticket.created_at);
    const updatedAtValue = formatFirestoreData(ticket.updated_at);
    
    return {
      id: ticket.id,
      ticket_id: ticket.ticket_id || ticket.id,
      issue_type: typeof ticket.issue_type === "string" && ticket.issue_type.trim()
        ? ticket.issue_type
        : "cyber",
      intake_mode: typeof ticket.intake_mode === "string" ? ticket.intake_mode : "",
      description: typeof ticket.description === "string" ? ticket.description : "",
      status: ticket.status || "",
      severity: ticket.severity || "",
      category: ticket.category || "",
      location_type: ticket.location_type || "",
      location_detail: ticket.location_detail || "",
      last_update_hint: typeof ticket.last_update_hint === "string" ? ticket.last_update_hint : "",
      created_by_email: ticket.created_by_email || "",
      updated_by_email: ticket.updated_by_email || "",
      assigned_to_email: ticket.assigned_to_email || "",
      created_at: typeof createdAtValue === "string" ? createdAtValue : "",
      updated_at: typeof updatedAtValue === "string" ? updatedAtValue : "",
      updated_at_ms:
        ticket.updated_at &&
        typeof ticket.updated_at === "object" &&
        "toMillis" in ticket.updated_at
          ? (ticket.updated_at as { toMillis: () => number }).toMillis()
          : 0,
    };
  });
}

export async function getTickets(options?: {
  pageSize?: number;
  createdByEmail?: string;
  cursor?: QueryDocumentSnapshot<DocumentData> | null;
}) {
  const pageSize = options?.pageSize ?? 100;

  try {
    const constraints: QueryConstraint[] = [];
    if (options?.createdByEmail) constraints.push(where("created_by_email", "==", options.createdByEmail));
    constraints.push(orderBy("created_at", "desc"));
    if (options?.cursor) constraints.push(startAfter(options.cursor));
    constraints.push(limit(pageSize));

    const ticketQuery = query(collection(db, "tickets"), ...constraints);
    const snapshot = await getDocs(ticketQuery);
    const data = snapshot.docs.map((d) => ({ id: d.id, ...d.data() })) as TicketDoc[];
    const nextCursor = snapshot.docs.length > 0 ? snapshot.docs[snapshot.docs.length - 1] : null;

    return {
      rows: _formatTicketRows(data),
      total: data.length,
      hasMore: data.length === pageSize,
      nextCursor,
    };
  } catch (error) {
    if (String(error).includes("failed-precondition") && options?.createdByEmail) {
      logger.error("getTickets composite index missing for reporter email query", { error: String(error) });
      throw new Error("Ticket list index is not ready. Please deploy the Firestore indexes and try again.");
    }
    logger.error("Error in getTickets", { error: String(error) });
    throw error;
  }
}

export async function getTicketDetail(ticketId: string) {
  try {
    const snapshot = await getDoc(doc(db, "tickets", ticketId));
    if (!snapshot.exists()) throw new Error("Ticket not found");
    const data = { id: snapshot.id, ...snapshot.data() } as TicketDoc;
    return formatFirestoreData(data);
  } catch (error) {
    logger.error("Error in getTicketDetail", { error: String(error) });
    throw error;
  }
}

export async function createTicket(
  ticketData: CreateTicketInput
): Promise<{ docId: string; ticketId: string; attachmentUploadPending: boolean }> {
  const startedAt = performance.now();
  const timingSummary: string[] = [];
  const markTiming = (step: string) => {
    const elapsedMs = Number((performance.now() - startedAt).toFixed(1));
    timingSummary.push(`${step}=${elapsedMs}ms`);
  };
  let customTicketId = "";

  try {
    if (!ticketData.created_by_email) {
      throw new Error("created_by_email is required");
    }

    const attachmentFiles = ticketData.attachments || [];

    if (attachmentFiles.length > MAX_FILES) {
      throw new Error(`Maximum ${MAX_FILES} attachments allowed`);
    }

    const totalSize = attachmentFiles.reduce((sum, file) => sum + file.size, 0);
    if (totalSize > MAX_TOTAL_SIZE) {
      throw new Error("Total attachment size exceeds 20MB");
    }
    for (const file of attachmentFiles) {
      if (file.size > MAX_FILE_SIZE) {
        throw new Error(`${file.name} exceeds 10MB limit`);
      }
    }

    // Whitelist to prevent injection into sensitive fields like status/assigned_to_email/etc.
    const cleanData = pickAllowed(ticketData, ALLOWED_TICKET_FIELDS);

    const ticketRef = doc(collection(db, "tickets"));

    // Generate custom ticket ID (transaction safe)
    customTicketId = await generateTicketId(ticketData.category);
    markTiming("ticket id generated");

    const newTicket = {
      ...cleanData,

      // system-controlled fields (always overwritten here)
      created_by_email: ticketData.created_by_email,
      updated_by_email: ticketData.created_by_email,
      status: "open",
      assigned_to_email: null,
      source: ticketData.source || "manual",

      ticket_id: customTicketId,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
      reported_time: serverTimestamp(),
    };

    // 1) create main ticket doc
    await setDoc(ticketRef, newTicket);
    markTiming("ticket save done");

    notifyTicketEventInBackground({
      eventType: "ticket_created",
      ticketId: ticketRef.id,
      metadata: {
        ticket_display_id: customTicketId,
        category: ticketData.category,
        severity: ticketData.severity || "",
      },
    });

    // 2) upload attachments in the background (optional)
    // Attachment work must not delay the success response.
    if (attachmentFiles.length > 0) {
      void uploadAttachments(ticketRef.id, attachmentFiles, ticketData.created_by_email)
        .then((result) => {
          logger.info("createTicket background attachment upload summary", {
            ticketId: customTicketId,
            docId: ticketRef.id,
            attachmentCount: attachmentFiles.length,
            uploadedCount: result.uploadedCount,
            failedCount: result.failedCount,
            warning: result.warning || "",
          });
        })
        .catch((error) => {
          logger.warn("createTicket background attachment upload failed", {
            ticketId: customTicketId,
            docId: ticketRef.id,
            error: String(error),
          });
        });
      markTiming("attachments queued");
    } else {
      markTiming("attachments skipped");
    }

    markTiming("response done");
    logger.info("createTicket timing summary", {
      summary: timingSummary.join(" | "),
      ticketId: customTicketId,
      attachmentCount: attachmentFiles.length,
      attachmentUploadPending: attachmentFiles.length > 0,
    });

    return {
      docId: ticketRef.id,
      ticketId: customTicketId,
      attachmentUploadPending: attachmentFiles.length > 0,
    };
  } catch (error) {
    markTiming("failed");
    logger.error("Error in createTicket", {
      error: String(error),
      ticketId: customTicketId,
      timingSummary: timingSummary.join(" | "),
    });
    throw error;
  }
}

export async function updateTicketStatus(
  ticketId: string,
  status: string,
  updatedByEmail: string
) {
  try {
    const statusLabel = String(status || "")
      .replaceAll("_", " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());

    const ticketRef = doc(db, "tickets", ticketId);
    const payload: Record<string, FirestoreValue> = {
      status,
      last_update_hint: `status changed to ${statusLabel || "Updated"}`,
      updated_at: serverTimestamp() as unknown as FirestoreValue,
      updated_by_email: updatedByEmail,
    };

    try {
      await updateDoc(ticketRef, payload);
    } catch (error) {
      if (!isPermissionDeniedError(error)) throw error;
      // Backward compatibility for older Firestore rules that do not allow last_update_hint yet.
      const { last_update_hint: _ignored, ...fallbackPayload } = payload;
      await updateDoc(ticketRef, fallbackPayload);
    }

    await logAuditEntry({
      actorEmail: updatedByEmail,
      action: "update_ticket_status",
      ticketId,
      details: { status },
    });

    notifyTicketEventInBackground({
      eventType: "ticket_status_changed",
      ticketId,
      metadata: { status },
    });
  } catch (error) {
    logger.error("Error in updateTicketStatus", { error: String(error) });
    throw error;
  }
}

export async function updateTicketAdminFields(
  ticketId: string,
  updates: Record<string, FirestoreValue>,
  updatedByEmail: string
) {
  try {
    const snapshot = await getDoc(doc(db, "tickets", ticketId));
    if (!snapshot.exists()) throw new Error("Ticket not found");
    const current = { id: snapshot.id, ...snapshot.data() } as TicketDoc;

    const payload: Record<string, FirestoreValue> = {
      updated_at: serverTimestamp() as unknown as FirestoreValue,
      updated_by_email: updatedByEmail,
    };

    // Sanitize: clear child detail fields when the parent boolean is falsy.
    // This is a second-layer guard that catches any residual values regardless
    // of how the update was composed (UI edit, AI extraction, back-fill, etc.).
    const sanitized = { ...updates };
    if (sanitized.response_taken === false || sanitized.response_taken === null) {
      sanitized.response_details = "";
    }
    if (sanitized.external_party_involved === false || sanitized.external_party_involved === null) {
      sanitized.external_party_details = "";
    }
    if (sanitized.already_reported_to_it === false || sanitized.already_reported_to_it === null) {
      sanitized.reported_to_details = "";
    }
    const nextIssueType = normalizeIssueType(sanitized.issue_type ?? current.issue_type);
    if ("category" in sanitized && !isCategoryAllowedForIssueType(sanitized.category, nextIssueType)) {
      delete sanitized.category;
      sanitized.category_other_text = "";
    }

    const changedFields: Record<string, { before: unknown; after: unknown }> = {};

    for (const field of ADMIN_EDITABLE_FIELDS) {
      if (!(field in sanitized)) continue;
      const nextValue = sanitized[field];
      payload[field] = nextValue;

      const prevValue = current[field];
      const prevSerialized = JSON.stringify(prevValue ?? null);
      const nextSerialized = JSON.stringify(nextValue ?? null);
      if (prevSerialized !== nextSerialized && field !== "assigned_to_name") {
        changedFields[field] = { before: prevValue ?? null, after: nextValue ?? null };
      }
    }

    if ("issue_type" in sanitized) {
      addDomainFieldDeletes(payload, nextIssueType);
      const currentCategory = "category" in sanitized ? sanitized.category : current.category;
      if (!isCategoryAllowedForIssueType(currentCategory, nextIssueType)) {
        payload.category = deleteField() as unknown as FirestoreValue;
        payload.category_other_text = deleteField() as unknown as FirestoreValue;
      }
    }

    const nextStatus = String((payload.status ?? current.status ?? "") as unknown).trim().toLowerCase();
    const prevStatus = String((current.status ?? "") as unknown).trim().toLowerCase();
    const nextAssignee = Object.prototype.hasOwnProperty.call(payload, "assigned_to_email")
      ? payload.assigned_to_email
      : current.assigned_to_email;
    const hasAssignee = typeof nextAssignee === "string"
      ? nextAssignee.trim().length > 0
      : nextAssignee !== null && nextAssignee !== undefined;

    // Auto transition rule: Open + assignee => Assigned.
    if (nextStatus === "open" && hasAssignee) {
      payload.status = "assigned";
      if (prevStatus !== "assigned") {
        changedFields.status = { before: current.status ?? null, after: "assigned" };
      }
    }

    // Auto transition rule: Assigned + assignee removed => Open.
    if (nextStatus === "assigned" && !hasAssignee) {
      payload.status = "open";
      if (prevStatus !== "open") {
        changedFields.status = { before: current.status ?? null, after: "open" };
      }
    }

    const effectiveStatus = String((payload.status ?? current.status ?? "") as unknown)
      .trim()
      .toLowerCase();

    // Auto resolution metadata when a ticket enters resolved state.
    if (effectiveStatus === "resolved") {
      if (!("closed_at" in payload) || !payload.closed_at) {
        payload.closed_at = serverTimestamp() as unknown as FirestoreValue;
      }
      if (!("closed_by_email" in payload) || !payload.closed_by_email) {
        payload.closed_by_email = updatedByEmail;
      }
    }

    if (Object.keys(changedFields).length > 0) {
      const hint = buildAdminUpdateHint(changedFields);
      if (hint) {
        payload.last_update_hint = hint;
      }
    }

    try {
      await updateDoc(doc(db, "tickets", ticketId), payload);
    } catch (error) {
      if (!isPermissionDeniedError(error) || !("last_update_hint" in payload)) throw error;
      // Backward compatibility for older Firestore rules that do not allow last_update_hint yet.
      const { last_update_hint: _ignored, ...fallbackPayload } = payload;
      await updateDoc(doc(db, "tickets", ticketId), fallbackPayload);
    }

    await logAuditEntry({
      actorEmail: updatedByEmail,
      action: "admin_update_ticket",
      ticketId,
      details: {
        changed_fields: Object.keys(changedFields),
        changes: changedFields as unknown as FirestoreValue,
      },
    });

    if (Object.keys(changedFields).length > 0) {
      const assignedToChanged = "assigned_to_email" in changedFields;
      const nextAssignedToEmail = String(
        (Object.prototype.hasOwnProperty.call(payload, "assigned_to_email")
          ? payload.assigned_to_email
          : current.assigned_to_email ?? "") as unknown
      );

      notifyTicketEventInBackground({
        eventType: assignedToChanged ? "ticket_assigned" : "ticket_admin_updated",
        ticketId,
        metadata: {
          changed_fields: Object.keys(changedFields),
          previous_assigned_to_email: current.assigned_to_email ?? "",
          assigned_to_email: nextAssignedToEmail,
          assigned_to_name: payload.assigned_to_name ?? current.assigned_to_name ?? "",
          status: payload.status ?? current.status ?? "",
        },
      });
    }
  } catch (error) {
    logger.error("Error in updateTicketAdminFields", { error: String(error) });
    throw error;
  }
}

export async function updateTicketReporterMissingFields(
  ticketId: string,
  updates: Record<string, FirestoreValue>,
  updatedByEmail: string
) {
  try {
    const ticketRef = doc(db, "tickets", ticketId);
    const snapshot = await getDoc(ticketRef);
    if (!snapshot.exists()) throw new Error("Ticket not found");

    const current = { id: snapshot.id, ...snapshot.data() } as TicketDoc;
    if (current.created_by_email !== updatedByEmail) {
      throw new Error("You can only update your own ticket");
    }

    const payload: Record<string, FirestoreValue> = {
      updated_at: serverTimestamp() as unknown as FirestoreValue,
      updated_by_email: updatedByEmail,
    };

    const changedFields: string[] = [];
    const issueType = normalizeIssueType(current.issue_type);
    for (const field of REPORTER_EDITABLE_MISSING_FIELDS) {
      if (!(field in updates)) continue;
      if (!isFieldAllowedForIssueType(field, issueType)) continue;

      const currentValue = current[field];
      if (!isMissingFieldValue(currentValue)) continue;

      const nextValue = updates[field];
      if (!hasMeaningfulReporterInput(nextValue)) continue;
      if (field === "category" && !isCategoryAllowedForIssueType(nextValue, issueType)) continue;

      payload[field] = nextValue;
      changedFields.push(field);
    }

    if (changedFields.length === 0) {
      throw new Error("No missing fields were provided to update.");
    }

    const hint = buildReporterUpdateHint(changedFields);
    if (hint) {
      payload.last_update_hint = hint;
    }

    try {
      await updateDoc(ticketRef, payload);
    } catch (error) {
      if (!isPermissionDeniedError(error) || !("last_update_hint" in payload)) throw error;
      const { last_update_hint: _ignored, ...fallbackPayload } = payload;
      await updateDoc(ticketRef, fallbackPayload);
    }

    await logAuditEntry({
      actorEmail: updatedByEmail,
      action: "reporter_complete_ticket",
      ticketId,
      details: {
        changed_fields: changedFields as unknown as FirestoreValue,
      },
    });

    notifyTicketEventInBackground({
      eventType: "reporter_completed_fields",
      ticketId,
      metadata: {
        changed_fields: changedFields,
      },
    });
  } catch (error) {
    logger.error("Error in updateTicketReporterMissingFields", { error: String(error) });
    throw error;
  }
}

export async function claimTicket(ticketId: string): Promise<{
  claimed: boolean;
  ticket_id?: string;
  assigned_to_email?: string;
  assigned_to_name?: string;
  status?: string;
}> {
  return callBackendAPI(`/api/tickets/${ticketId}/claim`, "POST", {});
}

export async function getCollectionData(collectionName: string) {
  try {
    const { fetchCollection } = await import("./FirestoreUtils");
    return await fetchCollection(collectionName);
  } catch (error) {
    logger.error("Error in getCollectionData", {
      collectionName,
      error: String(error),
    });
    throw error;
  }
}

export async function getDocumentData(collectionName: string, docId: string) {
  try {
    const { fetchDocument } = await import("./FirestoreUtils");
    return await fetchDocument(collectionName, docId);
  } catch (error) {
    logger.error("Error in getDocumentData", {
      collectionName,
      docId,
      error: String(error),
    });
    throw error;
  }
}
