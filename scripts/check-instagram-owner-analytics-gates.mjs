#!/usr/bin/env node
// Owner-only artifact inventory. This does not evaluate canonical Task 11 G-X.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const OWNER_RUNTIME_ROOTS = [
  "supabase/functions/instagram-insights-report/index.ts",
  "supabase/functions/instagram-insights-sync/index.ts",
  "supabase/functions/n8n-api/index.ts",
  "supabase/functions/mcp/index.ts",
];
const FRONTEND_PATHS = [
  "src/features/instagram-insights", "src/pages/analytics/InstagramAnalytics.tsx",
  "src/i18n/locales/ar/analytics.json", "src/integrations/supabase/types.ts",
  "supabase/config.toml", "package.json", "package-lock.json", ".github/workflows/ci.yml",
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

function importSpecifiers(source, path) {
  const syntax = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  if (syntax.parseDiagnostics.length) throw new Error(`Unparseable runtime module: ${path}`);
  const imports = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) {
        throw new Error(`Unresolved dynamic import in ${path}`);
      }
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(syntax);
  return imports;
}

export function inventoryOwnerCandidate(root, revision) {
  const candidate = git(root, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]).toString().trim();
  const tree = git(root, ["rev-parse", `${candidate}^{tree}`]).toString().trim();
  const files = new Map();
  const externalImports = new Set();
  const pending = [...OWNER_RUNTIME_ROOTS];
  while (pending.length) {
    const path = pending.pop();
    if (files.has(path)) continue;
    if (!path.startsWith("supabase/functions/") || /(?:\.test\.|TestSupport\.)/.test(path)) {
      throw new Error(`Invalid runtime dependency: ${path}`);
    }
    const bytes = git(root, ["show", `${candidate}:${path}`]);
    files.set(path, { path, sha256: digest(bytes) });
    for (const specifier of importSpecifiers(bytes.toString("utf8"), path)) {
      if (specifier.startsWith(".")) {
        pending.push(posix.normalize(posix.join(posix.dirname(path), specifier)));
      } else if (/^(https:\/\/|npm:|node:)/.test(specifier)) {
        externalImports.add(specifier);
      } else {
        throw new Error(`Unresolved import ${specifier} in ${path}`);
      }
    }
  }
  const frontendFiles = git(root, ["ls-tree", "-r", "--name-only", candidate, "--", ...FRONTEND_PATHS])
    .toString().trim().split("\n").filter(Boolean);
  for (const path of FRONTEND_PATHS) {
    if (!frontendFiles.some((file) => file === path || file.startsWith(`${path}/`))) {
      throw new Error(`Missing required frontend/config path: ${path}`);
    }
  }
  return {
    formatVersion: 1,
    scope: "instagram-owner-analytics-artifact-inventory",
    candidate, tree,
    runtimeRoots: OWNER_RUNTIME_ROOTS,
    runtimeFiles: [...files.values()].sort((a, b) => a.path.localeCompare(b.path, "en")),
    frontendAndConfigFiles: frontendFiles.sort().map((path) => ({ path, sha256: digest(git(root, ["show", `${candidate}:${path}`])) })),
    externalImports: [...externalImports].sort(),
    canonicalTask11GX: "not_evaluated",
    releaseReady: false,
    pendingEvidence: [
      "Executed owner SQL/Auth/browser/worker-to-report journeys and API/MCP parity",
      "Resolved external module versions/configuration and full deployment/schema preflight",
      "Canonical release prerequisites or explicit owner-approved scope amendment",
      "Separate deployment, named-pilot, collection/schedule and restoration approvals",
      "Live Meta reconciliation and seven timely scheduled due-date receipts",
    ],
  };
}

function main(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    if (!["--candidate", "--out", "--verify"].includes(args[index]) || !args[index + 1] || options.has(args[index])) {
      throw new Error("Usage: --candidate <revision> --out <manifest.json>, or --verify <manifest.json>");
    }
    options.set(args[index], args[index + 1]);
  }
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).toString().trim();
  if (options.has("--verify")) {
    if (options.size !== 1) throw new Error("--verify cannot be combined with other options");
    const recorded = JSON.parse(readFileSync(resolve(options.get("--verify")), "utf8"));
    const actual = inventoryOwnerCandidate(root, recorded.candidate);
    if (JSON.stringify(actual) !== JSON.stringify(recorded)) throw new Error("Owner artifact manifest does not match its immutable candidate");
    console.log("Owner artifact hashes verified. Release readiness remains false; canonical G-X not evaluated.");
    return;
  }
  if (!options.has("--candidate") || !options.has("--out")) throw new Error("--candidate and --out are required");
  const manifest = inventoryOwnerCandidate(root, options.get("--candidate"));
  const output = resolve(options.get("--out"));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Owner artifact inventory: ${manifest.candidate}, ${manifest.runtimeFiles.length} runtime files. Release readiness false; canonical G-X not evaluated.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
