import { db } from "../firebase";
import { collection, getDocs, query, limit, doc, getDoc, Timestamp } from "firebase/firestore";
import type { FirestoreValue } from "./ServiceTypes";

const normalizeValue = (value: FirestoreValue): FirestoreValue => {
  // Convert Firestore-native values into shapes that render cleanly in the UI.
  if (value instanceof Timestamp) {
    return value.toDate().toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(([key, item]) => [
      key,
      normalizeValue(item),
    ]);
    return Object.fromEntries(entries);
  }
  return value;
};

export function formatFirestoreData(data: FirestoreValue) {
  return normalizeValue(data);
}

export async function fetchCollection(collectionName: string, pageSize: number = 100) {
  const q = query(collection(db, collectionName), limit(pageSize));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function fetchDocument(collectionName: string, docId: string) {
  const snapshot = await getDoc(doc(db, collectionName, docId));
  if (!snapshot.exists()) {
    throw new Error(`Document not found in ${collectionName}`);
  }
  return { id: snapshot.id, ...snapshot.data() };
}
