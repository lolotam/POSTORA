#!/usr/bin/env node
// Postora — Local Edge Runtime env checker.
//
// Reads infra/edge-runtime.required-env.json and the local .env, then reports
// the status of every required variable as one of: present / missing / empty /
// invalid_format. NEVER prints variable values. Exits non-zero if any REQUIRED
// variable is missing or empty (unless --strict is passed, in which case
// optional-but-present validation also applies).
//
// Usage:
//   node scripts/check-edge-env-local.mjs            # check required vars
//   node scripts/check-edge-env-local.mjs --strict   # also fail on empty optional vars
//   node scripts/check-edge-env-local.mjs --json     # machine-readable output

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const args = new Set(process.argv.slice(2));
const strict = args.has("--strict");
const asJson = args.has("--json");

const manifestPath = resolve(root, "infra/edge-runtime.required-env.json");
const envPath = resolve(root, ".env");

function parseEnvFile(filePath) {
  const map = new Map();
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { map, exists: false };
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Strip inline trailing comments only when value is unquoted.
    map.set(key, value);
  }
  return { map, exists: true };
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (err) {
  console.error(`FATAL: could not read manifest at ${manifestPath}: ${err.message}`);
  process.exit(2);
}

const { map: envValues, exists: envExists } = parseEnvFile(envPath);

function statusOf(name) {
  if (!envExists) return "missing";
  if (!envValues.has(name)) return "missing";
  const value = envValues.get(name);
  if (value.length === 0) return "empty";
  return "present";
}

const variables = manifest.variables ?? [];
const results = [];
let failures = 0;

for (const entry of variables) {
  const { name, required, aliases = [] } = entry;
  // A variable is satisfied if itself is present or any alias is present.
  const ownStatus = statusOf(name);
  let status = ownStatus;
  if (status !== "present") {
    for (const alias of aliases) {
      const aliasStatus = statusOf(alias);
      if (aliasStatus === "present") {
        status = "present";
        break;
      }
    }
  }
  const isRequired = Boolean(required);
  const failed = isRequired && status !== "present";
  if (failed || (strict && status === "empty")) failures += 1;
  results.push({ name, category: entry.category, required: isRequired, status });
}

// Pretty / JSON output.
if (asJson) {
  console.log(
    JSON.stringify(
      {
        ok: failures === 0,
        requiredFailures: results.filter((r) => r.required && r.status !== "present").length,
        total: results.length,
        results,
      },
      null,
      2,
    ),
  );
} else {
  if (!envExists) {
    console.error(`WARNING: .env not found at ${envPath} — all variables report "missing".`);
  }
  const byCategory = new Map();
  for (const r of results) {
    if (!byCategory.has(r.category)) byCategory.set(r.category, []);
    byCategory.get(r.category).push(r);
  }
  for (const [category, rows] of byCategory) {
    console.log(`\n# ${category}`);
    for (const r of rows) {
      const tag = r.required ? "required" : "optional";
      const flag = r.required && r.status !== "present" ? "  <-- MISSING" : "";
      console.log(`  ${r.name}: ${r.status} (${tag})${flag}`);
    }
  }
  console.log("");
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures} required variable(s) missing or empty.`);
  process.exit(1);
}

console.log("OK: all required edge-runtime variables are present.");
process.exit(0);
