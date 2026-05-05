import { fetchDocument } from "./FirestoreUtils";
import { db } from "../firebase";
import { collection, getDocs, limit, query, where } from "firebase/firestore";

const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:5000";

export async function getAuthToken(): Promise<string> {
  try {
    const { auth } = await import("../firebase");
    const user = auth.currentUser;
    if (!user) throw new Error("User not authenticated");
    return await user.getIdToken();
  } catch (error) {
    console.error("Error getting auth token:", error);
    throw new Error("Authentication failed");
  }
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

export async function getUserRole(uid: string): Promise<string> {
  try {
    const data = await fetchDocument("users", uid);
    const role = (data as { role?: string })?.role;
    return role || "";
  } catch (error) {
    console.error("Error in getUserRole:", error);
    throw error;
  }
}

// Module-level cache so repeated pages don't re-fetch the same UIDs
const _userLabelCache = new Map<string, string>();

/**
 * Resolve a single UID to a human-readable label (display_name > email > uid).
 * Silently falls back to the raw uid on any fetch error.
 */
export async function resolveUserLabel(uid: string): Promise<string> {
  if (!uid) return "-";
  if (_userLabelCache.has(uid)) return _userLabelCache.get(uid)!;
  try {
    const data = (await fetchDocument("users", uid)) as Record<string, unknown>;
    const label = String(data?.display_name || data?.email || uid);
    _userLabelCache.set(uid, label);
    return label;
  } catch {
    _userLabelCache.set(uid, uid);
    return uid;
  }
}

/**
 * Resolve an array of UIDs in parallel, returning a uid→label map.
 */
export async function resolveUserLabels(uids: string[]): Promise<Record<string, string>> {
  // Collapse duplicates first to avoid repeated Firestore reads for the same account.
  const unique = [...new Set(uids.filter(Boolean))];
  const results = await Promise.allSettled(unique.map((uid) => resolveUserLabel(uid)));
  const out: Record<string, string> = {};
  unique.forEach((uid, i) => {
    const r = results[i];
    out[uid] = r.status === "fulfilled" ? r.value : uid;
  });
  return out;
}

export type UserRoleOption = {
  uid: string;
  label: string;
};

/**
 * Load users for a specific role from Firestore users collection.
 */
export async function listUsersByRole(role: string, pageSize: number = 200): Promise<UserRoleOption[]> {
  const q = query(collection(db, "users"), where("role", "==", role), limit(pageSize));
  const snapshot = await getDocs(q);

  return snapshot.docs
    .map((docSnap) => {
      const data = docSnap.data() as Record<string, unknown>;
      const uid = docSnap.id;
      const label = String(data.display_name || data.email || uid);
      return { uid, label };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}
