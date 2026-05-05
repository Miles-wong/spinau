/**
 * ReportIncidentChat.tsx - Conversational incident report page (chat-based flow).
 *
 * Uses the backend /api/conversation/* SSE endpoints to guide the reporter
 * through the intake form one field at a time via natural language.
 *
 * Flow:
 * 1. POST /api/conversation/init   → receive conversation_id + first question.
 * 2. User sends each reply via POST /api/conversation/:id/message/stream (SSE).
 * 3. Real-time field updates are reflected in CollectedPanel as values arrive.
 * 4. When is_complete=true, validate + create the Firestore ticket document.
 * 5. Queue audit logging after the success response is already shown.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { UserInfo } from "../types/auth";
import Layout from "../components/Layout";
import ChatWindow from "../components/ChatWindow";
import CollectedPanel from "../components/CollectedPanel";
import MessageInput from "../components/MessageInput";
import { validateAndClassify, logTicketCreated } from "../services/TicketValidationService";
import { createTicket } from "../services/TicketService";
import { auth } from "../firebase";
import { logger } from "../services/logger";
import { toUserFacingMessage } from "../services/userFacingMessage";
import { useToast } from "../components/toastContext";
import { trackUxEvent } from "../services/uxTelemetry";
import {
  clearConversationWarmup,
  consumeWarmedConversation,
  warmupConversation,
} from "../services/ConversationWarmupService";

const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:5000";
import "./ReportIncidentChat.css";

const PANEL_FOLLOW_UP: Record<string, { field: string; question: string }> = {
  response_taken:          { field: "response_details",       question: "What actions did you take?" },
  data_involved_flag:      { field: "data_involved",          question: "What types of data were involved?" },
  external_party_involved: { field: "external_party_details", question: "Please describe the external party involvement." },
  already_reported_to_it:  { field: "reported_to_details",    question: "Who did you report it to, and when?" },
};

const EDIT_FIELD_LABELS: Record<string, string> = {
  issue_type: "Issue Type",
  description: "Incident Description",
  noticed_time: "Time Discovered",
  category: "Category",
  category_other_text: "Category Details",
  severity: "Severity",
  incident_active: "Incident Active",
  response_taken: "Action Taken",
  response_details: "Action Details",
  impact_scope: "Impact Scope",
  work_continuity: "Work Continuity",
  affected_asset: "Affected Asset",
  error_symptom: "Error Symptom",
  data_involved_flag: "Data Involved",
  data_involved: "Data Types",
  data_other_text: "Other Data Details",
  external_party_involved: "External Party",
  external_party_details: "External Party Details",
  already_reported_to_it: "Reported to IT",
  reported_to_details: "IT Report Details",
  preferred_contact_method: "Contact Method",
  phone_number: "Phone Number",
  location_detail: "Location Details",
};

type ReportIncidentChatProps = {
  user: UserInfo;
  role: "reporter" | "admin";
  onLogout: () => void;
};

type Message = {
  id?: string;
  role: "user" | "assistant";
  content: string;
};

type CollectedData = {
  [key: string]: unknown;
};

type PostSkipRecollectState = {
  baselineCollected: CollectedData;
  baselineMissing: string[];
};

type JsonRecord = Record<string, unknown>;
type ConversationInitResponse = {
  conversation_id: string;
  initial_message?: string;
  collected?: CollectedData;
  missing?: string[];
  is_complete?: boolean;
  next_hints?: NextHints;
};

type StreamEvent = {
  type?: string;
  message?: string;
  field?: string;
  value?: unknown;
  content?: string;
  assistant_message?: string;
  collected?: CollectedData;
  missing?: string[];
  is_complete?: boolean;
  next_hints?: NextHints;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

type HintOption = {
  value: string | boolean;
  label: string;
};

type NextHints = {
  type?: string;
  options?: HintOption[];
  placeholder?: string;
  examples?: string[];
  suggestion?: string;
  // Recommendation metadata is used by MessageInput to show AI guidance and,
  // in approved fallback cases, preselect an enum default.
  recommendedValue?: string;
  recommendedTip?: string;
  autoSelectRecommended?: boolean;
  detail_hint?: {
    label: string;
    placeholder: string;
  };
};

// Submit gate: minimum fields required before the report can be submitted.
// Cyber uses Fast Report mode — 4 core fields only; supplementary fields are
// collected asynchronously after the ticket is created.
const CYBER_SUBMIT_REQUIRED = [
  "description",
  "noticed_time",
  "incident_active",
  "response_taken",
] as const;

// IT Support keeps a more complete intake as asset/symptom are critical for triage.
// Category is now auto-inferred by the backend, so not required during submission.
const IT_SUPPORT_SUBMIT_REQUIRED = [
  "description",
  "noticed_time",
  "incident_active",
  "response_taken",
  "affected_asset",
  "error_symptom",
] as const;

function getSubmitRequiredFields(collected: CollectedData): readonly string[] {
  const issueType = String(collected.issue_type || "").toLowerCase().replace(/\s+/g, "_");
  if (issueType === "it_support") return IT_SUPPORT_SUBMIT_REQUIRED;
  return CYBER_SUBMIT_REQUIRED; // cyber + not_sure
}


function isMeaningfulFieldValue(collected: CollectedData, field: string): boolean {
  const value = collected[field];
  if (value === null || value === undefined) return false;
  if (typeof value === "string") {
    const text = value.trim();
    if (field === "description") return text.length >= 10;
    return text.length > 0;
  }
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function getRequiredMissingFields(
  collected: CollectedData,
): string[] {
  // Submission gating is independent from optional conversational fields.
  // This keeps "Submit" behavior stable even when additional prompts are deferred.
  const requiredFields = getSubmitRequiredFields(collected);
  return [...requiredFields].filter((field) => !isMeaningfulFieldValue(collected, field));
}

function normalizeForCompare(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item).trim().toLowerCase())
      .sort()
      .join("|");
  }
  return String(value).trim().toLowerCase();
}

function hasCollectedMeaningfulDelta(before: CollectedData, after: CollectedData): boolean {
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of allKeys) {
    if (normalizeForCompare(before[key]) !== normalizeForCompare(after[key])) {
      return true;
    }
  }
  return false;
}

function toDisplayFieldLabel(field: string): string {
  return EDIT_FIELD_LABELS[field] || field.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function ReportIncidentChat({
  user,
  role,
  onLogout,
}: ReportIncidentChatProps) {
  const INITIAL_ASSISTANT_MESSAGE =
    "Hello, I am your incident and IT support reporting assistant. Please describe what happened, when you noticed it, and where it occurred.";

  const navigate = useNavigate();
  const { showToast } = useToast();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasFetchedSuggestionsRef = useRef(false);

  // Keep a single initialization promise so repeated calls do not trigger
  // multiple network requests for the same conversation.
  const initPromiseRef = useRef<Promise<string> | null>(null);

  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", content: INITIAL_ASSISTANT_MESSAGE },
  ]);
  const [collected, setCollected] = useState<CollectedData>({});
  const [missing, setMissing] = useState<string[]>([]);
  const [_isComplete, setIsComplete] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const [nextHints, setNextHints] = useState<NextHints>({});
  const [attachments, setAttachments] = useState<File[]>([]);
  const [fieldSuggestions, setFieldSuggestions] = useState<Record<string, string>>({});
  const [postSkipRecollect, setPostSkipRecollect] = useState<PostSkipRecollectState | null>(null);

  const MAX_FILES = 5;
  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  const MAX_TOTAL_SIZE = 20 * 1024 * 1024;
  const ALLOWED_TYPES = [
    "image/png",
    "image/jpeg",
    "image/jpg",
    "application/pdf",
    "text/plain",
    "message/rfc822",
    "application/vnd.ms-outlook",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ];

  // Always keep the latest chat content visible.
  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Fetch field suggestions only after the description is meaningful enough.
  // This keeps the extra request out of the initial page load.
  useEffect(() => {
    const description =
      typeof collected.description === "string"
        ? collected.description.trim()
        : "";

    if (
      description.length < 10 ||
      !conversationId ||
      hasFetchedSuggestionsRef.current
    ) {
      return;
    }

    hasFetchedSuggestionsRef.current = true;

    (async () => {
      try {
        const idToken = await auth.currentUser?.getIdToken();
        const res = await fetch(
          `${API_BASE_URL}/api/conversation/${conversationId}/suggestions`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${idToken}`,
            },
          }
        );

        if (!res.ok) return;

        const data = await res.json();
        if (data.suggestions && typeof data.suggestions === "object") {
          setFieldSuggestions(data.suggestions);
        }
      } catch {
        // Suggestions are helpful but not essential, so failures are ignored.
      }
    })();
  }, [collected.description, conversationId]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const isConversationError = (message: string) => {
    const normalized = (message || "").toLowerCase();
    return (
      normalized.includes("conversation not found") ||
      normalized.includes("session not found") ||
      normalized.includes("invalid conversation")
    );
  };

  // Restore the page to a clean state when the current conversation
  // becomes invalid or expires on the backend.
  const resetConversationUI = (errorMessage: string) => {
    clearConversationWarmup();
    setConversationId(null);
    setCollected({});
    setMissing([]);
    setIsComplete(false);
    setNextHints({});
    setMessages([{ role: "assistant", content: INITIAL_ASSISTANT_MESSAGE }]);
    setError(errorMessage);
    hasFetchedSuggestionsRef.current = false;
    initPromiseRef.current = null;
  };

  // Keep the input available while the session is initializing so the page
  // feels responsive instead of looking blocked for a couple of seconds.
  const composerDisabled = isSending || submitSuccess || submitting;

  const initializeConversation = useCallback(async (options?: { silent?: boolean }): Promise<string> => {
    if (conversationId) return conversationId;
    if (initPromiseRef.current) return initPromiseRef.current;

    const silent = options?.silent === true;

    const initPromise = (async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      try {
        if (!silent) {
          setIsInitializing(true);
          setError("");
        }

        const warmedConversation = consumeWarmedConversation();
        const conversation = warmedConversation || await Promise.race([
          warmupConversation(),
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener("abort", () => {
              reject(new DOMException("Initialization timed out", "AbortError"));
            }, { once: true });
          }),
        ]);

        const {
          conversation_id,
          initial_message,
          collected: initialCollected,
          missing: initialMissing,
          is_complete: initialIsComplete,
          next_hints,
        } = conversation as ConversationInitResponse;

        clearConversationWarmup();

        setConversationId(conversation_id);
        setMessages((prev) => {
          const hasUserMessage = prev.some((msg) => msg.role === "user");
          if (hasUserMessage) return prev;

          return [
            {
              role: "assistant",
              content: initial_message || INITIAL_ASSISTANT_MESSAGE,
            },
          ];
        });
        setCollected(initialCollected || {});
        setMissing(initialMissing || []);
        setIsComplete(initialIsComplete || false);
        setNextHints(next_hints || {});
        setError("");

        return conversation_id;
      } catch (err: unknown) {
        const isTimeout = err instanceof Error && err.name === "AbortError";

        setConversationId(null);
        if (!silent) {
          setError(
            isTimeout
              ? "Initialization timed out. Please click Retry to start a new secure session."
              : toUserFacingMessage(err, {
                  fallback: "Unable to initialize. Please click Retry.",
                })
          );
        }

        trackUxEvent("conversation_init_failed", {
          page: "report_incident_chat",
          action: silent ? "background_initialize" : "initialize",
          outcome: "error",
          message: err instanceof Error ? err.message : "init_failed",
        });

        console.error("Error initializing conversation:", err);
        throw err;
      } finally {
        clearTimeout(timeoutId);
        if (!silent) {
          setIsInitializing(false);
        }
        initPromiseRef.current = null;
      }
    })();

    initPromiseRef.current = initPromise;
    return initPromise;
  }, [conversationId]);

  useEffect(() => {
    if (conversationId || submitSuccess) return;

    void initializeConversation({ silent: true }).catch(() => {
      // The explicit send/retry path will surface errors if the warm-up failed.
    });
  }, [conversationId, initializeConversation, submitSuccess]);

  // Make sure a valid conversation exists before sending actions
  // that depend on the backend session.
  const ensureConversationReady = async (): Promise<string> => {
    if (conversationId) return conversationId;
    return initializeConversation();
  };

  const handleSendMessage = async (userMessage: string, rawValues?: string[]) => {
    if (!userMessage.trim() || isSending) return;

    setIsSending(true);
    setError("");

    // Capture which field is being answered before any async state changes.
    const currentField = missing[0];

    // For multi-select responses, display human-readable labels in the chat bubble
    // instead of raw enum values (e.g. "Credentials, Financial, Company Data" vs
    // "credentials, financial, company_data").
    const displayText =
      rawValues && rawValues.length > 0
        ? rawValues
            .map((v) =>
              v.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
            )
            .join(", ")
        : userMessage;

    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();

    try {
      // Show the user's message immediately so the interface reacts at once,
      // even if the backend still needs a moment to prepare the session.
      setMessages((prev) => [
        ...prev,
        { id: userId, role: "user", content: displayText },
        { id: assistantId, role: "assistant", content: "__loading__" },
      ]);

      const readyConversationId = await ensureConversationReady();
      const idToken = await auth.currentUser?.getIdToken();

      const response = await fetch(
        `${API_BASE_URL}/api/conversation/${readyConversationId}/message/stream`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${idToken}`,
            Accept: "text/event-stream",
          },
          body: JSON.stringify({
            message: userMessage,
          }),
        }
      );

      if (!response.ok || !response.body) {
        let errorMessage = "Failed to open streaming response";

        try {
          const text = await response.text();
          if (text) {
            const parsedError = JSON.parse(text);
            errorMessage = parsedError.error || errorMessage;
          }
        } catch {
          // Keep the default message if the error response cannot be parsed.
        }

        if (isConversationError(errorMessage)) {
          resetConversationUI(
            "Conversation expired or invalid. Please retry to initialize a new session."
          );
          return;
        }

        throw new Error(
          toUserFacingMessage(errorMessage, {
            fallback: "Unable to send your message right now. Please try again.",
          })
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      let buffer = "";
      let assistantMessage = "";
      let statusMessage = "";

      // Process each server-sent event as it arrives so the assistant response
      // can be displayed progressively instead of waiting for the full result.
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split("\n\n");
        buffer = events.pop() || "";

        for (const event of events) {
          if (!event.startsWith("data:")) continue;

          const jsonStr = event.replace(/^data:\s*/, "").trim();

          let parsed: StreamEvent;
          try {
            const parsedValue = JSON.parse(jsonStr) as unknown;
            if (!isRecord(parsedValue)) continue;
            parsed = parsedValue as StreamEvent;
          } catch {
            continue;
          }

          if (parsed.type === "status") {
            statusMessage = typeof parsed.message === "string" ? parsed.message : "";
          } else if (parsed.type === "field_update") {
            const fieldName = parsed.field;
            if (typeof fieldName === "string") {
              setCollected((prev) => ({
                ...prev,
                [fieldName]: parsed.value,
              }));
            }
          } else if (parsed.type === "chunk") {
            assistantMessage += typeof parsed.content === "string" ? parsed.content : "";
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantId
                  ? { ...msg, content: assistantMessage }
                  : msg
              )
            );
          } else if (parsed.type === "done") {
            const finalMessage =
              (typeof parsed.assistant_message === "string" ? parsed.assistant_message : "") || assistantMessage || statusMessage;

            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantId
                  ? { ...msg, content: finalMessage }
                  : msg
              )
            );

              let nextCollectedFromDone: CollectedData = {};
              setCollected((prev) => {
                const incoming = parsed.collected;
                if (
                  incoming &&
                  typeof incoming === "object" &&
                Object.keys(incoming).length > 0
              ) {
                const sanitizedIncoming = { ...incoming } as CollectedData;
                // If the user submitted explicit multi-select values, trust the
                // UI selection over the backend's text-extracted version so no
                // items are silently dropped during parsing.
                if (rawValues && rawValues.length > 0 && typeof currentField === "string") {
                  nextCollectedFromDone = { ...sanitizedIncoming, [currentField]: rawValues };
                  return nextCollectedFromDone;
                }
                  nextCollectedFromDone = sanitizedIncoming;
                  return nextCollectedFromDone;
                }
                nextCollectedFromDone = prev;
                return prev;
              });

              const incomingMissing = Array.isArray(parsed.missing) ? parsed.missing : [];

              if (postSkipRecollect) {
                const collectedChanged = hasCollectedMeaningfulDelta(
                  postSkipRecollect.baselineCollected,
                  nextCollectedFromDone,
                );

                const baselineMissingSet = new Set(postSkipRecollect.baselineMissing);
                const incomingMissingSet = new Set(incomingMissing);
                const missingImproved = Array.from(baselineMissingSet).some(
                  (field) => !incomingMissingSet.has(field),
                );

                if (!collectedChanged && !missingImproved) {
                  const requiredStillMissing = getRequiredMissingFields(nextCollectedFromDone);
                  const fallbackFields = requiredStillMissing.length > 0
                    ? requiredStillMissing
                    : incomingMissing.slice(0, 5);

                  const template = fallbackFields
                    .map((field) => `${toDisplayFieldLabel(field)}: `)
                    .join("\n");

                  setMessages((prev) => [
                    ...prev,
                    {
                      role: "assistant",
                      content:
                        "I could not detect additional structured facts from your last update. Please fill this structured template so I can capture missing fields correctly.",
                    },
                  ]);
                  setNextHints({
                    type: "textarea",
                    placeholder: template || "Time Discovered: ...\nCategory: ...\nSeverity: ...\nImpact Scope: ...",
                  });
                  setIsComplete(false);
                } else {
                  setMessages((prev) => [
                    ...prev,
                    {
                      role: "assistant",
                      content:
                        "Thanks, I captured the additional details. You can continue editing, or click 'I don't have more information' again to finalize.",
                    },
                  ]);
                }

                setPostSkipRecollect(null);
              }

              setMissing(incomingMissing);
              setIsComplete(parsed.is_complete === true);
              setNextHints(parsed.next_hints || {});
            } else if (parsed.type === "error") {
              const errorMessage = typeof parsed.message === "string" ? parsed.message : "";
              if (isConversationError(errorMessage)) {
                resetConversationUI(
                  "Conversation expired or invalid. Please retry to initialize a new session."
                );
                return;
              }

              throw new Error(errorMessage || "Stream error");
            }
          }
        }
      } catch (err: unknown) {
        const message = toUserFacingMessage(err, {
          fallback: "Unable to send your message. Please try again.",
        });

      if (isConversationError(message)) {
        resetConversationUI(
          "Conversation expired or invalid. Please retry to initialize a new session."
        );
      } else {
        setError(message);
        showToast({
          type: "error",
          title: "Message send failed.",
          message,
          action: {
            label: "Retry",
            onClick: () => setError(""),
          },
        });
      }

      trackUxEvent("conversation_message_failed", {
        page: "report_incident_chat",
        action: "send_message",
        outcome: "error",
        message,
      });

      console.error("Error sending message:", err);

      // Remove the temporary assistant placeholder if the request fails.
      setMessages((prev) => prev.filter((msg) => msg.id !== assistantId));
    } finally {
      setIsSending(false);
    }
  };

  // Unified submit entry-point. Replaces the old "Finalize Report" skip flow.
  // Always visible; disabled until canSubmit is true.
  const handleSubmitClick = () => {
    if (submitting || submitSuccess) return;

    const missing_ = getRequiredMissingFields(collected);
    if (missing_.length > 0) {
      const labels = missing_.map(
        (f) => f.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      );
      showToast({
        type: "warning",
        title: "Required fields missing",
        message: `Please complete: ${labels.join(", ")}`,
        durationMs: 5000,
      });
      return;
    }

    void handleSubmit();
  };

  const handleSubmit = async () => {
    if (submitting) return;

    setSubmitting(true);
    setError("");

    try {
      // Build the final ticket payload from the information gathered
      // during the AI conversation.
      const resolvedIssueType =
        collected.issue_type === "cyber" || collected.issue_type === "it_support"
          ? collected.issue_type
          : undefined;

      // Build payload with ONLY truly collected fields.
      // Do NOT add default values - let backend handle missing fields with proper validation.
      const ticketData: Record<string, unknown> = {
        created_by_uid: user.uid,
        issue_type: resolvedIssueType,
        intake_mode: resolvedIssueType === "it_support" ? "standard" : "fast",

        category:         collected.category || undefined,
        category_other_text: collected.category_other_text || undefined,
        severity:         collected.severity || undefined,
        description:      collected.description || undefined,

        location_type:    collected.location_type || undefined,
        location_detail:  collected.location_detail || undefined,

        noticed_time:     collected.noticed_time || undefined,

        response_taken:   collected.response_taken !== undefined ? collected.response_taken : undefined,
        response_details: collected.response_details || undefined,
        affected_asset:
          resolvedIssueType === "it_support"
            ? (collected.affected_asset || undefined)
            : undefined,
        error_symptom:
          resolvedIssueType === "it_support"
            ? (collected.error_symptom || undefined)
            : undefined,

        data_involved_flag:
          resolvedIssueType === "cyber"
            ? (collected.data_involved_flag !== undefined ? collected.data_involved_flag : undefined)
            : undefined,
        data_involved:
          resolvedIssueType === "cyber" && collected.data_involved
            ? collected.data_involved
            : undefined,
        data_other_text:
          resolvedIssueType === "cyber"
            ? (collected.data_other_text || undefined)
            : undefined,

        incident_active:
          collected.incident_active !== undefined
            ? collected.incident_active
            : undefined,  // No default true

        impact_scope:     collected.impact_scope || undefined,
        work_continuity:  collected.work_continuity || undefined,

        external_party_involved:
          resolvedIssueType === "cyber"
            ? (collected.external_party_involved !== undefined ? collected.external_party_involved : undefined)
            : undefined,
        external_party_details:
          resolvedIssueType === "cyber"
            ? (collected.external_party_details || undefined)
            : undefined,

        already_reported_to_it:
          resolvedIssueType === "cyber"
            ? (collected.already_reported_to_it !== undefined ? collected.already_reported_to_it : undefined)
            : undefined,
        reported_to_details:
          resolvedIssueType === "cyber"
            ? (collected.reported_to_details || undefined)
            : undefined,

        preferred_contact_method: collected.preferred_contact_method || undefined,
        phone_number:     collected.phone_number || undefined,
        attachments,
      };

      // Remove any undefined fields to keep payload clean
      Object.keys(ticketData).forEach(
        (key) => ticketData[key] === undefined && delete ticketData[key]
      );

      // Run backend validation and final submit-time classification before saving.
      const validation = await validateAndClassify(ticketData as Parameters<typeof validateAndClassify>[0]);
      if (validation.ticket_data && isRecord(validation.ticket_data)) {
        Object.assign(ticketData, validation.ticket_data);
        ticketData.created_by_uid = user.uid;
        ticketData.attachments = attachments;
        ticketData.intake_mode =
          ticketData.issue_type === "it_support" ? "standard" : "fast";
      }

      // Create the ticket record in Firestore.
      const { ticketId, docId, attachmentUploadPending } = await createTicket(ticketData as Parameters<typeof createTicket>[0]);

      // Record ticket creation for audit or analytics purposes without blocking submit.
      void logTicketCreated({
        ticket_id: ticketId,
        doc_id: docId,
        category: String(ticketData.category || ""),
        severity: String(ticketData.severity || ""),
      }).catch((auditError) => {
        logger.warn("Chat ticket audit logging failed", {
          ticketId,
          docId,
          error: String(auditError),
        });
      });

      setSubmitSuccess(true);
      showToast({
        type: "success",
        title: "Report submitted.",
        message: `Ticket ID: ${ticketId}`,
        durationMs: 3500,
      });

      if (attachmentUploadPending) {
        showToast({
          type: "warning",
          title: "Attachments are still uploading.",
          message: "The report is saved. Attachment uploads will finish in the background.",
          durationMs: 6000,
        });
      }
      trackUxEvent("incident_submit_success", {
        page: "report_incident_chat",
        action: "submit",
        outcome: "success",
      });

      // Redirect to the ticket list shortly after successful submission.
      setTimeout(() => {
        navigate(role === "admin" ? "/admin/tickets" : "/my-tickets");
      }, 2000);
    } catch (err: unknown) {
      const message = toUserFacingMessage(err, {
        fallback: "Unable to submit your report right now. Please try again.",
      });
      setError(message);
      showToast({
        type: "error",
        title: "Submission failed.",
        message,
        action: {
          label: "Retry",
          onClick: () => setError(""),
        },
      });
      trackUxEvent("incident_submit_failed", {
        page: "report_incident_chat",
        action: "submit",
        outcome: "error",
        message,
      });
      console.error("Error submitting ticket:", err);
    } finally {
      setSubmitting(false);
    }
  };

  const handlePickFiles = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newFiles = Array.from(e.target.files || []);
    if (newFiles.length === 0) return;

    const next = [...attachments];
    const errors: string[] = [];
    let totalSize = next.reduce((sum, file) => sum + file.size, 0);

    for (const file of newFiles) {
      if (next.length >= MAX_FILES) {
        errors.push(`You can upload up to ${MAX_FILES} files.`);
        break;
      }

      if (!ALLOWED_TYPES.includes(file.type)) {
        errors.push(`${file.name}: unsupported file type.`);
        continue;
      }

      if (file.size > MAX_FILE_SIZE) {
        errors.push(`${file.name}: exceeds the 10 MB limit.`);
        continue;
      }

      if (totalSize + file.size > MAX_TOTAL_SIZE) {
        errors.push(`${file.name}: total attachment size would exceed 20 MB.`);
        continue;
      }

      next.push(file);
      totalSize += file.size;
    }

    setAttachments(next);

    if (errors.length > 0) {
      const message = toUserFacingMessage(errors.join("; "));
      setError(message);
      showToast({
        type: "warning",
        title: "Some files were not added.",
        message,
        durationMs: 5000,
      });
      trackUxEvent("attachment_validation_failed", {
        page: "report_incident_chat",
        action: "add_attachment",
        outcome: "error",
        message,
      });
    }

    e.target.value = "";
  };

  const handleRemoveFile = (name: string) => {
    setAttachments((prev) => prev.filter((f) => f.name !== name));
  };

  const handleUpdateCollectedField = (fieldName: string, value: unknown) => {
    const nextCollected = { ...collected, [fieldName]: value };
    setCollected((prev) => ({ ...prev, [fieldName]: value }));
    setError("");


    const currentExpected = missing[0] || null;
    let immediateField: string | null = null;
    let nextMissing = [...missing];
    const ensureMissing = (name: string) => {
      if (!nextMissing.includes(name)) nextMissing.push(name);
    };
    const removeMissing = (name: string) => {
      nextMissing = nextMissing.filter((item) => item !== name);
    };

    if (isMeaningfulFieldValue(nextCollected, fieldName)) {
      removeMissing(fieldName);
    } else {
      ensureMissing(fieldName);
    }

    const followUp = PANEL_FOLLOW_UP[fieldName];
    if (followUp) {
      if (value === true) {
        const existing = nextCollected[followUp.field];
        const followUpFieldEmpty = !existing || (Array.isArray(existing) && existing.length === 0);
        if (followUpFieldEmpty) {
          ensureMissing(followUp.field);
          immediateField = followUp.field;
        }
      } else if (value === false) {
        removeMissing(followUp.field);
      }
    }

    if (fieldName === "category") {
      const category = String(value || "").trim().toLowerCase();
      if (category === "other" && !isMeaningfulFieldValue(nextCollected, "category_other_text")) {
        ensureMissing("category_other_text");
        immediateField = "category_other_text";
      } else if (category !== "other") {
        removeMissing("category_other_text");
      }
    }

    if (fieldName === "preferred_contact_method") {
      const method = String(value || "").trim().toLowerCase();
      if (method === "phone" && !isMeaningfulFieldValue(nextCollected, "phone_number")) {
        ensureMissing("phone_number");
        immediateField = "phone_number";
      } else if (method !== "phone") {
        removeMissing("phone_number");
      }
    }

    if (fieldName === "data_involved") {
      const list = Array.isArray(value) ? value.map((v) => String(v).toLowerCase()) : [];
      if (list.includes("other") && !isMeaningfulFieldValue(nextCollected, "data_other_text")) {
        ensureMissing("data_other_text");
        immediateField = "data_other_text";
      } else if (!list.includes("other")) {
        removeMissing("data_other_text");
      }
    }

    const deduped = Array.from(new Set(nextMissing));
    let orderedMissing: string[];
    if (immediateField && deduped.includes(immediateField)) {
      orderedMissing = [immediateField, ...deduped.filter((field) => field !== immediateField)];
      if (currentExpected && currentExpected !== immediateField && orderedMissing.includes(currentExpected)) {
        orderedMissing = [
          immediateField,
          currentExpected,
          ...orderedMissing.filter((field) => field !== immediateField && field !== currentExpected),
        ];
      }
    } else {
      orderedMissing =
        currentExpected && deduped.includes(currentExpected)
          ? [currentExpected, ...deduped.filter((field) => field !== currentExpected)]
          : deduped;
    }
    setMissing(orderedMissing);

    const requiredMissingNow = getRequiredMissingFields(nextCollected);
    if (requiredMissingNow.length > 0) {
      setIsComplete(false);
    }

    const nextExpected = orderedMissing[0] || null;
    const editedLabel = toDisplayFieldLabel(fieldName);
    const guidance: string[] = [`Noted. I updated ${editedLabel}.`];

    if (followUp && value === true && orderedMissing.includes(followUp.field)) {
      if (nextExpected === followUp.field) {
        guidance.push(followUp.question);
        if (currentExpected && currentExpected !== followUp.field) {
          guidance.push(`I will return to ${toDisplayFieldLabel(currentExpected)} right after this.`);
        }
      } else {
        guidance.push(`I noted ${toDisplayFieldLabel(followUp.field)} and will ask it in sequence.`);
      }
    }
    if (fieldName === "category" && String(value || "").trim().toLowerCase() === "other") {
      guidance.push("Please provide Category Details for Other.");
      if (currentExpected && currentExpected !== "category_other_text") {
        guidance.push(`I will return to ${toDisplayFieldLabel(currentExpected)} right after this.`);
      }
    }
    if (fieldName === "preferred_contact_method" && String(value || "").trim().toLowerCase() === "phone") {
      guidance.push("Please provide your phone number.");
      if (currentExpected && currentExpected !== "phone_number") {
        guidance.push(`I will return to ${toDisplayFieldLabel(currentExpected)} right after this.`);
      }
    }
    if (fieldName === "data_involved") {
      const list = Array.isArray(value) ? value.map((v) => String(v).toLowerCase()) : [];
      if (list.includes("other")) {
        guidance.push("Please provide Other Data Details.");
        if (currentExpected && currentExpected !== "data_other_text") {
          guidance.push(`I will return to ${toDisplayFieldLabel(currentExpected)} right after this.`);
        }
      }
    }

    if (nextExpected && nextExpected !== currentExpected) {
      guidance.push(`Next, let's continue with ${toDisplayFieldLabel(nextExpected)}.`);
    }
    if (requiredMissingNow.length === 0) {
      guidance.push("Minimum required fields are complete. You can submit anytime.");
    }

    const guidanceMessage = guidance.join(" ");
    setMessages((msgs) =>
      msgs.some((m) => m.role === "assistant" && m.content === guidanceMessage)
        ? msgs
        : [...msgs, { role: "assistant", content: guidanceMessage }],
    );

    if (nextExpected === "phone_number") {
      setNextHints({ type: "text", placeholder: "+1-555-0123" });
    } else if (nextExpected === "data_involved") {
      setNextHints({
        type: "multi_select",
        options: [
          { value: "personal_info", label: "Personal Info" },
          { value: "credentials", label: "Credentials" },
          { value: "financial", label: "Financial" },
          { value: "company_data", label: "Company Data" },
          { value: "other", label: "Other" },
        ],
        placeholder: "Select all data types that apply",
      });
    }
  };

  const submitMissingFields = getRequiredMissingFields(collected);
  const canSubmit = submitMissingFields.length === 0 && !submitSuccess;


  return (
    <Layout user={user} role={role} onLogout={onLogout}>
      <div className="report-chat-container">
        <div className="report-chat-header">
          <div>
            <h1 className="report-chat-title">AI Incident Report</h1>
            <p className="report-chat-subtitle">
              Tell me what happened and I&apos;ll help you file the report
            </p>
          </div>

          <div className="header-submit-actions">
            <button
              onClick={handleSubmitClick}
              disabled={submitting || submitSuccess}
              className={`submit-button${canSubmit ? "" : " is-disabled"}`}
              title={
                canSubmit
                  ? "Submit your incident report"
                  : `Complete required fields first: ${submitMissingFields.map((f) => f.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())).join(", ")}`
              }
            >
              {submitting
                ? "Submitting..."
                : submitSuccess
                ? "✓ Submitted"
                : "Submit Report"}
            </button>
          </div>
        </div>

        {error && (
          <div className="error-banner">
            <span>⚠️ {error}</span>
            <div className="flex items-center gap-2">
              {!conversationId && (
                <button
                  onClick={() => void initializeConversation()}
                  className="rounded bg-red-700 px-3 py-1 text-xs text-white hover:bg-red-800"
                  disabled={isInitializing}
                >
                  {isInitializing ? "Retrying..." : "Retry"}
                </button>
              )}
              <button onClick={() => setError("")} className="close-btn">
                ✕
              </button>
            </div>
          </div>
        )}

        {isInitializing && !conversationId && (
          <div className="success-banner">
            <span>Initializing secure session...</span>
          </div>
        )}

        {submitSuccess && (
          <div className="success-banner">
            <span>✓ Report submitted successfully! Redirecting...</span>
          </div>
        )}

        <div className="report-chat-content">
          <div className="chat-section">
            <ChatWindow messages={messages} messagesEndRef={messagesEndRef} />

            <div className="attachment-wrap">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={handleFileChange}
                style={{ display: "none" }}
                accept=".png,.jpg,.jpeg,.pdf,.txt,.eml,.msg,.doc,.docx"
              />

              <div className="attachment-content">
                <div className="attachment-header">
                  <h3 className="attachment-title">📎 Attachments</h3>
                  <span className="attachment-counter">{attachments.length}/5</span>
                </div>

                <button
                  type="button"
                  className="attach-btn"
                  onClick={handlePickFiles}
                  disabled={composerDisabled || attachments.length >= 5}
                >
                  <span className="attach-icon">+</span>
                  <span className="attach-text">Add Files</span>
                </button>

                {attachments.length > 0 && (
                  <div className="attachment-list">
                    {attachments.map((file) => {
                      const sizeKB = (file.size / 1024).toFixed(1);
                      const ext = file.name.split(".").pop()?.toUpperCase() || "FILE";
                      return (
                        <div className="attachment-item" key={`${file.name}-${file.size}`}>
                          <div className="attachment-item-icon">{ext}</div>
                          <div className="attachment-item-info">
                            <div className="attachment-item-name">{file.name}</div>
                            <div className="attachment-item-size">{sizeKB} KB</div>
                          </div>
                          <button
                            type="button"
                            className="attachment-remove"
                            onClick={() => handleRemoveFile(file.name)}
                            disabled={composerDisabled}
                            title="Remove this file"
                          >
                            ✕
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <MessageInput
              key={missing[0] || 'complete'}
              onSendMessage={handleSendMessage}
              disabled={composerDisabled}
              placeholder={nextHints?.placeholder || "Describe what happened in as much detail as possible..."}
              hints={nextHints}
            />


          </div>

          <div className="info-section">
            <CollectedPanel
              collected={collected}
              missing={missing}
              onUpdateField={handleUpdateCollectedField}
              suggestions={fieldSuggestions}
              readOnly={submitSuccess}
            />
          </div>
        </div>
      </div>
    </Layout>
  );
}
