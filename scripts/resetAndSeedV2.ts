/**
 * Reset and seed data for the new incident structure.
 *
 * What it does:
 * 1) Deletes all documents under `tickets` (including subcollections)
 * 2) Deletes all documents under `audit_logs`
 * 3) Seeds 10 tickets using the new structure with issue_type = cyber | it_support
 *
 * Run:
 *   npm run reset:seed:v2
 *
 * Optional args:
 *   npm run reset:seed:v2 -- --count=10 --reporter=<uid> --admin=<uid>
 */

import * as admin from "firebase-admin";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const serviceAccountPath = resolve(process.cwd(), "backend/serviceAccountKey.json");
const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, "utf8"));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
});

const db = admin.firestore();

const DEFAULT_COUNT = 10;
const DEFAULT_REPORTER_UID = "zTPa0HSjsaXwlr036agaeVZIrUz2";
const DEFAULT_ADMIN_UID = "Ft7dGJh2SLWCHbIg5VAQvV6dLIK2";

const CYBER_CATEGORIES = [
  "phishing",
  "malware",
  "email_exposure",
  "credential_compromise",
  "unauthorized_access",
  "data_breach",
  "device_loss",
  "suspicious_activity",
  "policy_violation",
  "infrastructure_issue",
  "other",
];

const IT_SUPPORT_CATEGORIES = [
  "hardware_issue",
  "network_issue",
  "software_issue",
  "access_account_issue",
  "communication",
  "performance_issue",
  "service_request",
  "technical_incident",
  "general_technical_support",
  "other",
];

const SEVERITIES = ["low", "medium", "high", "critical"];
const LOCATION_TYPES = ["email", "device", "network", "physical", "cloud", "other"];
const CONTACT_METHODS = ["email", "phone", "in_person", "teams"];
const DATA_TYPES = ["personal_info", "credentials", "financial", "company_data", "other"];

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomBool(): boolean {
  return Math.random() >= 0.5;
}

function randomPastDate(maxDaysAgo = 20): Date {
  const msAgo = Math.random() * maxDaysAgo * 24 * 60 * 60 * 1000;
  const d = new Date(Date.now() - msAgo);
  d.setHours(Math.floor(Math.random() * 12) + 8);
  d.setMinutes(Math.floor(Math.random() * 60));
  d.setSeconds(Math.floor(Math.random() * 60));
  d.setMilliseconds(0);
  return d;
}

function yyyymmdd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function makeTicketId(issueType: "cyber" | "it_support", category: string, dateStr: string): string {
  const root = issueType === "cyber" ? "C" : "I";
  const cat = String(category || "other").charAt(0).toUpperCase() || "X";
  const suffix = String(Math.floor(Math.random() * 9000) + 1000);
  return `${root}${cat}${dateStr}-${suffix}`;
}

async function clearCollection(collectionName: string): Promise<number> {
  const refs = await db.collection(collectionName).listDocuments();
  for (const ref of refs) {
    await db.recursiveDelete(ref);
  }
  return refs.length;
}

async function resolveUserUids(): Promise<{ reporterUid: string; adminUid: string }> {
  const explicitReporter = argValue("reporter");
  const explicitAdmin = argValue("admin");
  if (explicitReporter && explicitAdmin) {
    return { reporterUid: explicitReporter, adminUid: explicitAdmin };
  }

  const snap = await db.collection("users").get();
  type UserRow = {
    id: string;
    role?: string;
    is_active?: boolean;
  };

  const users: UserRow[] = snap.docs.map((d) => {
    const data = (d.data() || {}) as Record<string, unknown>;
    return {
      id: d.id,
      role: typeof data.role === "string" ? data.role : undefined,
      is_active: typeof data.is_active === "boolean" ? data.is_active : undefined,
    };
  });

  const reporter = users.find((u) => u.role === "reporter" && u.is_active !== false);
  const adminUser = users.find((u) => u.role === "admin" && u.is_active !== false);

  return {
    reporterUid: explicitReporter || reporter?.id || DEFAULT_REPORTER_UID,
    adminUid: explicitAdmin || adminUser?.id || DEFAULT_ADMIN_UID,
  };
}

function buildCyberDetails() {
  const dataInvolvedFlag = randomBool();
  const externalParty = randomBool();
  const alreadyReported = randomBool();

  const dataInvolved = dataInvolvedFlag ? [pick(DATA_TYPES)] : [];
  if (dataInvolvedFlag && Math.random() > 0.65) {
    const second = pick(DATA_TYPES);
    if (!dataInvolved.includes(second)) dataInvolved.push(second);
  }

  return {
    data_involved_flag: dataInvolvedFlag,
    data_involved: dataInvolved,
    data_other_text: dataInvolved.includes("other") ? "Legacy vendor export files" : "",
    external_party_involved: externalParty,
    external_party_details: externalParty ? "Third-party vendor email domain involved" : "",
    already_reported_to_it: alreadyReported,
    reported_to_details: alreadyReported ? "Reported to SOC via Teams at 10:30" : "",
  };
}

function buildTicketPayload(
  index: number,
  reporterUid: string,
  adminUid: string,
): Record<string, unknown> {
  const issueType = index % 2 === 0 ? "cyber" : "it_support";
  const category = issueType === "cyber" ? pick(CYBER_CATEGORIES) : pick(IT_SUPPORT_CATEGORIES);

  const createdDate = randomPastDate(21);
  const createdTs = admin.firestore.Timestamp.fromDate(createdDate);
  const updatedTs = admin.firestore.Timestamp.fromDate(new Date(createdDate.getTime() + Math.random() * 6 * 60 * 60 * 1000));

  const dateStr = yyyymmdd(createdDate);
  const ticketId = makeTicketId(issueType, category, dateStr);

  const responseTaken = randomBool();
  const incidentActive = randomBool();
  const contactMethod = pick(CONTACT_METHODS);
  const locationType = Math.random() > 0.35 ? pick(LOCATION_TYPES) : "";

  const commonPayload: Record<string, unknown> = {
    ticket_id: ticketId,
    status: "open",
    issue_type: issueType,
    category,
    category_other_text: category === "other" ? "Needs further triage" : "",
    severity: pick(SEVERITIES),
    noticed_time: createdTs,
    location_type: locationType,
    location_detail: locationType ? `User workspace ${index + 1}` : "",
    description:
      issueType === "cyber"
        ? `Possible ${category.replaceAll("_", " ")} detected from user report #${index + 1}.`
        : `IT support request #${index + 1} for ${category.replaceAll("_", " ")} impacting daily work.`,
    response_taken: responseTaken,
    response_details: responseTaken ? "Restarted client and isolated affected endpoint" : "",
    incident_active: incidentActive,
    work_continuity: incidentActive ? "Work is partially blocked" : "Work resumed with workaround",
    impact_scope: issueType === "cyber" ? "my_team" : "just_me",
    preferred_contact_method: contactMethod,
    phone_number: contactMethod === "phone" ? "+1-555-0101" : "",

    created_by_uid: reporterUid,
    updated_by_uid: adminUid,
    assigned_to_uid: adminUid,
    reported_time: createdTs,
    created_at: createdTs,
    updated_at: updatedTs,
  };

  if (issueType === "cyber") {
    Object.assign(commonPayload, buildCyberDetails());
  }

  return commonPayload;
}

async function seedTickets(count: number, reporterUid: string, adminUid: string): Promise<void> {
  for (let i = 0; i < count; i++) {
    const ref = db.collection("tickets").doc();
    const payload = buildTicketPayload(i, reporterUid, adminUid);
    await ref.set(payload);

    await db.collection("audit_logs").add({
      uid: reporterUid,
      action: "create_ticket",
      resource_type: "ticket",
      resource_id: ref.id,
      details: {
        ticket_id: payload.ticket_id,
        issue_type: payload.issue_type,
        category: payload.category,
        seeded: true,
      },
      status: "success",
      created_at: admin.firestore.Timestamp.now(),
    });

    console.log(`Seeded ${String(i + 1).padStart(2, "0")}/${count}: ${String(payload.ticket_id)}`);
  }
}

async function main(): Promise<void> {
  const countRaw = argValue("count");
  const count = Number.isFinite(Number(countRaw)) && Number(countRaw) > 0 ? Number(countRaw) : DEFAULT_COUNT;

  const { reporterUid, adminUid } = await resolveUserUids();

  console.log("Resetting collections...");
  const deletedTickets = await clearCollection("tickets");
  const deletedAuditLogs = await clearCollection("audit_logs");

  console.log(`Deleted tickets: ${deletedTickets}`);
  console.log(`Deleted audit_logs: ${deletedAuditLogs}`);

  console.log(`\nSeeding ${count} tickets using new structure...`);
  console.log(`reporter=${reporterUid}`);
  console.log(`admin=${adminUid}\n`);

  await seedTickets(count, reporterUid, adminUid);

  console.log(`\nDone. Seeded ${count} tickets with new structure.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("resetAndSeedV2 failed:", err);
    process.exit(1);
  });
