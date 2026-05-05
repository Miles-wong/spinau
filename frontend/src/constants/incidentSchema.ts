/**
 * Single source of truth for all incident field enum values.
 *
 * Keep these in sync with backend/form_service/schema.py.
 * When adding a new option, update BOTH this file AND the Python schema.
 */

export const INCIDENT_CATEGORIES = [
  { value: "phishing",              label: "Phishing" },
  { value: "malware",               label: "Malware" },
  { value: "email_exposure",        label: "Email Exposure" },
  { value: "credential_compromise", label: "Credential Compromise" },
  { value: "unauthorized_access",   label: "Unauthorized Access" },
  { value: "data_breach",           label: "Data Breach" },
  { value: "device_loss",           label: "Device Loss" },
  { value: "suspicious_activity",   label: "Suspicious Activity" },
  { value: "policy_violation",      label: "Policy Violation" },
  { value: "infrastructure_issue",  label: "Infrastructure Issue" },
  { value: "other",                 label: "Other" },
] as const;

export type IncidentCategory = typeof INCIDENT_CATEGORIES[number]["value"];

export const ISSUE_TYPES = [
  { value: "cyber",      label: "Cyber" },
  { value: "it_support", label: "IT Support" },
  { value: "not_sure",   label: "Not Sure" },
] as const;

export type IssueType = typeof ISSUE_TYPES[number]["value"];

export const ISSUE_TYPE_PROFILES = {
  cyber: {
    label: "Cyber Security",
    categoryLabel: "Incident Category",
    domainDetailsTitle: "Section C: External & Escalation",
    requiredFields: [
      "issue_type",
      "category",
      "description",
      "noticed_time",
      "severity",
      "response_taken",
      "incident_active",
      "impact_scope",
      "work_continuity",
      "data_involved_flag",
      "external_party_involved",
      "already_reported_to_it",
      "preferred_contact_method",
    ],
    domainSpecificFields: [
      "data_involved_flag",
      "data_involved",
      "data_other_text",
      "external_party_involved",
      "external_party_details",
      "already_reported_to_it",
      "reported_to_details",
    ],
  },
  it_support: {
    label: "IT Support",
    categoryLabel: "Support Category",
    domainDetailsTitle: "Section C: Technical Details",
    requiredFields: [
      "issue_type",
      "category",
      "description",
      "noticed_time",
      "severity",
      "response_taken",
      "incident_active",
      "impact_scope",
      "work_continuity",
      "affected_asset",
      "error_symptom",
      "preferred_contact_method",
    ],
    domainSpecificFields: [
      "affected_asset",
      "error_symptom",
    ],
  },
} as const;

export function isResolvedIssueType(issueType?: string): issueType is Exclude<IssueType, "not_sure"> {
  return issueType === "cyber" || issueType === "it_support";
}

export function getIssueTypeProfile(issueType?: string) {
  return issueType === "it_support" ? ISSUE_TYPE_PROFILES.it_support : ISSUE_TYPE_PROFILES.cyber;
}

export const IT_SUPPORT_CATEGORIES = [
  { value: "hardware_issue",           label: "Hardware Issue" },
  { value: "network_issue",            label: "Network Issue" },
  { value: "software_issue",           label: "Software Issue" },
  { value: "access_account_issue",     label: "Access / Account Issue" },
  { value: "communication",            label: "Communication" },
  { value: "performance_issue",        label: "Performance Issue" },
  { value: "service_request",          label: "Service Request" },
  { value: "technical_incident",       label: "Technical Incident" },
  { value: "general_technical_support", label: "General Technical Support" },
  
] as const;

export function getCategoryOptionsByIssueType(issueType?: string) {
  if (issueType === "not_sure") return [];
  return issueType === "it_support" ? IT_SUPPORT_CATEGORIES : INCIDENT_CATEGORIES;
}

export const SEVERITY_LEVELS = [
  { value: "low",      label: "Low" },
  { value: "medium",   label: "Medium" },
  { value: "high",     label: "High" },
  { value: "critical", label: "Critical" },
] as const;

export type SeverityLevel = typeof SEVERITY_LEVELS[number]["value"];

export const LOCATION_TYPES = [
  { value: "email",    label: "Email" },
  { value: "device",   label: "Device" },
  { value: "network",  label: "Network" },
  { value: "physical", label: "Physical" },
  { value: "cloud",    label: "Cloud" },
  { value: "other",    label: "Other" },
] as const;

export type LocationType = typeof LOCATION_TYPES[number]["value"];

export const DATA_TYPES_INVOLVED = [
  { value: "personal_info", label: "Personal Information" },
  { value: "credentials",   label: "Credentials" },
  { value: "financial",     label: "Financial Data" },
  { value: "company_data",  label: "Company Data" },
  { value: "other",         label: "Other" },
] as const;

export type DataTypeInvolved = typeof DATA_TYPES_INVOLVED[number]["value"];

export const CONTACT_METHODS = [
  { value: "email",     label: "Email" },
  { value: "phone",     label: "Phone" },
  { value: "in_person", label: "In Person" },
  { value: "teams",     label: "Microsoft Teams" },
] as const;

export type ContactMethod = typeof CONTACT_METHODS[number]["value"];
