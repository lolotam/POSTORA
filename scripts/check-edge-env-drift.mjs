#!/usr/bin/env node
// Postora — Edge Runtime env drift detector (CI / pre-deploy gate).
//
// Three-way consistency check that prevents future regressions:
//   1. CODE  -> MANIFEST: every variable referenced via Deno.env.get("X") in
//      supabase/functions is declared in infra/edge-runtime.required-env.json.
//   2. MANIFEST -> .env.example: every manifest variable has a placeholder in
//      .env.example.
//   3. COMPOSE INJECTION: the functions service in docker-compose.yml uses
//      `env_file:` OR explicitly maps variables (so the .env actually reaches
//      the container).
//
// Exits non-zero on any drift. Runs as `npm run check:edge-env`.
// Never reads or prints secret values.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

let failures = 0;
const report = (msg) => console.error(`  DRIFT: ${msg}`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function readText(p) {
  return readFileSync(p, "utf8");
}

function listTsFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === ".git") continue;
      listTsFiles(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Load manifest
// ---------------------------------------------------------------------------
const manifestPath = join(root, "infra/edge-runtime.required-env.json");
let manifest;
try {
  manifest = JSON.parse(readText(manifestPath));
} catch (err) {
  console.error(`FATAL: cannot read manifest ${manifestPath}: ${err.message}`);
  process.exit(2);
}
const manifestNames = new Set(manifest.variables.map((v) => v.name));
const manifestAliasNames = new Set(
  manifest.variables.flatMap((v) => v.aliases || []),
);
const manifestAllNames = new Set([...manifestNames, ...manifestAliasNames]);

// ---------------------------------------------------------------------------
// 2. CODE -> MANIFEST
// ---------------------------------------------------------------------------
console.log("\n[1/3] CODE -> MANIFEST");
const functionsDir = join(root, "supabase", "functions");
const tsFiles = listTsFiles(functionsDir);
const codeVarRe = /Deno\.env\.get\(\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\)/g;
const codeVars = new Set();
for (const file of tsFiles) {
  const src = readText(file);
  let m;
  while ((m = codeVarRe.exec(src)) !== null) {
    codeVars.add(m[1]);
  }
}

// Known false positives that are test/debug-only and intentionally excluded
// from the runtime manifest. New additions here require a comment.
const ignoredCodeVars = new Set([
  "CALLER_JWT", // local integration test fixture
  "FOREIGN_ACCOUNT_ID", // test fixture id
  "OWNED_ACCOUNT_ID", // test fixture id
  "LOCATION_DEBUG_MODE", // debug-only flag
  "OPENAIAPIKEY", // legacy misspelled alias, handled separately
  "SB_MANAGEMENT_TOKEN", // alias of SUPABASE_MANAGEMENT_API (cloud-only, optional)
  "SUPABASE_MANAGEMENT_API", // cloud management token, optional
]);

for (const v of codeVars) {
  if (ignoredCodeVars.has(v)) continue;
  if (!manifestAllNames.has(v)) {
    report(`Deno.env.get("${v}") used in code but missing from manifest — add it to infra/edge-runtime.required-env.json`);
    failures += 1;
  }
}
if (failures === 0) console.log("  OK — all code env references are in the manifest.");

// ---------------------------------------------------------------------------
// 3. MANIFEST -> .env.example
// ---------------------------------------------------------------------------
console.log("\n[2/3] MANIFEST -> .env.example");
const envExamplePath = join(root, ".env.example");
const envExample = readText(envExamplePath);
const envExampleNames = new Set();
for (const line of envExample.split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq > 0) envExampleNames.add(t.slice(0, eq).trim());
}

for (const v of manifest.variables) {
  const has = envExampleNames.has(v.name) || (v.aliases || []).some((a) => envExampleNames.has(a));
  if (!has) {
    report(`"${v.name}" is in the manifest but missing from .env.example`);
    failures += 1;
  }
}
if (failures === 0) console.log("  OK — all manifest variables have a .env.example placeholder.");

// ---------------------------------------------------------------------------
// 4. COMPOSE INJECTION
// ---------------------------------------------------------------------------
console.log("\n[3/3] COMPOSE INJECTION");

// Try every candidate; prefer whichever actually contains a functions service.
const composeCandidates = [
  { path: join(root, "docker-compose.yml"), label: "docker-compose.yml" },
  { path: join(root, "docker-compose.supabase.yml"), label: "docker-compose.supabase.yml" },
];
const snippetCandidate = {
  path: join(root, "infra", "supabase-edge-functions.env.yml"),
  label: "infra/supabase-edge-functions.env.yml (reference snippet)",
};

let composePath = null;
let composeLabel = null;
let compose = "";
let fnBlock = "";

for (const c of composeCandidates) {
  let text;
  try {
    text = readFileSync(c.path, "utf8");
  } catch {
    continue;
  }
  const start = text.search(/^  functions:\s*$/m);
  if (start < 0) continue; // no functions service — keep looking
  composePath = c.path;
  composeLabel = c.label;
  compose = text;
  const after = text.slice(start);
  const nextSvc = after.slice(1).search(/^  [a-zA-Z][a-zA-Z0-9_-]*:\s*$/m);
  fnBlock = nextSvc >= 0 ? after.slice(0, nextSvc + 1) : after;
  break;
}

// Fall back to the reference snippet (whole file is the functions block).
if (!fnBlock) {
  try {
    compose = readFileSync(snippetCandidate.path, "utf8");
    composePath = snippetCandidate.path;
    composeLabel = snippetCandidate.label;
    fnBlock = compose;
  } catch {
    // no snippet either
  }
}

if (!fnBlock) {
  report("no docker-compose.yml or reference snippet found to validate functions injection.");
  failures += 1;
} else {
  const hasEnvFile = /^\s*env_file:\s*$/m.test(fnBlock) || /^\s*env_file:\s*\S/m.test(fnBlock);
  const mappedCount = (fnBlock.match(/^\s{6,}[A-Z_][A-Z0-9_]*:\s*\$\{/gm) || []).length;
  if (hasEnvFile) {
    console.log(`  OK — functions service (${composeLabel}) uses env_file (all .env vars injected automatically).`);
  } else if (mappedCount >= manifest.variables.filter((v) => v.required).length) {
    console.log(`  OK — functions service (${composeLabel}) explicitly maps ${mappedCount} variables via environment:.`);
    console.log("       NOTE: explicit mapping requires updating compose for every new variable.");
  } else {
    report(
      `functions service in ${composeLabel} has neither env_file: nor enough explicit environment: mappings — ` +
        "secrets in .env will NOT reach the container. Add `env_file: [./.env]` under functions.",
    );
    failures += 1;
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log("");
if (failures > 0) {
  console.error(`FAILED: ${failures} env-drift issue(s) found. Fix before deploying.`);
  process.exit(1);
}
console.log("OK: no env drift detected.");
process.exit(0);
