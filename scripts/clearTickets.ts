/**
 * One-off script to delete all tickets and subcollections.
 * Run: npm run clear:tickets
 */

import * as admin from "firebase-admin";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const serviceAccountPath = resolve(__dirname, "../backend/serviceAccountKey.json");
const serviceAccount = (await import(serviceAccountPath, { with: { type: "json" } })).default;

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
});

const db = admin.firestore();

async function clearTickets(): Promise<void> {
  const ticketRefs = await db.collection("tickets").listDocuments();
  if (ticketRefs.length === 0) {
    console.log("No tickets to delete.");
    return;
  }

  for (const ref of ticketRefs) {
    await db.recursiveDelete(ref);
    console.log(`Deleted ticket ${ref.id}`);
  }

  console.log(`Deleted ${ticketRefs.length} tickets (including subcollections).`);
}

clearTickets()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Failed to clear tickets:", err);
    process.exit(1);
  });
