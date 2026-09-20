#!/usr/bin/env node
// Postora — Arabic i18n coverage gate.
//
// Three-way consistency check between the call sites, the i18next registration
// and the Arabic bundles:
//   1. REGISTRATION: every namespace a component asks for via useTranslation is
//      listed in the `ns` array in src/i18n/index.ts. An unregistered namespace
//      does not throw — i18next silently falls through to the call-site English
//      default, so the page still renders and the bug is invisible.
//   2. CODE -> BUNDLE: every key used in code exists in src/i18n/locales/ar/<ns>.json.
//   3. BUNDLE -> CODE: every key in a bundle is still used somewhere (no orphans
//      left behind by a deleted component).
//
// Exits non-zero on any drift. Runs as `npm run check:i18n`.
//
// Namespace resolution mirrors i18next's own rules, because the failure this
// gate exists to catch is silent:
//   useTranslation("nav")            -> nav
//   useTranslation(["nav", "media"]) -> both
//   useTranslation()                 -> whatever defaultNS is set to in index.ts
//   t("common:save")                 -> common, regardless of the file's namespace
// `keyPrefix` is rejected rather than guessed at: it rewrites every key in the
// file, and a gate that silently mis-attributes keys is worse than no gate.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

let failures = 0;
const report = (msg) => {
  console.error(`  ${msg}`);
  failures += 1;
};

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
    if (relative(root, full).includes("__tests__")) continue;
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
  const keys = [];
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

const quotedStrings = (source) => [...source.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);

// ---------------------------------------------------------------------------
// 1. Read the i18next registration so the gate cannot drift from the config
// ---------------------------------------------------------------------------
const configPath = join(root, "src", "i18n", "index.ts");
const config = readFileSync(configPath, "utf8");

const defaultNsMatch = config.match(/defaultNS:\s*["']([^"']+)["']/);
if (!defaultNsMatch) {
  console.error(`\nERROR: could not find defaultNS in ${relative(root, configPath)}.`);
  process.exit(1);
}
const defaultNs = defaultNsMatch[1];

const nsArrayMatch = config.match(/\bns:\s*\[([^\]]*)\]/);
if (!nsArrayMatch) {
  console.error(`\nERROR: could not find the ns array in ${relative(root, configPath)}.`);
  process.exit(1);
}
const registeredNamespaces = new Set(quotedStrings(nsArrayMatch[1]));

// ---------------------------------------------------------------------------
// 2. Walk code files and attribute every key to a namespace
// ---------------------------------------------------------------------------
const sourceFiles = listSourceFiles(join(root, "src"));

const codeKeysByNs = new Map();
const addKey = (ns, key) => {
  if (!codeKeysByNs.has(ns)) codeKeysByNs.set(ns, new Set());
  codeKeysByNs.get(ns).add(key);
};

// `t("key")`, `i18next.t("key")`, and <Trans i18nKey="key"> all reach the bundle.
const tCallRegex = /\bt\(\s*["']([a-zA-Z0-9_.:-]+)["']/g;
const transKeyRegex = /\bi18nKey=["']([a-zA-Z0-9_.:-]+)["']/g;
const useTranslationRegex = /useTranslation\(([^)]*)\)/g;

for (const file of sourceFiles) {
  const content = readFileSync(file, "utf8");
  const calls = [...content.matchAll(useTranslationRegex)];
  if (calls.length === 0) continue;

  const rel = relative(root, file);

  const fileNamespaces = new Set();
  for (const [, args] of calls) {
    if (args.includes("keyPrefix")) {
      report(
        `UNSUPPORTED: ${rel} uses useTranslation({ keyPrefix }), which rewrites every key in the ` +
          `file. This gate cannot verify it — pass full key paths instead.`
      );
      continue;
    }
    const explicit = quotedStrings(args);
    if (explicit.length === 0) fileNamespaces.add(defaultNs);
    for (const ns of explicit) fileNamespaces.add(ns);
  }
  if (fileNamespaces.size === 0) continue;

  for (const ns of fileNamespaces) {
    if (!registeredNamespaces.has(ns)) {
      report(
        `UNREGISTERED: ${rel} asks for namespace "${ns}", which is missing from the ns array in ` +
          `${relative(root, configPath)}. i18next will silently serve the English call-site default.`
      );
    }
  }

  const keys = [
    ...[...content.matchAll(tCallRegex)].map((m) => m[1]),
    ...[...content.matchAll(transKeyRegex)].map((m) => m[1]),
  ];

  for (const key of keys) {
    // An explicit "ns:key" prefix wins over the file's own namespace — that is
    // how i18next resolves it, and it is the only way a file reading two
    // namespaces can be attributed precisely.
    const separator = key.indexOf(":");
    if (separator > 0) {
      addKey(key.slice(0, separator), key.slice(separator + 1));
      continue;
    }
    for (const ns of fileNamespaces) addKey(ns, key);
  }
}

// ---------------------------------------------------------------------------
// 3. Compare code keys against the Arabic bundles
// ---------------------------------------------------------------------------
const localesDir = join(root, "src", "i18n", "locales", "ar");
const namespaces = new Set(codeKeysByNs.keys());

if (existsSync(localesDir)) {
  for (const entry of readdirSync(localesDir)) {
    if (entry.endsWith(".json")) namespaces.add(entry.slice(0, -5));
  }
}

console.log("\nChecking Arabic (ar) i18n bundle coverage...");
console.log(`  defaultNS: ${defaultNs} · registered: ${[...registeredNamespaces].sort().join(", ")}`);

for (const ns of [...namespaces].sort()) {
  const bundlePath = join(localesDir, `${ns}.json`);
  if (!existsSync(bundlePath)) {
    report(`[${ns}] MISSING BUNDLE: expected ${relative(root, bundlePath)}`);
    continue;
  }

  let bundle;
  try {
    bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
  } catch (err) {
    report(`[${ns}] UNPARSEABLE: ${relative(root, bundlePath)}: ${err.message}`);
    continue;
  }

  const bundleKeys = new Set(flattenKeys(bundle));
  const codeKeys = codeKeysByNs.get(ns) ?? new Set();

  const missing = [...codeKeys].filter((k) => !bundleKeys.has(k)).sort();
  const orphans = [...bundleKeys].filter((k) => !codeKeys.has(k)).sort();

  if (missing.length === 0 && orphans.length === 0) {
    console.log(`  OK [${ns}]: ${codeKeys.size} key(s) verified`);
    continue;
  }

  console.error(`\n  [${ns}] FAILED:`);
  if (missing.length > 0) {
    console.error(`    MISSING from the Arabic bundle (${missing.length}):`);
    for (const k of missing) console.error(`      - ${k}`);
    failures += missing.length;
  }
  if (orphans.length > 0) {
    console.error(`    ORPHANED in the Arabic bundle (${orphans.length}):`);
    for (const k of orphans) console.error(`      - ${k}`);
    failures += orphans.length;
  }
}

console.log("");
if (failures > 0) {
  console.error(`FAILED: ${failures} i18n coverage issue(s) found.`);
  process.exit(1);
}

console.log("OK: all translation keys verified across all namespaces.");
