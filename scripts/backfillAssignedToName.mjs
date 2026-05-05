/**
 * Backfill assigned_to_name on ticket documents using users/{uid}.display_name.
 *
 * Usage:
 *   node scripts/backfillAssignedToName.mjs
 */

import admin from "firebase-admin";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const serviceAccountPath = resolve(__dirname, "../backend/serviceAccountKey.json");
const serviceAccount = (await import(pathToFileURL(serviceAccountPath).href, { with: { type: "json" } })).default;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const tsNow = () => admin.firestore.Timestamp.now();

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) {
    out.push(array.slice(i, i + size));
  }
  return out;
}

async function loadUserLabel(uid) {
  if (!uid) return "";
  try {
    const snap = await db.collection("users").doc(uid).get();
    if (!snap.exists) return "";
    const data = snap.data() || {};
    return String(data.display_name || data.email || uid).trim();
  } catch (error) {
    console.warn(`Could not resolve label for uid ${uid}:`, error instanceof Error ? error.message : String(error));
    return "";
  }
}

async function main() {
  console.log("Loading tickets...");
  const ticketSnapshot = await db.collection("tickets").get();

  const candidates = ticketSnapshot.docs
    .map((docSnap) => ({ id: docSnap.id, data: docSnap.data() || {} }))
    .filter(({ data }) => {
      const assignedUid = String(data.assigned_to_uid || "").trim();
      const assignedName = String(data.assigned_to_name || "").trim();
      return assignedUid && !assignedName;
    });

  console.log(`Found ${candidates.length} ticket(s) needing assigned_to_name backfill.`);
  if (candidates.length === 0) {
    console.log("Nothing to backfill.");
    return;
  }

  const uniqueUids = [...new Set(candidates.map(({ data }) => String(data.assigned_to_uid || "").trim()).filter(Boolean))];
  const labels = new Map();

  for (const uid of uniqueUids) {
    const label = await loadUserLabel(uid);
    if (label) labels.set(uid, label);
  }

  const batches = chunk(candidates, 400);
  let updatedCount = 0;

  for (const [index, batchRows] of batches.entries()) {
    const batch = db.batch();
    for (const row of batchRows) {
      const assignedUid = String(row.data.assigned_to_uid || "").trim();
      const assignedName = labels.get(assignedUid);
      if (!assignedName) continue;

      batch.update(db.collection("tickets").doc(row.id), {
        assigned_to_name: assignedName,
        updated_at: tsNow(),
      });
      updatedCount += 1;
    }

    await batch.commit();
    console.log(`Committed batch ${index + 1}/${batches.length}.`);
  }

  console.log(`Backfill complete. Updated ${updatedCount} ticket(s).`);
}

main().catch((error) => {
  console.error("Backfill failed:", error);
  process.exit(1);
});
