import { db } from "../firebase";
import {
  addDoc,
  collection,
  getDocs,
  limit,
  orderBy,
  query,
} from "firebase/firestore";
import { formatFirestoreData } from "./FirestoreUtils";
import type { AuditLog, FirestoreValue } from "./ServiceTypes";

export async function logAuditEntry(params: {
  actorEmail: string;
  action: string;
  ticketId: string;
  details?: Record<string, FirestoreValue>;
  status?: "success" | "failed";
}) {
  // Centralize audit writes so every ticket mutation produces the same metadata shape.
  const { serverTimestamp } = await import("firebase/firestore");
  await addDoc(collection(db, "audit_logs"), {
    actor_email: params.actorEmail,
    action: params.action,
    resource_type: "ticket",
    resource_id: params.ticketId,
    details: params.details || {},
    status: params.status || "success",
    created_at: serverTimestamp(),
  });
}

export async function getTicketAuditLogs(ticketId: string): Promise<AuditLog[]> {
  try {
    const auditQuery = query(
      collection(db, "audit_logs"),
      orderBy("created_at", "desc"),
      limit(500)
    );
    const snapshot = await getDocs(auditQuery);
    const logs = snapshot.docs.map((d) => ({
      id: d.id,
      ...(d.data() as Record<string, unknown>),
    }));
    const filtered = logs.filter((log) => {
      const row = log as Record<string, unknown>;
      return (
        String(row.resource_type || "") === "ticket" &&
        String(row.resource_id || "") === ticketId
      );
    });
    return formatFirestoreData(filtered as AuditLog[]) as AuditLog[];
  } catch (error) {
    console.error("Error in getTicketAuditLogs:", error);
    throw error;
  }
}

export async function getAuditLogs(limitSize: number = 300): Promise<AuditLog[]> {
  try {
    const auditQuery = query(
      collection(db, "audit_logs"),
      orderBy("created_at", "desc"),
      limit(limitSize)
    );
    const snapshot = await getDocs(auditQuery);
    const data = snapshot.docs.map((d) => ({ id: d.id, ...d.data() })) as AuditLog[];
    return formatFirestoreData(data) as AuditLog[];
  } catch (error) {
    console.error("Error in getAuditLogs:", error);
    throw error;
  }
}

/**
 * Count audit logs created after `sinceMs` (milliseconds since epoch).
 * Uses raw Firestore Timestamp to compare — does NOT format the data.
 */
export async function getUnreadAuditCount(sinceMs: number, excludeActorEmail?: string): Promise<number> {
  try {
    const auditQuery = query(
      collection(db, "audit_logs"),
      orderBy("created_at", "desc"),
      limit(200)
    );
    const snapshot = await getDocs(auditQuery);
    const raw = snapshot.docs.map((d) => ({ id: d.id, ...d.data() })) as AuditLog[];
    return raw.filter((log) => {
      if (excludeActorEmail && String(log.actor_email || "") === excludeActorEmail) {
        return false;
      }
      const ts = log.created_at;
      if (ts && typeof ts === "object" && "toMillis" in ts) {
        return (ts as { toMillis: () => number }).toMillis() > sinceMs;
      }
      return false;
    }).length;
  } catch {
    return 0;
  }
}
