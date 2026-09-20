#!/usr/bin/env node
// Postora — Arabic i18n coverage gate.
//
// Verifies translation key coverage between code and the Arabic resource bundles:
//   1. Walks src/**/*.{ts,tsx} (excluding any path containing __tests__).
//   2. Resolves each file's namespace from its useTranslation("<ns>") call.
//   3. Extracts every t("key.path", "English default") call in each file.
//   4. Flattens dotted paths in src/i18n/locales/ar/<ns>.json.
//   5. Checks for MISSING keys (used in code, absent from ar bundle)
//      and ORPHAN keys (present in ar bundle, used nowhere in code).
//   6. Exits non-zero on any missing or orphan key.
//
// Runs as `npm run check:i18n`.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

let totalFailures = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function listSourceFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const rel = relative(root, full);
    if (rel.includes("__tests__")) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
      listSourceFiles(full, out);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function flattenKeys(obj, prefix = "") {
  let keys = [];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return keys;
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      keys.push(...flattenKeys(v, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// 1. Walk code files and extract keys per namespace
// ---------------------------------------------------------------------------
const srcDir = join(root, "src");
const sourceFiles = listSourceFiles(srcDir);

const codeKeysByNs = new Map();
const tCallRegex = /\bt\(\s*["']([a-zA-Z0-9_.-]+)["']/g;
const useTranslationRegex = /useTranslation\(\s*["']([^"']+)["']\s*\)/g;

for (const file of sourceFiles) {
  const content = readFileSync(file, "utf8");
  const nsMatches = [...content.matchAll(useTranslationRegex)].map((m) => m[1]);
  if (nsMatches.length === 0) continue;

  const namespaces = [...new Set(nsMatches)];
  const fileKeys = new Set();
  let m;
  while ((m = tCallRegex.exec(content)) !== null) {
    fileKeys.add(m[1]);
  }

  for (const ns of namespaces) {
    if (!codeKeysByNs.has(ns)) {
      codeKeysByNs.set(ns, new Set());
    }
    const nsKeySet = codeKeysByNs.get(ns);
    for (const key of fileKeys) {
      nsKeySet.add(key);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Discover all namespaces (from locales directory and code)
// ---------------------------------------------------------------------------
const localesDir = join(root, "src", "i18n", "locales", "ar");
const localeNamespaces = new Set();

if (existsSync(localesDir)) {
  for (const entry of readdirSync(localesDir)) {
    if (entry.endsWith(".json")) {
      localeNamespaces.add(entry.slice(0, -5));
    }
  }
}

for (const ns of codeKeysByNs.keys()) {
  localeNamespaces.add(ns);
}

const allNamespaces = [...localeNamespaces].sort();

console.log("\nChecking Arabic (ar) i18n bundle coverage...");

// ---------------------------------------------------------------------------
// 3. Compare code keys vs Arabic bundle keys per namespace
// ---------------------------------------------------------------------------
for (const ns of allNamespaces) {
  const bundlePath = join(localesDir, `${ns}.json`);
  if (!existsSync(bundlePath)) {
    console.error(`\n[${ns}] ERROR: Missing bundle file at ${relative(root, bundlePath)}`);
    totalFailures += 1;
    continue;
  }

  let bundleData = {};
  try {
    const raw = readFileSync(bundlePath, "utf8");
    bundleData = JSON.parse(raw);
  } catch (err) {
    console.error(`\n[${ns}] ERROR: Failed to parse ${relative(root, bundlePath)}: ${err.message}`);
    totalFailures += 1;
    continue;
  }

  const bundleKeys = new Set(flattenKeys(bundleData));
  const codeKeys = codeKeysByNs.get(ns) || new Set();

  const missing = [...codeKeys].filter((k) => !bundleKeys.has(k)).sort();
  const orphans = [...bundleKeys].filter((k) => !codeKeys.has(k)).sort();

  if (missing.length > 0 || orphans.length > 0) {
    console.error(`\n[${ns}] FAILED:`);
    if (missing.length > 0) {
      console.error(`  MISSING keys in Arabic bundle (${missing.length}):`);
      for (const k of missing) {
        console.error(`    - ${k}`);
      }
      totalFailures += missing.length;
    }
    if (orphans.length > 0) {
      console.error(`  ORPHAN keys in Arabic bundle (${orphans.length}):`);
      for (const k of orphans) {
        console.error(`    - ${k}`);
      }
      totalFailures += orphans.length;
    }
  } else {
    console.log(`  OK [${ns}]: ${codeKeys.size} key(s) verified (0 missing, 0 orphans)`);
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log("");
if (totalFailures > 0) {
  console.error(`FAILED: ${totalFailures} i18n coverage issue(s) found.`);
  process.exit(1);
}

console.log("OK: all translation keys verified across all namespaces.");
process.exit(0);
