/**
 * Frontend structured logger.
 *
 * - Development: all levels are printed as structured JSON-like objects.
 * - Production:  only errors are logged to reduce noise.
 *
 * Usage:
 *   import { logger } from "../services/logger";
 *   logger.info("Ticket created", { ticketId: "P20260322001" });
 *   logger.error("Upload failed", { file: file.name, error: String(err) });
 */

const IS_DEV = import.meta.env.DEV;

type LogLevel = "debug" | "info" | "warn" | "error";

function emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (!IS_DEV && level !== "error") return;

  const entry = {
    level,
    message,
    ...context,
  };

  const fn: (...args: unknown[]) => void = level === "debug"
    ? console.log.bind(console)
    : console[level].bind(console);
  fn(entry);
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => emit("debug", message, context),
  info:  (message: string, context?: Record<string, unknown>) => emit("info",  message, context),
  warn:  (message: string, context?: Record<string, unknown>) => emit("warn",  message, context),
  error: (message: string, context?: Record<string, unknown>) => emit("error", message, context),
};
