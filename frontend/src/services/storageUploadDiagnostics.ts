import { auth } from "../firebase";
import { logger } from "./logger";

function readStorageBucket(): string {
  return String(import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "").trim();
}

export function assertStorageUploadReady(operation: string, storagePath: string): void {
  const currentUser = auth.currentUser;
  const storageBucket = readStorageBucket();

  if (!storageBucket) {
    logger.error("storage upload blocked: missing storage bucket config", {
      operation,
      storagePath,
      envKey: "VITE_FIREBASE_STORAGE_BUCKET",
    });
    throw new Error(
      "Firebase Storage bucket is not configured. Check VITE_FIREBASE_STORAGE_BUCKET."
    );
  }

  if (!currentUser) {
    logger.warn("storage upload blocked: user not authenticated", {
      operation,
      storagePath,
      storageBucket,
    });
    throw new Error("You must be signed in before uploading attachments.");
  }

  logger.info("storage upload preflight passed", {
    operation,
    storagePath,
    storageBucket,
    uid: currentUser.uid,
  });
}

export function buildStorageUploadErrorMessage(
  error: unknown,
  operation: string,
  storagePath: string,
  file?: File
): Error {
  const currentUser = auth.currentUser;
  const storageBucket = readStorageBucket();
  const rawMessage = error instanceof Error ? error.message : String(error || "");
  const normalized = rawMessage.toLowerCase();

  logger.error("storage upload failed", {
    operation,
    storagePath,
    storageBucket,
    uid: currentUser?.uid || "",
    fileName: file?.name || "",
    fileSizeBytes: file?.size ?? 0,
    fileType: file?.type || "",
    error: rawMessage,
  });

  if (!currentUser) {
    return new Error("Upload failed because your sign-in session is no longer active. Please sign in again.");
  }

  if (!storageBucket) {
    return new Error("Upload failed because the Firebase Storage bucket is not configured.");
  }

  if (
    normalized.includes("storage/unauthorized") ||
    normalized.includes("storage/permission-denied") ||
    normalized.includes("permission-denied") ||
    normalized.includes("missing or insufficient permissions")
  ) {
    return new Error(
      `Upload was rejected by Firebase Storage rules for bucket "${storageBucket}" at path "${storagePath}".`
    );
  }

  return error instanceof Error ? error : new Error(rawMessage || "Attachment upload failed.");
}
