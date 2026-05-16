import type { Timestamp } from "firebase/firestore";

export type FirestoreValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Timestamp
  | FirestoreValue[]
  | { [key: string]: FirestoreValue };

export type TicketDoc = {
  id: string;
  ticket_id?: string;
  status?: string;
  reported_time?: FirestoreValue;
  created_at?: FirestoreValue;
  updated_at?: FirestoreValue;
  created_by_email?: string;
  updated_by_email?: string;
  assigned_to_email?: string | null;
  assigned_to_name?: string | null;

  classification?: string;
  issue_type?: string;
  category?: string;
  category_other_text?: string;
  severity?: string;
  noticed_time?: FirestoreValue;
  location_type?: string;
  location_detail?: string;
  description?: string;
  affected_asset?: string;
  error_symptom?: string;

  incident_active?: boolean;
  response_taken?: boolean;
  response_details?: string;

  email_exposure_clicked_link?: string;
  email_exposure_opened_attachment?: string;
  email_exposure_entered_credentials?: string;

  data_involved?: string[];
  data_involved_flag?: boolean;
  data_other_text?: string;
  work_continuity?: string;
  impact_scope?: string;

  preferred_contact_method?: string;
  phone_number?: string;

  external_party_involved?: boolean;
  external_party_details?: string;

  already_reported_to_it?: boolean;
  reported_to_details?: string;
  source?: string;

  closure_summary?: string;
  lessons_learned?: string;
  closed_at?: FirestoreValue | null;
  closed_by_email?: string | null;

  duplicate_of_ticket_id?: string;
  related_ticket_ids?: string[];

  [key: string]: FirestoreValue;
};

export type TicketComment = {
  id: string;
  message: string;
  created_at?: FirestoreValue;
  created_by_email?: string;
};

export type TicketAttachment = {
  id: string;
  name: string;
  storage_path: string;
  download_url: string;
  content_type?: string;
  size?: number;
  uploaded_by_email?: string;
  uploaded_at?: FirestoreValue;
};

export type AuditLog = {
  id: string;
  actor_email?: string;
  action?: string;
  resource_type?: string;
  resource_id?: string;
  details?: Record<string, FirestoreValue>;
  status?: string;
  created_at?: FirestoreValue;
};

export type CreateTicketInput = {
  description: string;
  issue_type?: string;
  intake_mode?: string;
  category: string;
  category_other_text?: string;
  severity?: string;
  noticed_time?: string;
  location_type?: string;
  location_detail?: string;
  response_taken?: boolean;
  response_details?: string;
  affected_asset?: string;
  error_symptom?: string;
  incident_active: boolean;
  data_involved_flag?: boolean;
  data_involved?: string[];
  data_other_text?: string;
  work_continuity?: string;
  impact_scope?: string;
  external_party_involved?: boolean;
  external_party_details?: string;
  already_reported_to_it?: boolean;
  reported_to_details?: string;
  preferred_contact_method: string;
  phone_number?: string;
  contact_email?: string;
  needs_triage_review?: boolean;
  source?: string;

  created_by_email: string;
  attachments?: File[];
};

export type TicketRow = {
  id: string;
  ticket_id: string;
  issue_type: string;
  intake_mode?: string;
  description: string;
  status: string;
  severity: string;
  category: string;
  location_type: string;
  location_detail: string;
  last_update_hint: string;
  created_by_email: string;
  updated_by_email: string;
  assigned_to_email: string;
  created_at: string;
  updated_at: string;
  updated_at_ms: number;
};
