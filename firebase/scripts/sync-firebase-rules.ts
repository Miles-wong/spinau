import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const firebaseDir = resolve(__dirname, "..");

const sourcePath = resolve(firebaseDir, "security.rules.bundle");
const firestoreOut = resolve(firebaseDir, "generated", "firestore.rules");
const storageOut = resolve(firebaseDir, "generated", "storage.rules");

const source = readFileSync(sourcePath, "utf8");

function extractSection(name: string): string {
  const start = `# >>> ${name}`;
  const end = `# <<< ${name}`;
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end);

  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    throw new Error(`Missing or invalid section markers for ${name} in security.rules.bundle`);
  }

  const bodyStart = startIndex + start.length;
  const body = source.slice(bodyStart, endIndex).trim();
  if (!body) {
    throw new Error(`Section ${name} is empty in security.rules.bundle`);
  }
  return `${body}\n`;
}

const firestoreRules = extractSection("FIRESTORE");
const storageRules = extractSection("STORAGE");

mkdirSync(resolve(firebaseDir, "generated"), { recursive: true });
writeFileSync(firestoreOut, firestoreRules, "utf8");
writeFileSync(storageOut, storageRules, "utf8");

console.log("Generated Firebase rules:");
console.log(`- ${firestoreOut}`);
console.log(`- ${storageOut}`);
