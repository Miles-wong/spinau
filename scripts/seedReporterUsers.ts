/**
 * Seeds multiple reporter users in Firebase Auth + Firestore.
 * Prompts for how many users to create.
 * Email format: reporter<random>@spingroup.global
 * Password: 123456789
 *
 * Usage:
 *   npm run seed:reporters
 */

import * as admin from "firebase-admin";
import { createInterface } from "node:readline";
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

const PASSWORD = "123456789";
const EMAIL_DOMAIN = "spingroup.global";

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolveAnswer) => {
    rl.question(question, (answer) => {
      rl.close();
      resolveAnswer(answer);
    });
  });
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

function generateEmail(): string {
  return `reporter.${randomSuffix()}@${EMAIL_DOMAIN}`;
}

async function seedReporters(count: number): Promise<void> {
  console.log(`\nCreating ${count} reporter user(s)...\n`);

  for (let i = 1; i <= count; i++) {
    const email = generateEmail();
    const displayName = `Reporter ${i}`;

    try {
      const userRecord = await admin.auth().createUser({
        email,
        password: PASSWORD,
        displayName,
      });

      const uid = userRecord.uid;

      await db.collection("users").doc(uid).set({
        uid,
        role: "reporter",
        display_name: displayName,
        email,
        is_active: true,
        created_at: tsNow(),
        updated_at: tsNow(),
      });

      console.log(`[${i}/${count}] ${email} (uid: ${uid})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${i}/${count}] Failed to create user: ${msg}`);
    }
  }

  console.log(`\nDone. ${count} reporter user(s) seeded.`);
  console.log(`Password for all: ${PASSWORD}`);
  console.log(`Email domain: @${EMAIL_DOMAIN}`);
}

async function main(): Promise<void> {
  const answer = await ask("How many reporter users do you want to create? ");
  const count = parseInt(answer.trim(), 10);
  if (!Number.isFinite(count) || count <= 0 || !Number.isInteger(count)) {
    console.error("Invalid input. Please enter a positive integer.");
    process.exit(1);
  }

  await seedReporters(count);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
  });
