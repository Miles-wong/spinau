import { fetchDocument } from "./FirestoreUtils";
import { auth, db } from "../firebase";
import { collection, getDocs, limit, query, where } from "firebase/firestore";
import { onAuthStateChanged, type User } from "firebase/auth";

const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:5000";

export async function getAuthToken(): Promise<string> {
  try {
    const user = auth.currentUser || (await waitForAuthUser(2500));
    if (!user) throw new Error("User not authenticated");
    return await user.getIdToken();
  } catch (error) {
    console.error("Error getting auth token:", error);
    throw new Error("Authentication failed");
  }
}

function waitForAuthUser(timeoutMs: number): Promise<User | null> {
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    const timer = window.setTimeout(() => {
      unsubscribe();
      resolve(auth.currentUser);
    }, timeoutMs);
    unsubscribe = onAuthStateChanged(auth, (user) => {
      window.clearTimeout(timer);
      unsubscribe();
      resolve(user);
    });
  });
}

export async function callBackendAPI<T>(
  endpoint: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "POST",
  body?: unknown
): Promise<T> {
  const token = await getAuthToken();

  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  let data: Record<string, unknown> = {};
  try {
    const text = await response.text();
    if (text) {
      data = JSON.parse(text);
    }
  } catch (parseError) {
    console.error("Failed to parse API response:", parseError);
    throw new Error("Invalid response from server");
  }

  if (!response.ok) {
    const errorMessage = typeof data.error === "string" ? data.error : `API error: ${response.status}`;
    throw new Error(errorMessage);
  }

  return data as T;
}

export async function ensureUserProfile(params?: {
  displayName?: string;
  provider?: string;
}): Promise<{ ok: boolean; email: string; role?: string }> {
  return callBackendAPI("/api/users/ensure-profile", "POST", {
    display_name: params?.displayName || "",
    provider: params?.provider || "",
  });
}

export async function getUserRole(email: string): Promise<string> {
  try {
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const data = await fetchDocument("users", normalizedEmail);
    const role = (data as { role?: string })?.role;
    return role || "";
  } catch (error) {
    console.error("Error in getUserRole:", error);
    throw error;
  }
}

const _userLabelCache = new Map<string, string>();

export async function resolveUserLabel(email: string): Promise<string> {
  if (!email) return "-";
  if (_userLabelCache.has(email)) return _userLabelCache.get(email)!;
  try {
    const normalizedEmail = String(email).trim().toLowerCase();
    const data = (await fetchDocument("users", normalizedEmail)) as Record<string, unknown>;
    const label = String(data?.display_name || data?.email || normalizedEmail);
    _userLabelCache.set(email, label);
    return label;
  } catch {
    _userLabelCache.set(email, email);
    return email;
  }
}

export async function resolveUserLabels(emails: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(emails.filter(Boolean))];
  const results = await Promise.allSettled(unique.map((email) => resolveUserLabel(email)));
  const out: Record<string, string> = {};
  unique.forEach((email, i) => {
    const r = results[i];
    out[email] = r.status === "fulfilled" ? r.value : email;
  });
  return out;
}

export type UserRoleOption = {
  email: string;
  label: string;
};

export async function listUsersByRole(role: string, pageSize: number = 200): Promise<UserRoleOption[]> {
  const q = query(collection(db, "users"), where("role", "==", role), limit(pageSize));
  const snapshot = await getDocs(q);

  return snapshot.docs
    .map((docSnap) => {
      const data = docSnap.data() as Record<string, unknown>;
      const email = String(data.email || docSnap.id).toLowerCase();
      const label = String(data.display_name || email);
      return { email, label };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}
