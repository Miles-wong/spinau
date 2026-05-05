/**
 * Creates an admin user in Firebase Auth and Firestore.
 *
 * Usage:
 *   npm run create-admin
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
const tsNow = () => admin.firestore.Timestamp.now();

const DEFAULT_EMAIL = "admin@spingroup.global";
const DEFAULT_PASSWORD = "123456789";

async function createAdmin(): Promise<void> {
  console.log(`Creating admin user with email: ${DEFAULT_EMAIL}`);

  const userRecord = await admin.auth().createUser({
    email: DEFAULT_EMAIL,
    password: DEFAULT_PASSWORD,
    emailVerified: true,
  });

  const uid = userRecord.uid;

  await db.collection("users").doc(uid).set(
    {
      uid,
      role: "admin",
      display_name: "Admin",
      email: DEFAULT_EMAIL,
      is_active: true,
      created_at: tsNow(),
      updated_at: tsNow(),
    },
    { merge: true },
  );

  console.log(`Admin user created - email: ${DEFAULT_EMAIL}, password: ${DEFAULT_PASSWORD}`);
}

createAdmin()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Failed to create admin user:", err);
    process.exit(1);
  });
