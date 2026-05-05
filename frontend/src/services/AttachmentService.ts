import { db, storage } from "../firebase";
import {
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  doc,
  updateDoc,
  setDoc,
  serverTimestamp,
} from "firebase/firestore";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { formatFirestoreData } from "./FirestoreUtils";
import { logAuditEntry } from "./AuditService";
import { getAuthToken } from "./AuthService";
import { buildStorageUploadErrorMessage, assertStorageUploadReady } from "./storageUploadDiagnostics";
import type { TicketAttachment, FirestoreValue } from "./ServiceTypes";

const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:5000";
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

function isPermissionDeniedError(error: unknown): boolean {
  const message = String(error || "").toLowerCase();
  return message.includes("permission-denied") || message.includes("missing or insufficient permissions");
}

async function uploadAttachmentDocument(
  ticketId: string,
  file: File,
  uploadedByUid: string,
  uploadedByEmail?: string | null
): Promise<TicketAttachment> {
  // Reuse the generated attachment document ID as the stable storage namespace for this file.
  const attachmentRef = doc(collection(db, "tickets", ticketId, "attachments"));
  const attachmentId = attachmentRef.id;
  const storagePath = `tickets/${ticketId}/attachments/${attachmentId}`;

  const storageRef = ref(storage, storagePath);
  assertStorageUploadReady("add_ticket_attachment", storagePath);
  try {
    await uploadBytes(storageRef, file);
  } catch (error) {
    throw buildStorageUploadErrorMessage(error, "add_ticket_attachment", storagePath, file);
  }
  const downloadUrl = await getDownloadURL(storageRef);

  const payload = {
    name: file.name,
    storage_path: storagePath,
    download_url: downloadUrl,
    content_type: file.type,
    size: file.size,
    uploaded_by_uid: uploadedByUid,
    uploaded_by_email: uploadedByEmail || "",
    uploaded_at: serverTimestamp(),
  };

  await setDoc(attachmentRef, payload);

  return {
    id: attachmentId,
    name: payload.name,
    storage_path: payload.storage_path,
    download_url: payload.download_url,
    content_type: payload.content_type,
    size: payload.size,
    uploaded_by_uid: payload.uploaded_by_uid,
    uploaded_by_email: payload.uploaded_by_email,
    uploaded_at: payload.uploaded_at as unknown as FirestoreValue,
  };
}

export async function getTicketAttachments(ticketId: string): Promise<TicketAttachment[]> {
  try {
    const attachmentsQuery = query(
      collection(db, "tickets", ticketId, "attachments"),
      orderBy("uploaded_at", "desc"),
      limit(100)
    );
    const snapshot = await getDocs(attachmentsQuery);
    const data = snapshot.docs.map((d) => ({ id: d.id, ...d.data() })) as TicketAttachment[];
    return formatFirestoreData(data) as TicketAttachment[];
  } catch (error) {
    console.error("Error in getTicketAttachments:", error);
    throw error;
  }
}

export async function addTicketAttachment(
  ticketId: string,
  file: File,
  uploadedByUid: string,
  uploadedByEmail?: string | null
) {
  try {
    if (file.size > MAX_FILE_SIZE) {
      throw new Error(`${file.name} exceeds 10MB limit`);
    }

    const attachment = await uploadAttachmentDocument(
      ticketId,
      file,
      uploadedByUid,
      uploadedByEmail
    );

    try {
      await updateDoc(doc(db, "tickets", ticketId), {
        updated_at: serverTimestamp(),
        updated_by_uid: uploadedByUid,
        has_attachment: true,
      });
    } catch (error) {
      if (!isPermissionDeniedError(error)) throw error;
      // Reporter rules may reject has_attachment updates; keep activity timestamp in sync.
      await updateDoc(doc(db, "tickets", ticketId), {
        updated_at: serverTimestamp(),
        updated_by_uid: uploadedByUid,
      });
    }

    await logAuditEntry({
      uid: uploadedByUid,
      action: "add_attachment",
      ticketId,
      details: {
        file_name: attachment.name,
        file_size: attachment.size,
        content_type: attachment.content_type || "",
      },
    });
  } catch (error) {
    console.error("Error in addTicketAttachment:", error);
    throw error;
  }
}

export async function downloadTicketAttachment(
  ticketId: string,
  attachmentId: string
): Promise<Blob> {
  const token = await getAuthToken();
  const endpoint = `${API_BASE_URL}/api/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(attachmentId)}/download`;

  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(err || `Download failed: ${response.status}`);
  }

  return response.blob();
}

export async function logAttachmentDownload(params: {
  ticketId: string;
  attachmentId?: string;
  fileName: string;
  downloadedByUid: string;
  fileSize?: number;
  contentType?: string;
}) {
  try {
    await logAuditEntry({
      uid: params.downloadedByUid,
      action: "download_attachment",
      ticketId: params.ticketId,
      details: {
        attachment_id: params.attachmentId || "",
        file_name: params.fileName,
        file_size: params.fileSize ?? 0,
        content_type: params.contentType || "",
      },
    });
  } catch (error) {
    console.error("Error in logAttachmentDownload:", error);
    throw error;
  }
}
