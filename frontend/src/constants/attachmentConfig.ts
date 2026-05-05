/** File-upload constraints shared between UI validation and TicketService. */

export const ALLOWED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "application/pdf",
  "text/plain",
  "message/rfc822",                                                     // .eml
  "application/vnd.ms-outlook",                                         // .msg
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
] as const;

export const BLOCKED_EXTENSIONS = [
  ".exe", ".js", ".html", ".zip", ".bat", ".ps1", ".apk",
] as const;

export const MAX_FILE_SIZE   = 10 * 1024 * 1024; // 10 MB per file
export const MAX_TOTAL_SIZE  = 20 * 1024 * 1024; // 20 MB total
export const MAX_FILES       = 5;
