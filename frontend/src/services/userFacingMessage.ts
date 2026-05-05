type MessageOptions = {
  fallback?: string;
};

const DEFAULT_FALLBACK = "Something went wrong. Please try again in a moment.";

export function toUserFacingMessage(error: unknown, options: MessageOptions = {}): string {
  const raw = error instanceof Error ? error.message : String(error || "");
  const normalized = raw.toLowerCase();
  const fallback = options.fallback || DEFAULT_FALLBACK;

  if (!raw.trim()) return fallback;

  if (
    normalized.includes("network") ||
    normalized.includes("failed to fetch") ||
    normalized.includes("timeout") ||
    normalized.includes("timed out")
  ) {
    return "Network connection issue detected. Please check your connection and try again.";
  }

  if (
    normalized.includes("permission") ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden")
  ) {
    if (normalized.includes("signed in")) {
      return "Your sign-in session is missing or expired. Please sign in again, then retry the upload.";
    }
    if (normalized.includes("storage rules")) {
      return "Firebase Storage rejected the upload. Check that the latest Storage rules are deployed and the app is using the correct bucket.";
    }
    if (normalized.includes("storage bucket")) {
      return "Firebase Storage bucket configuration is missing or incorrect. Check VITE_FIREBASE_STORAGE_BUCKET.";
    }
    return "You do not have permission to perform this action.";
  }

  if (
    normalized.includes("conversation not found") ||
    normalized.includes("session not found") ||
    normalized.includes("invalid conversation")
  ) {
    return "Your reporting session has expired. Please retry to start a new secure session.";
  }

  if (normalized.includes("maximum") && normalized.includes("files")) {
    return "You have reached the attachment limit. Remove a file before adding a new one.";
  }

  if (
    normalized.includes("exceeds 10mb") ||
    normalized.includes("10 mb")
  ) {
    return "One or more files exceed the 10 MB per-file limit.";
  }

  if (normalized.includes("total") && normalized.includes("20mb")) {
    return "Total attachment size cannot exceed 20 MB.";
  }

  return raw.length > 220 ? fallback : raw;
}
