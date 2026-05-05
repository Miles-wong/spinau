/**
 * Seeds tickets spread across the last 30 days.
 * Prompts for how many tickets to create.
 *
 * Usage:
 *   npm run seed
 *   npm run seed -- --reporter=<uid> --admin=<uid>
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

const DEFAULT_REPORTER_UID = "zTPa0HSjsaXwlr036agaeVZIrUz2";
const DEFAULT_ADMIN_UID = "Ft7dGJh2SLWCHbIg5VAQvV6dLIK2";

function getArgValue(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const reporterUid = getArgValue("reporter", DEFAULT_REPORTER_UID);
const adminUid = getArgValue("admin", DEFAULT_ADMIN_UID);

function rand<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function yyyymmdd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function makeTicketId(category: string, dateStr: string): string {
  const initial = String(category || "other").charAt(0).toUpperCase();
  const suffix = String(Math.floor(Math.random() * 9000) + 1000);
  return `${initial}${dateStr}-${suffix}`;
}

function randomPastDate(maxDaysAgo = 30): Date {
  const msAgo = Math.random() * maxDaysAgo * 24 * 60 * 60 * 1000;
  const d = new Date(Date.now() - msAgo);
  d.setHours(Math.floor(Math.random() * 14) + 7);
  d.setMinutes(Math.floor(Math.random() * 60));
  d.setSeconds(Math.floor(Math.random() * 60));
  d.setMilliseconds(0);
  return d;
}

async function writeAudit(
  ticketRef: FirebaseFirestore.DocumentReference,
  event: string,
  field: string,
  oldVal: unknown,
  newVal: unknown,
  actorUid: string,
  ts?: FirebaseFirestore.Timestamp,
): Promise<void> {
  await ticketRef.collection("audit").add({
    event,
    field,
    old_value: oldVal ?? "",
    new_value: newVal ?? "",
    changed_by_uid: actorUid,
    changed_at: ts || admin.firestore.Timestamp.now(),
  });
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolveAnswer) => {
    rl.question(question, (answer) => {
      rl.close();
      resolveAnswer(answer);
    });
  });
}

const severities = ["low", "medium", "high", "critical"];
const categories = ["phishing", "malware", "unauthorized_access", "data_leak", "other"];
const lifecycle = ["open", "assigned", "investigating", "resolved", "closed"];

async function seed(count: number): Promise<void> {
  console.log(`\nSeeding ${count} tickets spread over the last 30 days...`);
  console.log(`   reporter=${reporterUid}`);
  console.log(`   admin=${adminUid}\n`);

  for (let i = 1; i <= count; i++) {
    const ticketRef = db.collection("tickets").doc();

    const ticketDate = randomPastDate(30);
    const createdTs = admin.firestore.Timestamp.fromDate(ticketDate);
    const updatedDate = new Date(ticketDate.getTime() + Math.random() * 3 * 60 * 60 * 1000);
    const updatedTs = admin.firestore.Timestamp.fromDate(updatedDate);

    const dateStr = yyyymmdd(ticketDate);

    const creatorUid = Math.random() < 0.7 ? reporterUid : adminUid;

    const category = rand(categories);
    const ticket_id = makeTicketId(category, dateStr);

    const finalIndex = Math.floor(Math.random() * lifecycle.length);
    const finalStatus = lifecycle[finalIndex];

    const ticketData = {
      ticket_id,
      status: "open",
      reported_time: createdTs,
      created_at: createdTs,
      updated_at: updatedTs,
      created_by_uid: creatorUid,
      updated_by_uid: creatorUid,
      assigned_to_uid: null,
      classification: "incident",
      category,
      category_other_text: "",
      severity: rand(severities),
      noticed_time: createdTs,
      location_type: "Email",
      location_detail: "Outlook desktop client",
      description: "Suspicious email received with suspicious content.",
      incident_active: rand([true, false]),
      response_taken: rand([true, false]),
      response_details: "User isolated device from network and reported to supervisor.",
      email_exposure_clicked_link: rand(["yes", "no", "not_sure"]),
      email_exposure_opened_attachment: rand(["yes", "no", "not_sure"]),
      email_exposure_entered_credentials: rand(["yes", "no", "not_sure"]),
      data_involved: rand([
        ["customer_information"],
        ["financial_information"],
        ["staff_information"],
        ["customer_information", "financial_information"],
      ]),
      data_other_text: "",
      work_continuity: rand(["yes", "partial", "no_cannot_work"]),
      impact_scope: rand(["just_me", "my_team", "multi_dept"]),
      preferred_contact_method: rand(["email", "teams", "phone"]),
      phone_number: "",
      external_party_involved: rand(["yes", "no", "not_sure"]),
      external_party_details: "",
      already_reported_to_it: rand([true, false]),
      reported_to_details: "Reported via Teams to manager.",
      affected_assets: [
        "Laptop-Asset-001",
        rand(["Desktop-Asset-002", "Mobile-Asset-003", "Server-Asset-004"]),
      ],
      closure_summary: "",
      lessons_learned: "",
      closed_at: null,
      closed_by_uid: null,
      duplicate_of_ticket_id: "",
      related_ticket_ids: [] as string[],
    };

    await ticketRef.set(ticketData);
    await writeAudit(ticketRef, "ticket_created", "", "", "", creatorUid, createdTs);

    let currentStatus = "open";

    if (finalIndex >= 1) {
      await ticketRef.update({
        assigned_to_uid: adminUid,
        updated_at: admin.firestore.Timestamp.now(),
        updated_by_uid: adminUid,
      });
      await writeAudit(ticketRef, "assigned", "assigned_to_uid", "", adminUid, adminUid);

      await ticketRef.update({
        status: "assigned",
        updated_at: admin.firestore.Timestamp.now(),
        updated_by_uid: adminUid,
      });
      await writeAudit(ticketRef, "status_changed", "status", currentStatus, "assigned", adminUid);
      currentStatus = "assigned";
    }

    const nextStatuses = ["investigating", "resolved", "closed"];
    for (const s of nextStatuses) {
      if (lifecycle.indexOf(s) <= finalIndex) {
        await ticketRef.update({
          status: s,
          updated_at: admin.firestore.Timestamp.now(),
          updated_by_uid: adminUid,
        });
        await writeAudit(ticketRef, "status_changed", "status", currentStatus, s, adminUid);
        currentStatus = s;
      }
    }

    if (finalStatus === "closed") {
      await ticketRef.update({
        closure_summary: "Issue resolved and user trained.",
        lessons_learned: "User training on phishing required.",
        closed_at: admin.firestore.Timestamp.now(),
        closed_by_uid: adminUid,
        updated_at: admin.firestore.Timestamp.now(),
        updated_by_uid: adminUid,
      });
      await writeAudit(ticketRef, "ticket_closed", "closed_at", "", "set", adminUid);
    }

    const attachmentRef = await ticketRef.collection("attachments").add({
      name: "evidence.png",
      storage_path: `tickets/${ticketRef.id}/evidence.png`,
      content_type: "image/png",
      size: 50000,
      uploaded_by_uid: creatorUid,
      uploaded_at: createdTs,
    });

    await writeAudit(ticketRef, "attachment_uploaded", "attachments", "", attachmentRef.id, creatorUid, createdTs);
    await writeAudit(ticketRef, "attachment_downloaded", "attachments", "", attachmentRef.id, adminUid);

    await ticketRef.collection("actions").add({
      action_type: "initial_review",
      details: "Reviewed email headers and sender information.",
      created_by_uid: adminUid,
      created_at: updatedTs,
    });

    await ticketRef.collection("comments").add({
      author_uid: creatorUid,
      message: "Please check this urgently. I received this email unexpectedly.",
      visibility: "reporter",
      created_at: createdTs,
    });

    await ticketRef.collection("comments").add({
      author_uid: adminUid,
      message: "Confirmed suspicious activity. Investigating further.",
      visibility: "admin",
      created_at: updatedTs,
    });

    if (i % 5 === 0 || i === count) {
      console.log(`${i}/${count} tickets created...`);
    }
  }

  console.log(`\nSuccessfully seeded ${count} tickets spread over the last 30 days!`);
}

async function main(): Promise<void> {
  const answer = await ask("How many tickets do you want to create? ");
  const count = parseInt(answer.trim(), 10);
  if (!Number.isFinite(count) || count <= 0 || !Number.isInteger(count)) {
    console.error("Invalid input. Please enter a positive integer.");
    process.exit(1);
  }

  await seed(count);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
