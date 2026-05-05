import { logger } from "./logger";

export type UxErrorCategory =
  | "network"
  | "timeout"
  | "auth"
  | "validation"
  | "permission"
  | "session"
  | "upload"
  | "unknown";

export function categorizeError(message: string): UxErrorCategory {
  const text = (message || "").toLowerCase();

  if (!text) return "unknown";
  if (text.includes("network") || text.includes("failed to fetch")) return "network";
  if (text.includes("timeout") || text.includes("timed out")) return "timeout";
  if (text.includes("auth/") || text.includes("login") || text.includes("password") || text.includes("email")) return "auth";
  if (text.includes("required") || text.includes("invalid") || text.includes("please enter")) return "validation";
  if (text.includes("forbidden") || text.includes("permission") || text.includes("unauthorized")) return "permission";
  if (text.includes("conversation") || text.includes("session")) return "session";
  if (text.includes("file") || text.includes("attachment") || text.includes("upload")) return "upload";
  return "unknown";
}

export function trackUxEvent(
  event: string,
  payload?: {
    page?: string;
    action?: string;
    outcome?: "success" | "error";
    message?: string;
    category?: UxErrorCategory;
  }
) {
  const category = payload?.category || (payload?.message ? categorizeError(payload.message) : undefined);

  logger.info("UX telemetry", {
    event,
    ...payload,
    category,
  });
}
