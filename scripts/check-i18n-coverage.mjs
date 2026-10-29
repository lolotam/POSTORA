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

// STRUCTURED_OUTPUT_REGION
// Machine-readable callsites for the no-regression comparator.
// This block does not change the set-based exit count above: `failures`
// is already final, and nothing here calls `report()`.

function resolveStructuredJsonArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--json") continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("-")) {
      console.error("ERROR: --json requires a file path.");
      process.exit(1);
    }
    return value;
  }
  return null;
}

function structuredPosition(content, index) {
  let line = 1;
  let column = 1;
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function structuredPosix(absPath) {
  return relative(root, absPath).split("\\").join("/");
}

function cloneStructuredRegex(re) {
  return new RegExp(re.source, re.flags);
}

// Line of each leaf key path. Returns null when the bundle is not uniquely located.
function jsonLeafLines(text) {
  let i = 0;
  let line = 1;
  const found = new Map();

  function bump(ch) {
    if (ch === "\n") line += 1;
  }
  function skipWs() {
    while (i < text.length && " \t\r\n".includes(text[i])) {
      bump(text[i]);
      i += 1;
    }
  }
  function parseString() {
    if (text[i] !== '"') return undefined;
    bump(text[i]);
    i += 1;
    let value = "";
    while (i < text.length) {
      const ch = text[i];
      bump(ch);
      i += 1;
      if (ch === "\\") {
        if (i >= text.length) return undefined;
        const escaped = text[i];
        bump(escaped);
        i += 1;
        value += escaped;
        continue;
      }
      if (ch === '"') return value;
      value += ch;
    }
    return undefined;
  }
  function skipAny() {
    skipWs();
    if (i >= text.length) return false;
    const ch = text[i];
    if (ch === "{") return skipObject();
    if (ch === "[") return skipArray();
    if (ch === '"') return parseString() !== undefined;
    if ("-0123456789tfn".includes(ch)) {
      while (i < text.length && !",]}".includes(text[i]) && !" \t\r\n".includes(text[i])) i += 1;
      return true;
    }
    return false;
  }
  function skipArray() {
    if (text[i] !== "[") return false;
    bump(text[i]);
    i += 1;
    skipWs();
    if (text[i] === "]") {
      bump(text[i]);
      i += 1;
      return true;
    }
    while (i < text.length) {
      if (!skipAny()) return false;
      skipWs();
      if (text[i] === ",") {
        bump(text[i]);
        i += 1;
        continue;
      }
      if (text[i] === "]") {
        bump(text[i]);
        i += 1;
        return true;
      }
      return false;
    }
    return false;
  }
  function skipObject() {
    if (text[i] !== "{") return false;
    bump(text[i]);
    i += 1;
    skipWs();
    if (text[i] === "}") {
      bump(text[i]);
      i += 1;
      return true;
    }
    while (i < text.length) {
      skipWs();
      if (parseString() === undefined) return false;
      skipWs();
      if (text[i] !== ":") return false;
      bump(text[i]);
      i += 1;
      if (!skipAny()) return false;
      skipWs();
      if (text[i] === ",") {
        bump(text[i]);
        i += 1;
        continue;
      }
      if (text[i] === "}") {
        bump(text[i]);
        i += 1;
        return true;
      }
      return false;
    }
    return false;
  }
  function record(keyPath, keyLine) {
    if (!found.has(keyPath)) found.set(keyPath, []);
    found.get(keyPath).push(keyLine);
  }
  function parseObject(prefix) {
    if (text[i] !== "{") return false;
    bump(text[i]);
    i += 1;
    skipWs();
    if (text[i] === "}") {
      bump(text[i]);
      i += 1;
      return true;
    }
    while (i < text.length) {
      skipWs();
      const keyLine = line;
      const key = parseString();
      if (key === undefined) return false;
      skipWs();
      if (text[i] !== ":") return false;
      bump(text[i]);
      i += 1;
      const keyPath = prefix ? `${prefix}.${key}` : key;
      skipWs();
      if (text[i] === "{") {
        if (!parseObject(keyPath)) return false;
      } else if (text[i] === "[") {
        record(keyPath, keyLine);
        if (!skipArray()) return false;
      } else if (text[i] === '"') {
        record(keyPath, keyLine);
        if (parseString() === undefined) return false;
      } else if (i < text.length && "-0123456789tfn".includes(text[i])) {
        record(keyPath, keyLine);
        while (i < text.length && !",]}".includes(text[i]) && !" \t\r\n".includes(text[i])) i += 1;
      } else {
        return false;
      }
      skipWs();
      if (text[i] === ",") {
        bump(text[i]);
        i += 1;
        continue;
      }
      if (text[i] === "}") {
        bump(text[i]);
        i += 1;
        return true;
      }
      return false;
    }
    return false;
  }

  skipWs();
  if (!parseObject("")) return null;
  skipWs();
  if (i !== text.length) return null;
  return found;
}

function uniqueLeafLine(leafLines, key) {
  if (!leafLines) return null;
  const lines = leafLines.get(key);
  if (!lines || lines.length !== 1) return null;
  return lines[0];
}

function pushStructured(findings, finding) {
  findings.push({
    category: finding.category,
    locale: "ar",
    namespace: finding.namespace ?? null,
    key: finding.key ?? null,
    path: finding.path,
    line: finding.line ?? null,
    column: finding.column ?? null,
    anchor: finding.anchor,
  });
}

function collectStructuredI18nFindings() {
  const findings = [];
  const useTranslationRe = cloneStructuredRegex(useTranslationRegex);
  const callRe = cloneStructuredRegex(tCallRegex);
  const transRe = cloneStructuredRegex(transKeyRegex);
  const bundleKeys = new Map();
  const bundleLines = new Map();
  const bundleProblems = new Map();

  if (existsSync(localesDir)) {
    for (const entry of readdirSync(localesDir)) {
      if (!entry.endsWith(".json")) continue;
      const ns = entry.slice(0, -5);
      const bundlePath = join(localesDir, entry);
      let parsed;
      try {
        const text = readFileSync(bundlePath, "utf8");
        parsed = JSON.parse(text);
        bundleLines.set(ns, jsonLeafLines(text));
      } catch (err) {
        bundleProblems.set(ns, {
          category: "UNPARSEABLE",
          path: structuredPosix(bundlePath),
          anchor: err.message,
        });
        continue;
      }
      bundleKeys.set(ns, new Set(flattenKeys(parsed)));
    }
  }

  for (const file of sourceFiles) {
    const content = readFileSync(file, "utf8");
    const calls = [...content.matchAll(useTranslationRe)];
    if (calls.length === 0) continue;
    const rel = structuredPosix(file);
    const fileNamespaces = new Set();

    for (const call of calls) {
      const args = call[1];
      const at = structuredPosition(content, call.index);
      if (args.includes("keyPrefix")) {
        pushStructured(findings, {
          category: "UNSUPPORTED",
          namespace: null,
          key: null,
          path: rel,
          line: at.line,
          column: at.column,
          anchor: call[0],
        });
        continue;
      }
      const explicit = quotedStrings(args);
      const mentioned = explicit.length === 0 ? [defaultNs] : explicit;
      for (const ns of mentioned) {
        fileNamespaces.add(ns);
        if (!registeredNamespaces.has(ns)) {
          pushStructured(findings, {
            category: "UNREGISTERED",
            namespace: ns,
            key: null,
            path: rel,
            line: at.line,
            column: at.column,
            anchor: call[0],
          });
        }
      }
    }
    if (fileNamespaces.size === 0) continue;

    const keyMatches = [
      ...content.matchAll(callRe),
      ...content.matchAll(transRe),
    ];
    for (const match of keyMatches) {
      const rawKey = match[1];
      const at = structuredPosition(content, match.index);
      const separator = rawKey.indexOf(":");
      const targets = [];
      if (separator > 0) {
        targets.push({ ns: rawKey.slice(0, separator), key: rawKey.slice(separator + 1) });
      } else {
        for (const ns of fileNamespaces) targets.push({ ns, key: rawKey });
      }
      for (const target of targets) {
        if (bundleProblems.has(target.ns)) continue;
        if (!bundleKeys.has(target.ns)) continue;
        if (bundleKeys.get(target.ns).has(target.key)) continue;
        pushStructured(findings, {
          category: "MISSING",
          namespace: target.ns,
          key: target.key,
          path: rel,
          line: at.line,
          column: at.column,
          anchor: match[0],
        });
      }
    }
  }

  const structuredNamespaces = new Set(codeKeysByNs.keys());
  if (existsSync(localesDir)) {
    for (const entry of readdirSync(localesDir)) {
      if (entry.endsWith(".json")) structuredNamespaces.add(entry.slice(0, -5));
    }
  }
  for (const ns of structuredNamespaces) {
    const bundlePath = join(localesDir, `${ns}.json`);
    if (!existsSync(bundlePath)) {
      pushStructured(findings, {
        category: "MISSING_BUNDLE",
        namespace: ns,
        key: null,
        path: structuredPosix(bundlePath),
        line: null,
        column: null,
        anchor: "MISSING_BUNDLE",
      });
      continue;
    }
    const problem = bundleProblems.get(ns);
    if (problem) {
      pushStructured(findings, {
        category: "UNPARSEABLE",
        namespace: ns,
        key: null,
        path: problem.path,
        line: null,
        column: null,
        anchor: problem.anchor,
      });
      continue;
    }
    const present = bundleKeys.get(ns) ?? new Set();
    const used = codeKeysByNs.get(ns) ?? new Set();
    const leafLines = bundleLines.get(ns) ?? null;
    for (const key of [...present].filter((item) => !used.has(item)).sort()) {
      pushStructured(findings, {
        category: "ORPHAN",
        namespace: ns,
        key,
        path: structuredPosix(bundlePath),
        line: uniqueLeafLine(leafLines, key),
        column: null,
        anchor: key,
      });
    }
  }

  return {
    version: 1,
    locale: "ar",
    defaultNS: defaultNs,
    failureCount: failures,
    registeredNamespaces: [...registeredNamespaces].sort(),
    findings,
  };
}

const structuredJsonPath = resolveStructuredJsonArg(process.argv.slice(2));
if (structuredJsonPath) {
  const { writeFileSync } = await import("node:fs");
  let structuredPayload;
  try {
    structuredPayload = collectStructuredI18nFindings();
  } catch (err) {
    console.error(`ERROR: i18n structured report failed: ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
  try {
    writeFileSync(structuredJsonPath, `${JSON.stringify(structuredPayload)}\n`, "utf8");
  } catch (err) {
    console.error(`ERROR: could not write i18n structured report: ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
}
// END_STRUCTURED_OUTPUT_REGION
console.log("");
if (failures > 0) {
  console.error(`FAILED: ${failures} i18n coverage issue(s) found.`);
  process.exit(1);
}

console.log("OK: all translation keys verified across all namespaces.");
