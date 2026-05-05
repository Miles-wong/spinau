import { callBackendAPI } from "./AuthService";

/**
 * Validate ticket data (pre-creation validation by the frontend)
 *
 * Flow:
 * 1. Backend validates permissions and rate limits
 * 2. Backend validates data format
 * 3. Returns validation result to the frontend
 * 4. Frontend continues:
 *    - Generates ticket ID (Firestore transaction)
 *    - Creates Firestore document
 *    - Uploads attachments
 *    - Calls logTicketCreated to log the creation
 */
export interface SimilarTicketResult {
  ticket_id?: string;
  doc_id?: string;
  title?: string;
  category?: string;
  issue_type?: string;
  severity?: string;
  status?: string;
  description?: string;
  resolution?: string;
  closure_summary?: string;
  score?: number;
}

export async function validateAndClassify(ticketData: {
  category?: string;
  severity?: string;
  description: string;
  incident_active: boolean;
  [key: string]: unknown;
}): Promise<{
  valid: boolean;
  message: string;
  ticket_data?: Record<string, unknown>;
  similar_tickets?: SimilarTicketResult[];
  suggested_action?: string;
}> {
  return callBackendAPI("/api/validate-and-classify", "POST", ticketData);
}

/**
 * Log that a ticket was successfully created by the frontend (call after creation)
 */
export async function logTicketCreated(params: {
  ticket_id: string;
  doc_id: string;
  category: string;
  severity: string;
}): Promise<{ logged: boolean }> {
  return callBackendAPI("/api/log-ticket-created", "POST", params);
}
