import { db } from "../firebase";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  updateDoc,
  serverTimestamp,
} from "firebase/firestore";
import { formatFirestoreData } from "./FirestoreUtils";
import { logAuditEntry } from "./AuditService";
import { notifyTicketEvent } from "./NotificationService";
import type { TicketComment } from "./ServiceTypes";

function isPermissionDeniedError(error: unknown): boolean {
  const message = String(error || "").toLowerCase();
  return message.includes("permission-denied") || message.includes("missing or insufficient permissions");
}

function notifyCommentInBackground(ticketId: string, metadata: Record<string, unknown>) {
  void notifyTicketEvent({
    eventType: "ticket_comment",
    ticketId,
    metadata,
  }).catch((error) => {
    console.warn("Ticket comment notification creation failed:", error);
  });
}

export async function getTicketComments(ticketId: string): Promise<TicketComment[]> {
  try {
    const commentsQuery = query(
      collection(db, "tickets", ticketId, "comments"),
      orderBy("created_at", "desc"),
      limit(100)
    );
    const snapshot = await getDocs(commentsQuery);
    const data = snapshot.docs.map((d) => ({ id: d.id, ...d.data() })) as TicketComment[];
    return formatFirestoreData(data) as TicketComment[];
  } catch (error) {
    console.error("Error in getTicketComments:", error);
    throw error;
  }
}

export async function addTicketComment(
  ticketId: string,
  message: string,
  createdByUid: string,
  createdByEmail?: string | null
) {
  try {
    const trimmed = message.trim();
    if (!trimmed) {
      throw new Error("Comment cannot be empty");
    }

    const commentRef = await addDoc(collection(db, "tickets", ticketId, "comments"), {
      message: trimmed,
      created_by_uid: createdByUid,
      created_by_email: createdByEmail || "",
      created_at: serverTimestamp(),
    });

    // Keep ticket activity timestamp in sync so reporter-side notifications can detect new replies.
    const activityPayload = {
      last_update_hint: "new comment added",
      updated_at: serverTimestamp(),
      updated_by_uid: createdByUid,
    };

    try {
      await updateDoc(doc(db, "tickets", ticketId), activityPayload);
    } catch (error) {
      if (!isPermissionDeniedError(error)) throw error;
      // Backward compatibility for older Firestore rules that do not allow last_update_hint yet.
      await updateDoc(doc(db, "tickets", ticketId), {
        updated_at: serverTimestamp(),
        updated_by_uid: createdByUid,
      });
    }

    await logAuditEntry({
      uid: createdByUid,
      action: "add_comment",
      ticketId,
      details: {
        message_preview: trimmed.slice(0, 120),
        message_length: trimmed.length,
      },
    });

    notifyCommentInBackground(ticketId, {
      comment_id: commentRef.id,
      message_preview: trimmed.slice(0, 120),
    });
  } catch (error) {
    console.error("Error in addTicketComment:", error);
    throw error;
  }
}

export async function deleteTicketComment(
  ticketId: string,
  commentId: string,
  actorUid: string
) {
  try {
    await deleteDoc(doc(db, "tickets", ticketId, "comments", commentId));

    // Keep ticket activity timestamp in sync when comments are removed.
    const activityPayload = {
      last_update_hint: "a comment was removed",
      updated_at: serverTimestamp(),
      updated_by_uid: actorUid,
    };

    try {
      await updateDoc(doc(db, "tickets", ticketId), activityPayload);
    } catch (error) {
      if (!isPermissionDeniedError(error)) throw error;
      // Backward compatibility for older Firestore rules that do not allow last_update_hint yet.
      await updateDoc(doc(db, "tickets", ticketId), {
        updated_at: serverTimestamp(),
        updated_by_uid: actorUid,
      });
    }

    await logAuditEntry({
      uid: actorUid,
      action: "delete_comment",
      ticketId,
      details: {
        comment_id: commentId,
      },
    });
  } catch (error) {
    console.error("Error in deleteTicketComment:", error);
    throw error;
  }
}
