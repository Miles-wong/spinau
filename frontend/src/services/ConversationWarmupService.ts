import { getAuthToken } from "./AuthService";

const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:5000";

export type WarmedConversation = {
  conversation_id: string;
  initial_message?: string;
  collected?: Record<string, unknown>;
  missing?: string[];
  is_complete?: boolean;
  next_hints?: Record<string, unknown>;
  messages?: Array<{ role: string; content: string }>;
};

let warmupPromise: Promise<WarmedConversation> | null = null;
let warmedConversation: WarmedConversation | null = null;

async function requestConversationInit(): Promise<WarmedConversation> {
  const storedConversationId = window.localStorage.getItem("activeConversationId") || "";
  const idToken = await getAuthToken();

  const response = await fetch(`${API_BASE_URL}/api/conversation/init`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify(
      storedConversationId ? { conversation_id: storedConversationId } : {}
    ),
  });

  if (!response.ok) {
    let errorMessage = "Failed to initialize conversation";

    try {
      const text = await response.text();
      if (text) {
        const errorData = JSON.parse(text) as { error?: string };
        errorMessage = errorData.error || errorMessage;
      }
    } catch {
      // Keep the default error message if the response is not JSON.
    }

    throw new Error(errorMessage);
  }

  return (await response.json()) as WarmedConversation;
}

export function warmupConversation(): Promise<WarmedConversation> {
  if (warmedConversation) return Promise.resolve(warmedConversation);
  if (warmupPromise) return warmupPromise;

  warmupPromise = requestConversationInit()
    .then((conversation) => {
      warmedConversation = conversation;
      return conversation;
    })
    .catch((error) => {
      warmedConversation = null;
      throw error;
    })
    .finally(() => {
      warmupPromise = null;
    });

  return warmupPromise;
}

export function consumeWarmedConversation(): WarmedConversation | null {
  const conversation = warmedConversation;
  warmedConversation = null;
  return conversation;
}

export function clearConversationWarmup() {
  warmupPromise = null;
  warmedConversation = null;
}
