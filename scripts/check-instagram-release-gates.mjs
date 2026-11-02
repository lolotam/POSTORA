#!/usr/bin/env node
// Task 11 validates retained evidence; it never executes candidate code or authorizes production work.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { parseDocument } from "yaml";
import { z } from "zod";
import { inventoryOwnerCandidate } from "./check-instagram-owner-analytics-gates.mjs";

const SOURCE_SPEC = "docs/specs/2026-10-26-instagram-insights-and-competitor-tracking.md";
const TASK8_SPEC = "docs/specs/2026-10-30-competitor-ui-and-retention.md";
const DEFAULT_SPEC = "docs/specs/2026-10-30-instagram-release-gates.md";
const WORKFLOW = ".github/workflows/instagram-migration-gate.yml";
const CHECKER = "scripts/check-instagram-release-gates.mjs";
const BASELINE = "supabase/tests/baseline_schema.sql";
const SERIES = {
  R1: "_instagram_collection_rollout_controls.sql",
  R2: "_instagram_collection_daily_dispatch.sql",
  C1: "_instagram_collection_cron.sql",
};
const INVENTORY_STATUSES = ["existing", "to-be-written", "blocked-on-dependency"];
const REQUIRED_FILES = [
  CHECKER, "scripts/check-instagram-release-gates.test.mjs",
  "scripts/check-instagram-owner-analytics-gates.mjs", WORKFLOW, ".github/CODEOWNERS",
  "docs/plans/2026-10-30-instagram-release-gates.md",
  "docs/specs/2026-10-30-instagram-collection-rollout-controls.md",
  "docs/plans/2026-10-30-instagram-collection-rollout-controls.md",
  "e2e/fixtures/instagramRelease.ts", "e2e/fixtures/instagramReleaseSeed.ts",
  "e2e/fixtures/instagramReleaseServer.ts", "e2e/fixtures/instagramReleaseSafety.test.ts",
  "e2e/fixtures/competitorTracking.ts", "e2e/analytics.spec.ts", "playwright.instagram-release.config.ts",
  "supabase/functions/brand-scrape/releaseContract.test.ts",
  "supabase/functions/n8n-api/instagramReleaseContract.test.ts",
  "docs/journeys/2026-10-26-instagram-insights-and-competitor-tracking.md",
  "docs/runbooks/instagram-insights-release.md", "docs/runbooks/competitor-tracking-retention.md",
  "supabase/tests/README.md", "scripts/db-harness.sh", BASELINE,
  "supabase/config.toml", "src/integrations/supabase/types.ts",
];
const REQUIRED_DEPENDENCIES = ["Task 2", "Task 6", "Task 8", "Task 9", "Task 10", "collection rollout controls", "D8/A6/I3 decision"];
const REQUIRED_REVIEWS = ["architecture", "clean-code-guard", "test-guard", "docs-guard", "independent review", "negative control", "rollback"];
const APPROVAL_ACTIONS = ["B1", "B2", "B3", "C1", "C2", "C3", "D1", "D2", "D3", "E1", "E2", "E3-dry-run", "E3-enable", "E4"];
const sha = z.string().regex(/^[a-f0-9]{40}$/).refine((hash) => !/^0+$/.test(hash));
const nonempty = z.string().trim().min(1);
const fileHash = z.object({ path: nonempty, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const receipt = z.object({ artifact: fileHash, reviewer: nonempty }).strict();
const testIdentity = z.object({ file: nonempty, title: nonempty, project: nonempty.optional() }).strict();
const proofSchema = z.object({
  id: nonempty, candidate: sha, tree: sha, testTitle: nonempty, source: fileHash,
  command: nonempty, version: nonempty, exit: z.number().int(),
  status: z.enum(["passed", "failed", "skipped", "flaky", "blocked"]),
  environment: z.enum(["local", "hosted", "live"]), reviewer: nonempty, artifact: fileHash,
  skipped: z.number().int().nonnegative(), flaky: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(), attempts: z.number().int().positive(),
  reporter: z.enum(["receipt", "playwright"]), project: nonempty.optional(),
}).strict();
const executionReceiptSchema = proofSchema.omit({ artifact: true, reporter: true }).extend({
  formatVersion: z.literal(1), scope: z.literal("instagram-release-execution"),
}).strict();
const snapshotSchema = z.object({ commit: sha, newestVersion: z.string().regex(/^\d{14}$/), marker: z.string().regex(/^\d{14}$/) }).strict();

// These names follow spec §2. Execution status is deliberately separate from Markdown inventory status.
const ledgerSchema = z.object({
  formatVersion: z.literal(1), scope: z.literal("instagram-task11-release-gates"),
  baseline: sha, candidate: sha, tree: sha,
  inventoryReview: receipt,
  acceptance: z.array(z.object({
    id: nonempty, inventoryStatus: z.enum(INVENTORY_STATUSES), requiredTests: z.array(testIdentity).min(1),
    proofIds: z.array(nonempty), blocker: nonempty.nullable(), resolution: receipt.optional(),
  }).strict()),
  proofs: z.array(proofSchema), artifacts: z.array(fileHash),
  runtimeCallers: z.array(z.object({
    entrypoint: nonempty, steps: z.array(z.object({ caller: nonempty, line: z.number().int().positive(), callee: nonempty, symbol: nonempty }).strict()).min(1),
    artifact: fileHash, reviewer: nonempty,
  }).strict()),
  migrationSnapshots: z.object({ R1: snapshotSchema.optional(), R2: snapshotSchema.optional(), C1: snapshotSchema.optional() }).strict(),
  dependencies: z.array(z.object({ name: nonempty, status: z.enum(["resolved", "pending", "failed"]), artifact: fileHash.optional(), reviewer: nonempty.optional() }).strict()),
  reviews: z.array(z.object({ name: nonempty, status: z.enum(["passed", "pending", "failed"]), artifact: fileHash, reviewer: nonempty, version: nonempty, scope: nonempty }).strict()),
  hosted: z.object({ proofIds: z.array(nonempty) }).strict(),
  bootstrap: z.object({
    artifact: fileHash, reviewer: nonempty,
    branchProtection: z.object({ upToDate: z.boolean(), requiredContext: nonempty, expectedAppId: nonempty, squashOnly: z.boolean(), codeOwnerReview: z.boolean(), administratorBypass: z.boolean(), dismissStale: z.boolean() }).strict(),
    app: z.object({ id: nonempty, context: nonempty, statusesWriteOnly: z.boolean(), privateKeySecret: nonempty }).strict(),
    environment: z.object({ name: nonempty, defaultBranchOnly: z.boolean() }).strict(),
    publicRepository: z.boolean(), eventPolicy: z.object({ workflow: nonempty, pullRequestTargetAllowed: z.boolean() }).strict(),
  }).strict().optional(),
  live: z.object({
    status: z.enum(["pending", "passed"]),
    approvals: z.array(z.object({
      action: nonempty, candidate: sha, tree: sha, reference: nonempty, approver: z.literal("Waleed"),
      timestamp: z.string().datetime({ offset: true }), operator: nonempty, configuration: nonempty,
      accounts: z.array(nonempty).min(1), proofIds: z.array(nonempty).min(1), artifact: fileHash,
    }).strict()),
  }).strict(),
}).strict();

class GateError extends Error {
  constructor(code, detail) { super(`${code}: ${detail}`); this.code = code; this.detail = detail; }
}

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const gap = (code, detail) => ({ code, detail });
const isTest = (path) => /(?:\.test\.|\.spec\.|TestSupport\.|\/__tests__\/)/.test(path);
const immutableObjects = new Map();

function objectCache(root) {
  if (!immutableObjects.has(root)) immutableObjects.set(root, { trees: new Map(), blobs: new Map(), owners: new Map() });
  return immutableObjects.get(root);
}

function git(root, args, code = "history_read_failed") {
  const command = spawnSync("git", ["-C", root, ...args], { maxBuffer: 128 * 1024 * 1024, encoding: null });
  if (command.error || command.status !== 0) throw new GateError(code, `git ${args[0]} failed; restore complete reachable history`);
  if (/rename detection was skipped|rename detection.*skipped/i.test(command.stderr.toString())) {
    throw new GateError("history_scan_incomplete", "Git skipped rename detection");
  }
  return command.stdout;
}

function commitSha(root, revision, code) {
  if (!revision || revision.startsWith("-")) throw new GateError(code, "A commit reference is required");
  return git(root, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`], code).toString().trim();
}

function sourcePath(path) {
  if (typeof path !== "string" || path.includes("\\") || path.includes(":") || path.startsWith("/") || posix.normalize(path) !== path || path.startsWith("../")) {
    throw new GateError("source_path_invalid", "Expected a normalized repository-relative source path");
  }
  return path;
}

function trackedTree(root, revision) {
  const cache = objectCache(root).trees;
  if (/^[a-f0-9]{40}$/.test(revision) && cache.has(revision)) return cache.get(revision);
  const entries = git(root, ["ls-tree", "-r", "-z", revision]).toString().split("\0").filter(Boolean);
  const files = new Map(entries.map((entry) => {
    const [metadata, path] = entry.split("\t");
    const [mode, type, blob] = metadata.split(" ");
    return [path, { mode, type, blob }];
  }));
  if (/^[a-f0-9]{40}$/.test(revision)) cache.set(revision, files);
  return files;
}

function committedBytes(context, path, revision = context.candidate) {
  sourcePath(path);
  const entries = revision === context.candidate ? context.files : trackedTree(context.root, revision);
  const entry = entries.get(path);
  if (!entry || entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) {
    throw new GateError("required_source_missing", `${path} at ${revision}`);
  }
  const blobs = objectCache(context.root).blobs;
  if (!blobs.has(entry.blob)) blobs.set(entry.blob, git(context.root, ["cat-file", "blob", entry.blob], "assignment_commit_unreachable"));
  return blobs.get(entry.blob);
}

function section(markdown, heading, nextHeading) {
  const start = markdown.indexOf(heading);
  const end = markdown.indexOf(nextHeading, start + heading.length);
  if (start < 0 || end < 0) throw new GateError("contract_section_missing", heading);
  return markdown.slice(start, end);
}

function tableRows(markdown) {
  return markdown.split(/\r?\n/).filter((line) => /^\|/.test(line)).map((line) => line.slice(1, line.lastIndexOf("|")).split(/(?<!\\)\|/).map((cell) => cell.trim()));
}

function acceptanceIds(markdown, pattern) {
  return tableRows(markdown).map((cells) => cells[0].match(pattern)?.[1]).filter(Boolean);
}

function uniqueIds(ids, label) {
  if (new Set(ids).size !== ids.length) throw new GateError("acceptance_id_duplicate", label);
  return [...ids].sort();
}

function catalogue(context) {
  const markdown = committedBytes(context, context.spec).toString("utf8");
  const source = committedBytes(context, SOURCE_SPEC).toString("utf8");
  const task8 = committedBytes(context, TASK8_SPEC).toString("utf8");
  const sourceAcceptance = section(source, "## 8. Test plan", "## 10. Acceptance criteria");
  const original = uniqueIds([...acceptanceIds(sourceAcceptance, /^([DAIHSUEJ]\d+)$/),
    ...[...sourceAcceptance.matchAll(/^- \*\*(E\d+):\*\*/gm)].map((match) => match[1])], SOURCE_SPEC);
  const integrated = uniqueIds(acceptanceIds(section(task8, "## 10. Acceptance map", "## 11."), /^(T8-\d{2})(?: |$)/), TASK8_SPEC);
  const rows = tableRows(section(markdown, "## 3. Acceptance traceability matrix", "## 4.")).filter((cells) => /^(?:[DAIHSUEJ]\d+|T8-\d{2})$/.test(cells[0]));
  const actual = uniqueIds(rows.map((cells) => cells[0]), context.spec);
  if (original.length !== 66 || integrated.length !== 12 || JSON.stringify(actual) !== JSON.stringify([...original, ...integrated].sort())) {
    throw new GateError("acceptance_inventory_mismatch", `Canonical matrix/source tables disagree (${original.length} source, ${integrated.length} Task 8, ${rows.length} matrix rows)`);
  }
  return rows.map(([id, inventoryStatus, obligation]) => {
    if (!INVENTORY_STATUSES.includes(inventoryStatus)) throw new GateError("inventory_status_invalid", id);
    return { id, inventoryStatus, obligation, execution: "missing" };
  });
}

function migrationManifest(markdown) {
  const rows = tableRows(section(markdown, "### Ordered feature migrations", "### Function and module set"));
  const manifest = rows.filter((cells) => /^\d+(?: \/ \w+)?$/.test(cells[0])).map(([order, exact]) => {
    const match = exact.match(/(?:`)?(\d{14}|\*unassigned\*)(_[\w-]+\.sql)/);
    if (!match) throw new GateError("migration_manifest_invalid", order);
    return { order, member: order.match(/\/ (\w+)$/)?.[1], version: match[1], suffix: match[2], path: `supabase/migrations/${match[1]}${match[2]}` };
  });
  if (!manifest.length || new Set(manifest.map((row) => row.order)).size !== manifest.length) throw new GateError("migration_manifest_invalid", "Missing or duplicated ordered rows");
  return manifest;
}

function migrationFiles(files) {
  return [...files].filter(([path]) => /^supabase\/migrations\/\d{14}_[^/]+\.sql$/.test(path)).map(([path, entry]) => ({ path, version: posix.basename(path).slice(0, 14), blob: entry.blob }));
}

function changeEntries(tokens) {
  const changes = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++].trim();
    if (!status) continue;
    const path = tokens[index++];
    changes.push({ status: status[0], path, destination: /^[RC]/.test(status) ? tokens[index++] : undefined });
  }
  return changes;
}

function history(root, revision) {
  if (git(root, ["rev-parse", "--is-shallow-repository"]).toString().trim() !== "false") {
    throw new GateError("assignment_commit_unreachable", "Full Git history is required (fetch-depth: 0)");
  }
  return git(root, ["log", "--first-parent", "--reverse", "--format=%x1e%H%x00%P%x00", "--name-status", "-z", "-M", "-l0", revision])
    .toString().split("\x1e").filter(Boolean).map((record) => {
      const [commit, parents, ...tokens] = record.split("\0");
      return { commit, parents: parents.trim().split(" ").filter(Boolean), changes: changeEntries(tokens) };
    });
}

function snapshot(context, revision) {
  const files = trackedTree(context.root, revision);
  const versions = migrationFiles(files).map((file) => file.version).sort();
  const marker = committedBytes(context, BASELINE, revision).toString().match(/^-- BASELINE_MIGRATION: (\d{14})_[^\r\n]+/m)?.[1];
  if (!versions.length || !marker) throw new GateError("migration_snapshot_invalid", `Missing migration versions/baseline marker at ${revision}`);
  return { commit: revision, newestVersion: versions.at(-1), marker };
}

function checkMigrationOrder(context, manifest) {
  const assigned = manifest.filter((row) => row.version !== "*unassigned*");
  for (let index = 1; index < assigned.length; index++) {
    if (assigned[index - 1].version >= assigned[index].version) context.report.failures.push(gap("migration_order_invalid", `${assigned[index - 1].order} must sort before ${assigned[index].order}`));
  }
  const m4 = manifest.find((row) => row.member === "M4");
  for (const [member, suffix] of Object.entries(SERIES)) {
    const row = manifest.find((entry) => entry.member === member);
    if (!row || row.suffix !== suffix || !m4) throw new GateError("migration_manifest_invalid", `Missing or invalid ${member}/M4 manifest entry`);
    if (row.version !== "*unassigned*" && row.version <= m4.version) context.report.failures.push(gap("migration_order_invalid", `${member} must sort after M4`));
  }
}

function checkReservedVersions(context, trees) {
  const reserved = new Map();
  for (const [revision, files] of trees) {
    const migrations = migrationFiles(files);
    const versions = new Set();
    for (const migration of migrations) {
      if (versions.has(migration.version)) context.report.failures.push(gap("migration_version_collision", `${migration.version} at ${revision}`));
      versions.add(migration.version);
      const previous = reserved.get(migration.version);
      if (previous && (previous.path !== migration.path || previous.blob !== migration.blob)) context.report.failures.push(gap("migration_reserved_prefix_violation", `${migration.path} at ${revision}`));
      else if (!previous) reserved.set(migration.version, migration);
    }
    for (const original of reserved.values()) {
      if (files.get(original.path)?.blob !== original.blob) context.report.failures.push(gap("migration_reserved_prefix_violation", `${original.path} changed or disappeared at ${revision}`));
    }
  }
}

function activationBoundary(context, commits) {
  const activation = commits.find((entry) => entry.changes.some((change) => (change.status === "A" && change.path === WORKFLOW) || (change.status === "R" && change.destination === WORKFLOW)));
  context.report.activation = activation?.commit ?? null;
  if (!activation) {
    const gaps = context.phase === "local" && !context.gate ? context.report.blocked : context.report.failures;
    gaps.push(gap("activation_unresolved", `${WORKFLOW} has no first-parent activation on ${context.mainSha}`));
    return;
  }
  if (activation.parents.length !== 1 || activation.changes.some((change) => [change.path, change.destination].some((path) => path?.startsWith("supabase/migrations/")))) {
    context.report.failures.push(gap("activation_unresolved", `Activation ${activation.commit} changes migrations or has no single first parent`));
  }
  const ancestors = git(context.root, ["rev-list", "--first-parent", context.candidate]).toString().split(/\s+/);
  if (!ancestors.includes(activation.commit) || !trackedTree(context.root, context.mainSha).has(WORKFLOW)) context.report.failures.push(gap("activation_unresolved", "Activation is not an ancestor of the checked revision, or workflow was removed"));
  const afterActivation = commits.slice(commits.indexOf(activation));
  checkReservedVersions(context, afterActivation.map((entry) => [entry.commit, trackedTree(context.root, entry.commit)]).concat([[context.candidate, context.files]]));
}

function checkMember(context, row, commits) {
  const matching = (path) => path?.startsWith("supabase/migrations/") && path.endsWith(row.suffix);
  const ambiguous = commits.some((entry) => entry.changes.some((change) =>
    (change.status === "R" && (matching(change.path) || matching(change.destination))) ||
    (change.status === "A" && matching(change.path) && change.path !== row.path)));
  const adding = commits.filter((entry) => entry.changes.some((change) => change.status === "A" && change.path === row.path));
  if (adding.length) {
    const firstAddition = adding[0];
    const original = trackedTree(context.root, firstAddition.commit).get(row.path)?.blob;
    const laterChange = commits.slice(commits.indexOf(firstAddition) + 1).some((entry) => entry.changes.some((change) => change.path === row.path || change.destination === row.path));
    if (laterChange || !original || context.files.get(row.path)?.blob !== original) context.report.failures.push(gap("member_modified_after_merge", row.member));
  }
  if (ambiguous || adding.length > 1 || adding.some((entry) => entry.parents.length !== 1)) {
    context.report.failures.push(gap("member_assignment_ambiguous", row.member)); return;
  }
  if (!adding.length) {
    context.report.blocked.push(gap("member_not_on_main", row.member));
    if (row.version !== "*unassigned*") {
      const main = snapshot(context, context.mainSha);
      if (main.newestVersion >= row.version || main.marker >= row.version) context.report.failures.push(gap("member_stale_version", row.member));
    }
    return;
  }
  const addition = adding[0];
  const derived = snapshot(context, addition.parents[0]);
  context.report.migrationSnapshots[row.member] = derived;
  if (derived.newestVersion >= row.version || derived.marker >= row.version) context.report.failures.push(gap("member_snapshot_stale", row.member));
  const recorded = context.evidence?.migrationSnapshots?.[row.member];
  if (!recorded) context.report.blocked.push(gap("migration_snapshot_evidence_missing", row.member));
  else if (!snapshotSchema.safeParse(recorded).success || Object.keys(derived).some((field) => recorded[field] !== derived[field])) context.report.failures.push(gap("member_snapshot_mismatch", row.member));
}

function candidateContext(context) {
  if (context.event === "pull_request_target") {
    const candidate = commitSha(context.root, context.requestedCandidate, "candidate_ref_invalid");
    const parents = git(context.root, ["show", "-s", "--format=%P", candidate]).toString().trim().split(" ");
    if (!sha.safeParse(context.head).success || parents.length !== 2 || parents[0] !== context.mainSha || parents[1] !== context.head) {
      throw new GateError("candidate_ref_invalid", "Merge ref must have current base tip and immutable event head as its two parents");
    }
    return candidate;
  }
  if (context.event === "push") {
    if (context.requestedCandidate || !sha.safeParse(context.head).success) throw new GateError("candidate_ref_invalid", "Push checks require --head <pushed SHA> and no --candidate");
    const pushed = commitSha(context.root, context.head, "assignment_commit_unreachable");
    if (!git(context.root, ["rev-list", "--first-parent", context.mainSha]).toString().split(/\s+/).includes(pushed)) throw new GateError("candidate_ref_invalid", "Pushed SHA is not on the main first-parent line");
    context.mainSha = pushed;
    return pushed;
  }
  return commitSha(context.root, context.requestedCandidate ?? context.evidence?.candidate ?? "HEAD", "candidate_ref_invalid");
}

function candidateManifestRules(context, manifest) {
  if (context.event !== "pull_request_target") return;
  const base = migrationManifest(committedBytes(context, context.spec, context.mainSha).toString("utf8"));
  const changes = changeEntries(git(context.root, ["diff", "--name-status", "-z", "-M", "-l0", context.mainSha, context.candidate]).toString().split("\0"));
  const added = new Set(changes.filter((change) => change.status === "A").map((change) => change.path));
  const allowed = base.length === manifest.length && base.every((row, index) => {
    const candidate = manifest[index];
    return candidate.order === row.order && candidate.suffix === row.suffix && (candidate.version === row.version || (row.version === "*unassigned*" && added.has(candidate.path)));
  });
  const seriesChanges = changes.filter((change) => [change.path, change.destination].some((path) => Object.values(SERIES).some((suffix) => path?.startsWith("supabase/migrations/") && path.endsWith(suffix))));
  for (const [member, suffix] of Object.entries(SERIES)) {
    const assigned = manifest.find((row) => row.member === member)?.path;
    if (seriesChanges.some((change) => (change.status === "A" && change.path.endsWith(suffix) && change.path !== assigned) || (change.status === "R" && [change.path, change.destination].some((path) => path?.endsWith(suffix))))) context.report.failures.push(gap("member_assignment_ambiguous", member));
  }
  if (!allowed || seriesChanges.some((change) => change.status === "A" && !manifest.some((row) => row.path === change.path))) context.report.failures.push(gap("manifest_rewritten", "Ordered manifest was removed, added, reassigned or changed without its own member addition"));
  if (seriesChanges.length && changes.some((change) => [change.path, change.destination].some((path) => path === CHECKER || path === CHECKER.replace(".mjs", ".test.mjs") || path === ".github/CODEOWNERS" || path?.startsWith(".github/workflows/")))) {
    context.report.failures.push(gap("gate_self_modification", "Series migration and checker/workflow/CODEOWNERS changed in one candidate"));
  }
}

function migrationChecks(context) {
  const manifest = migrationManifest(committedBytes(context, context.spec).toString("utf8"));
  context.manifest = manifest;
  checkMigrationOrder(context, manifest);
  checkReservedVersions(context, [[context.candidate, context.files]]);
  candidateManifestRules(context, manifest);
  const commits = history(context.root, context.mainSha);
  context.history = commits;
  activationBoundary(context, commits);
  for (const member of Object.keys(SERIES)) checkMember(context, manifest.find((row) => row.member === member), commits);
  for (const row of manifest) {
    if (row.version === "*unassigned*" || !context.files.has(row.path)) context.report.blocked.push(gap("migration_manifest_incomplete", row.path));
  }
}

function artifactBytes(context, artifact) {
  const directory = context.evidenceDirectory ?? context.root;
  const path = isAbsolute(artifact.path) ? artifact.path : resolve(directory, artifact.path);
  let bytes;
  try { bytes = readFileSync(realpathSync(path)); }
  catch (error) {
    if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EISDIR"].includes(error.code)) throw error;
    throw new GateError("artifact_missing", artifact.path);
  }
  if (digest(bytes) !== artifact.sha256) throw new GateError("artifact_hash_mismatch", artifact.path);
  // Never print the matching text: evidence is untrusted and can contain credentials.
  if (/(?:[a-z][a-z0-9+.-]*:\/\/[^\s/?#"'<>]+@)|(?:["']?authorization["']?\s*[:=]\s*["']?Basic\s+[A-Za-z0-9+/]{8,}={0,2})|(?:https?:\/\/[^\s"']+[?&](?:access_token|refresh_token|api_key)=)|(?:Bearer\s+[A-Za-z0-9_.-]{20,})|(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)|(?:eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)|(?:["']?(?:access_token|refresh_token|api_key|password|client_secret|SUPABASE_SERVICE_ROLE_KEY)["']?\s*[:=]\s*["'](?!\[REDACTED\]|<redacted>)[^"'\s]{6,})/i.test(bytes.toString("utf8"))) {
    throw new GateError("artifact_redaction_failed", artifact.path);
  }
  return bytes;
}

function expandBraces(path) {
  const match = path.match(/\{([^{}]+)\}/);
  return match ? match[1].split(",").flatMap((part) => expandBraces(path.replace(match[0], part))) : [path];
}

function runtimeSeeds(context) {
  const markdown = committedBytes(context, context.spec).toString("utf8");
  const runtimeTable = section(markdown, "### Function and module set", "### Schedules and switches");
  return tableRows(runtimeTable).slice(2).flatMap((cells) => [...(cells[1] ?? "").matchAll(/`([^`]+\.ts)`/g)]
    .flatMap((match) => expandBraces(`supabase/functions/${match[1]}`)));
}

function moduleImports(bytes, path) {
  const syntax = ts.createSourceFile(path, bytes.toString("utf8"), ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  if (syntax.parseDiagnostics.length) throw new GateError("runtime_parse_failed", path);
  const imports = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) throw new GateError("runtime_import_unresolved", path);
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(syntax);
  return { syntax, imports };
}

function importedPath(context, caller, specifier) {
  const target = specifier.startsWith("@/") ? `src/${specifier.slice(2)}` : posix.normalize(posix.join(posix.dirname(caller), specifier));
  const path = [target, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"].map((extension) => `${target}${extension}`),
    ...[".ts", ".tsx", ".js", ".jsx"].map((extension) => `${target}/index${extension}`)].find((candidate) => context.files.has(candidate));
  if (!path || isTest(path) || (!path.startsWith("src/") && !path.startsWith("supabase/functions/"))) throw new GateError("runtime_import_unresolved", `${caller}: ${specifier}`);
  return path;
}

function addRuntimeClosure(context, paths, pending) {
  while (pending.length) {
    const path = pending.pop();
    if (paths.has(path)) continue;
    const bytes = committedBytes(context, path);
    paths.add(path);
    if (!/\.[cm]?[jt]sx?$/.test(path)) continue;
    for (const specifier of moduleImports(bytes, path).imports) {
      if (specifier.startsWith(".") || specifier.startsWith("@/")) pending.push(importedPath(context, path, specifier));
      else if (path.startsWith("supabase/functions/") && !/^(?:https:\/\/|npm:|node:)/.test(specifier)) throw new GateError("runtime_import_unresolved", `${path}: ${specifier}`);
      else context.externalImports.add(specifier);
    }
  }
}

function releaseSources(context) {
  const paths = new Set([context.spec, SOURCE_SPEC, TASK8_SPEC, ...REQUIRED_FILES, ...context.manifest.map((row) => row.path)]);
  for (const requirement of context.evidence.acceptance) for (const expected of requirement.requiredTests) paths.add(sourcePath(expected.file));
  context.runtimeRoots = runtimeSeeds(context);
  context.externalImports = new Set();
  const runtime = new Set();
  for (const path of context.runtimeRoots) collect(context, () => addRuntimeClosure(context, runtime, [path]));
  // Reuse the existing owner traversal, including its frontend aliases and canonical analytics modules.
  collect(context, () => {
    let owner;
    try {
      const cached = objectCache(context.root).owners;
      if (!cached.has(context.candidate)) cached.set(context.candidate, inventoryOwnerCandidate(context.root, context.candidate));
      owner = cached.get(context.candidate);
    }
    catch { throw new GateError("owner_source_inventory_incomplete", "Owner runtime/frontend import inventory could not be resolved at candidate"); }
    for (const file of [...owner.runtimeFiles, ...owner.frontendAndConfigFiles]) {
      paths.add(file.path);
      if (/\.[jt]sx?$/.test(file.path) && !isTest(file.path) && /^(?:src|supabase\/functions)\//.test(file.path)) runtime.add(file.path);
    }
    for (const specifier of owner.externalImports) context.externalImports.add(specifier);
  });
  for (const path of context.files.keys()) {
    if (/^supabase\/(?:migrations|tests)\//.test(path) || (/^(?:src|supabase\/functions)\//.test(path) && isTest(path)) || /^src\/features\/(?:instagram-insights|competitor-tracking)\//.test(path) ||
        /^supabase\/functions\/(?:instagram-insights-sync|instagram-insights-report|competitor-snapshot-sync|competitor-tracking-report|competitor-retention)\//.test(path)) paths.add(path);
  }
  const changed = git(context.root, ["diff", "--name-only", "-z", context.evidence.baseline, context.candidate]).toString().split("\0");
  for (const path of changed.filter((path) => /^(?:src|supabase\/functions)\/.*\.[jt]sx?$/.test(path) && !isTest(path) && context.files.has(path))) {
    collect(context, () => addRuntimeClosure(context, runtime, [path]));
  }
  for (const path of runtime) paths.add(path);
  context.runtimeFiles = runtime;
  return paths;
}

function verifyManifest(context) {
  const expected = releaseSources(context);
  const recorded = new Map();
  for (const file of context.evidence.artifacts) {
    if (recorded.has(file.path)) context.report.failures.push(gap("source_artifact_duplicate", file.path));
    recorded.set(file.path, file.sha256);
    collect(context, () => {
      if (digest(committedBytes(context, file.path)) !== file.sha256) throw new GateError("source_hash_mismatch", file.path);
    });
  }
  for (const path of expected) collect(context, () => {
    const hash = digest(committedBytes(context, path));
    if (recorded.get(path) !== hash) throw new GateError("source_manifest_incomplete", path);
  });
  for (const path of recorded.keys()) if (!expected.has(path)) context.report.failures.push(gap("source_manifest_unexpected", path));
  context.sourceHashes = recorded;
  context.report.sourceManifest = { required: expected.size, recorded: recorded.size, runtime: context.runtimeFiles.size, externalImports: [...context.externalImports].sort() };
}

function readJsonArtifact(context, artifact) {
  const bytes = artifactBytes(context, artifact);
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new GateError("report_json_invalid", artifact.path); }
}

function playwrightSourcePath(report, file) {
  if (typeof file !== "string") return null;
  const normalized = file.replaceAll("\\", "/");
  const configFile = typeof report.config?.configFile === "string" ? report.config.configFile.replaceAll("\\", "/") : null;
  const rootDir = typeof report.config?.rootDir === "string" ? report.config.rootDir.replaceAll("\\", "/") : null;
  if (!configFile || !rootDir || posix.basename(configFile) !== "playwright.instagram-release.config.ts") return normalized;
  const absolute = /^(?:[A-Za-z]:\/|\/)/.test(normalized) ? normalized : posix.join(rootDir, normalized);
  return posix.relative(posix.dirname(configFile), absolute);
}

function playwrightProof(context, proof) {
  const report = readJsonArtifact(context, proof.artifact);
  if (!report || !Array.isArray(report.suites) || !report.stats) throw new GateError("playwright_report_invalid", proof.id);
  const specs = [];
  function visit(suite) {
    if (!suite || (suite.specs !== undefined && !Array.isArray(suite.specs)) || (suite.suites !== undefined && !Array.isArray(suite.suites))) throw new GateError("playwright_report_invalid", proof.id);
    specs.push(...(suite.specs ?? []));
    for (const child of suite.suites ?? []) visit(child);
  }
  for (const suite of report.suites ?? []) visit(suite);
  if (report.errors?.length || !specs.length || report.stats?.skipped !== 0 || report.stats?.unexpected !== 0 || report.stats?.flaky !== 0 || report.stats?.expected !== specs.length) throw new GateError("playwright_run_not_clean", proof.id);
  for (const spec of specs) {
    const execution = spec?.tests?.[0];
    if (!spec?.ok || !Array.isArray(spec.tests) || spec.tests.length !== 1 || !execution || execution.expectedStatus !== "passed" || execution.status !== "expected" || !Array.isArray(execution.results) || execution.results.length !== 1 || execution.results[0]?.status !== "passed" || execution.results[0]?.errors?.length) throw new GateError("playwright_run_not_clean", proof.id);
  }
  const matches = specs.filter((spec) => spec.title === proof.testTitle && playwrightSourcePath(report, spec.file) === proof.source.path && spec.tests[0].projectName === proof.project);
  if (matches.length !== 1 || !proof.project) throw new GateError("proof_wrong_scope", proof.id);
}

function validateProof(context, proof) {
  if (proof.candidate !== context.candidate || proof.tree !== context.report.tree) throw new GateError("proof_stale_candidate", proof.id);
  if (proof.status !== "passed" || proof.exit !== 0 || proof.skipped !== 0 || proof.flaky !== 0 || proof.failures !== 0 || proof.attempts !== 1) throw new GateError("proof_not_clean", proof.id);
  if (/--no-check|(?:--allow-net(?:\s|$)(?![=]))|(?:test\.skip|--passWithNoTests)/.test(proof.command)) throw new GateError("proof_command_unsafe", proof.id);
  if (proof.environment === "live" && (proof.reporter !== "receipt" || /(?:localhost|127\.0\.0\.1|fixture|synthetic|playwright)/i.test(proof.command))) throw new GateError("proof_wrong_scope", proof.id);
  if (context.sourceHashes.get(proof.source.path) !== proof.source.sha256 || digest(committedBytes(context, proof.source.path)) !== proof.source.sha256) throw new GateError("proof_wrong_source", proof.id);
  artifactBytes(context, proof.artifact);
  if (proof.reporter === "playwright") playwrightProof(context, proof);
  else executionReceiptProof(context, proof);
}

function executionReceiptProof(context, proof) {
  const parsed = executionReceiptSchema.safeParse(readJsonArtifact(context, proof.artifact));
  if (!parsed.success) throw new GateError("execution_receipt_invalid", proof.id);
  for (const key of Object.keys(proof).filter((key) => !["artifact", "reporter"].includes(key))) {
    if (JSON.stringify(parsed.data[key]) !== JSON.stringify(proof[key])) throw new GateError("execution_receipt_mismatch", proof.id);
  }
}

function proofInventory(context) {
  const proofs = new Map();
  context.validProofs = new Set();
  for (const proof of context.evidence.proofs) {
    if (proofs.has(proof.id)) { context.report.failures.push(gap("proof_duplicate", proof.id)); context.validProofs.delete(proof.id); }
    else {
      proofs.set(proof.id, proof);
      collect(context, () => { validateProof(context, proof); context.validProofs.add(proof.id); });
    }
  }
  context.proofs = proofs;
}

function requirementProofs(context, requirement, row) {
  if (requirement.inventoryStatus !== row.inventoryStatus) throw new GateError("inventory_status_mismatch", row.id);
  if (requirement.blocker) { row.execution = "blocked"; context.report.blocked.push(gap("acceptance_blocked", `${row.id}: ${requirement.blocker}`)); }
  const selected = requirement.proofIds.map((id) => context.proofs.get(id));
  const identities = requirement.requiredTests.map((expected) => JSON.stringify(expected));
  if (new Set(identities).size !== identities.length) throw new GateError("required_test_duplicate", row.id);
  if (!requirement.proofIds.length || new Set(requirement.proofIds).size !== requirement.proofIds.length) throw new GateError("acceptance_proofs_missing_or_duplicate", row.id);
  for (const expected of requirement.requiredTests) {
    const matches = selected.filter((proof) => proof && proof.testTitle === expected.title && proof.source.path === expected.file && proof.project === expected.project && proof.environment === "local");
    if (matches.length !== 1 || !context.validProofs.has(matches[0].id)) throw new GateError("required_test_unproved", `${row.id}: ${expected.file} :: ${expected.title}`);
  }
  if (selected.some((proof) => !proof || !context.validProofs.has(proof.id))) throw new GateError("required_test_unproved", row.id);
  if (row.inventoryStatus === "blocked-on-dependency") {
    if (!requirement.resolution) throw new GateError("dependency_resolution_missing", row.id);
    artifactBytes(context, requirement.resolution.artifact);
  }
  if (!requirement.blocker) row.execution = "passed";
}

function acceptanceProofs(context) {
  const requirements = new Map();
  for (const requirement of context.evidence.acceptance) {
    if (requirements.has(requirement.id)) context.report.failures.push(gap("acceptance_id_duplicate", requirement.id));
    requirements.set(requirement.id, requirement);
  }
  for (const row of context.report.acceptance) collect(context, () => {
    const requirement = requirements.get(row.id);
    if (!requirement) throw new GateError("acceptance_evidence_missing", row.id);
    requirementProofs(context, requirement, row);
  });
  for (const id of requirements.keys()) if (!context.report.acceptance.some((row) => row.id === id)) context.report.failures.push(gap("acceptance_id_unknown", id));
}

function exportedBinding(context, path, symbol, visited = new Set()) {
  if (visited.has(`${path}:${symbol}`)) return null;
  visited.add(`${path}:${symbol}`);
  const { syntax } = moduleImports(committedBytes(context, path), path);
  for (const statement of syntax.statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) continue;
    const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
    if ((exported && (statement.name?.text === symbol || (isDefault && symbol === "default"))) ||
        (exported && ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) => declaration.name.getText(syntax) === symbol)) ||
        (ts.isExportAssignment(statement) && symbol === "default")) return { target: path, symbol };
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
    const named = statement.exportClause && ts.isNamedExports(statement.exportClause) ? statement.exportClause.elements.find((entry) => entry.name.text === symbol && !entry.isTypeOnly) : null;
    if (!statement.moduleSpecifier && named) return { target: path, symbol };
    if (!statement.moduleSpecifier || (statement.exportClause && !named)) continue;
    const target = importedPath(context, path, statement.moduleSpecifier.text);
    const resolved = exportedBinding(context, target, named?.propertyName?.text ?? named?.name.text ?? symbol, new Set(visited));
    if (resolved) return resolved;
  }
  return null;
}

function frozenInventory(context) {
  const reviewed = readJsonArtifact(context, context.evidence.inventoryReview.artifact);
  const frozenSchema = z.object({
    formatVersion: z.literal(1), baseline: sha, candidate: sha, tree: sha,
    acceptance: z.array(z.object({ id: nonempty, requiredTests: z.array(testIdentity).min(1) }).strict()),
    fixtureSchema: fileHash,
  }).strict();
  if (!frozenSchema.safeParse(reviewed).success) throw new GateError("inventory_review_invalid", "Review must freeze exact test identities and fixture schema");
  if (["baseline", "candidate", "tree"].some((field) => reviewed[field] !== context.evidence[field])) throw new GateError("inventory_review_stale", "Reviewed inventory must bind this candidate/baseline/tree");
  const identities = (rows) => rows.map((row) => ({ id: row.id, requiredTests: row.requiredTests })).sort((left, right) => left.id.localeCompare(right.id));
  if (JSON.stringify(identities(reviewed.acceptance)) !== JSON.stringify(identities(context.evidence.acceptance))) throw new GateError("inventory_expectations_changed", "Ledger test titles/files/projects differ from retained reviewed inventory");
  if (reviewed.fixtureSchema.path !== "e2e/fixtures/instagramReleaseSeed.ts" || context.sourceHashes.get(reviewed.fixtureSchema.path) !== reviewed.fixtureSchema.sha256) throw new GateError("fixture_schema_mismatch", reviewed.fixtureSchema.path);
}

function actualCall(context, step) {
  if (isTest(step.caller) || isTest(step.callee) || !context.runtimeFiles.has(step.callee)) throw new GateError("runtime_caller_invalid", step.callee);
  const { syntax } = moduleImports(committedBytes(context, step.caller), step.caller);
  const bindings = new Map();
  for (const statement of syntax.statements.filter(ts.isImportDeclaration)) {
    if (statement.importClause?.isTypeOnly || !/^(?:\.|@\/)/.test(statement.moduleSpecifier.text)) continue;
    const target = importedPath(context, step.caller, statement.moduleSpecifier.text);
    const clause = statement.importClause;
    if (clause?.name) bindings.set(clause.name.text, { target, symbol: "default" });
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const binding of clause.namedBindings.elements) {
      if (!binding.isTypeOnly) bindings.set(binding.name.text, { target, symbol: binding.propertyName?.text ?? binding.name.text });
    }
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) bindings.set(clause.namedBindings.name.text, { target, symbol: "*" });
  }
  let matched = false;
  function visit(node) {
    if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const expression = node.expression ?? node.tagName;
      const binding = ts.isIdentifier(expression) ? bindings.get(expression.text) : ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) ? bindings.get(expression.expression.text) : undefined;
      const symbol = binding?.symbol === "*" && ts.isPropertyAccessExpression(expression) ? expression.name.text : binding?.symbol;
      const actual = binding && exportedBinding(context, binding.target, symbol);
      if (actual?.target === step.callee && actual.symbol === step.symbol && syntax.getLineAndCharacterOfPosition(node.getStart(syntax)).line + 1 === step.line) matched = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(syntax);
  if (!matched) throw new GateError("runtime_call_missing", `${step.caller}:${step.line} -> ${step.callee} :: ${step.symbol}`);
}

function unparenthesized(expression) {
  while (expression && ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return expression;
}

function scheduledPaidPolicy(context) {
  const path = "supabase/functions/competitor-snapshot-sync/index.ts";
  const { syntax } = moduleImports(committedBytes(context, path), path);
  const factories = [];
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(syntax) === "createServiceWorker") factories.push(node.initializer);
    ts.forEachChild(node, visit);
  }
  visit(syntax);
  const factory = unparenthesized(factories[0]);
  if (factories.length !== 1 || !(factory && (ts.isArrowFunction(factory) || ts.isFunctionExpression(factory)))) throw new GateError("scheduled_apify_policy_unproved", path);
  const body = factory.body;
  let worker = unparenthesized(ts.isBlock(body) ? body.statements.filter(ts.isReturnStatement).at(-1)?.expression : body);
  if (worker && ts.isIdentifier(worker) && ts.isBlock(body)) {
    worker = unparenthesized(body.statements.filter(ts.isVariableStatement).flatMap((statement) => [...statement.declarationList.declarations]).find((declaration) => declaration.name.getText(syntax) === worker.text)?.initializer);
  }
  const paid = unparenthesized(worker && ts.isObjectLiteralExpression(worker) ? worker.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(syntax) === "paidFallback")?.initializer : null);
  const enabled = unparenthesized(paid && ts.isObjectLiteralExpression(paid) ? paid.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(syntax) === "enabled")?.initializer : null);
  if (!enabled || enabled.kind !== ts.SyntaxKind.FalseKeyword || paid.properties.some(ts.isSpreadAssignment) || worker.properties.some(ts.isSpreadAssignment)) throw new GateError("scheduled_apify_policy_unproved", path);
  context.report.deferredFeatures = ["scheduled Apify (adapter-only acceptance A12; not a shipped scheduled fallback)"];
}

function containsRuntimeCode(context, path) {
  const { syntax } = moduleImports(committedBytes(context, path), path);
  return syntax.statements.some((statement) => !ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement) && !ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement) && !ts.isEmptyStatement(statement));
}

function runtimeCallers(context) {
  const reached = new Set();
  const entrypoints = new Set([...context.runtimeRoots.filter((path) => path.endsWith("/index.ts")), "src/pages/analytics/InstagramAnalytics.tsx"]);
  for (const chain of context.evidence.runtimeCallers) collect(context, () => {
    if (!entrypoints.has(chain.entrypoint) || chain.steps[0].caller !== chain.entrypoint) throw new GateError("runtime_entrypoint_invalid", chain.entrypoint);
    artifactBytes(context, chain.artifact);
    for (let index = 0; index < chain.steps.length; index++) {
      if (index && chain.steps[index - 1].callee !== chain.steps[index].caller) throw new GateError("runtime_chain_disconnected", chain.entrypoint);
      actualCall(context, chain.steps[index]);
    }
    for (const step of chain.steps) reached.add(step.callee);
  });
  const baseline = trackedTree(context.root, context.evidence.baseline);
  for (const path of context.runtimeFiles) {
    const deferredAdapter = path === "supabase/functions/competitor-snapshot-sync/apifyProvider.ts" && context.report.deferredFeatures?.length;
    if (!baseline.has(path) && !entrypoints.has(path) && !reached.has(path) && !deferredAdapter && /\.[jt]sx?$/.test(path) && containsRuntimeCode(context, path)) context.report.failures.push(gap("runtime_caller_missing", path));
  }
  for (const suffix of ["instagram-insights-sync/worker.ts", "instagram-insights-sync/workerStore.ts", "instagram-insights-sync/graphProvider.ts", "instagram-insights-sync/directGraphProvider.ts", "instagram-insights-report/reportStore.ts", "instagram-insights-report/assemble.ts", "_shared/outlierScore.ts", "competitor-snapshot-sync/syncWorker.ts", "competitor-snapshot-sync/store.ts", "competitor-tracking-report/assemble.ts", "competitor-tracking-report/reportStore.ts", "competitor-retention/run.ts"]) {
    const path = `supabase/functions/${suffix}`;
    if (!reached.has(path)) context.report.failures.push(gap("runtime_caller_missing", path));
  }
}

function dependencyAndReviewReceipts(context) {
  for (const name of REQUIRED_DEPENDENCIES) collect(context, () => {
    const matches = context.evidence.dependencies.filter((entry) => entry.name === name);
    if (matches.length !== 1 || matches[0].status !== "resolved" || !matches[0].artifact || !matches[0].reviewer) throw new GateError("dependency_unresolved", name);
    artifactBytes(context, matches[0].artifact);
  });
  for (const name of REQUIRED_REVIEWS) collect(context, () => {
    const matches = context.evidence.reviews.filter((entry) => entry.name === name);
    if (matches.length !== 1 || matches[0].status !== "passed") throw new GateError("review_missing_or_failed", name);
    artifactBytes(context, matches[0].artifact);
  });
  const hosted = context.evidence.hosted.proofIds.map((id) => context.proofs.get(id));
  if (!hosted.length) {
    context.report.pendingEvidence.push("Exact-candidate hosted checks/reviews pending; local execution is distinct");
    if (context.phase === "release") context.report.blocked.push(gap("hosted_evidence_pending", "Exact-candidate hosted checks/reviews are required"));
  } else if (new Set(context.evidence.hosted.proofIds).size !== hosted.length || hosted.some((proof) => !proof || proof.environment !== "hosted" || !context.validProofs.has(proof.id))) {
    context.report.failures.push(gap("hosted_evidence_invalid", "Claimed hosted checks/reviews do not bind valid exact-candidate hosted proofs"));
  }
}

function protectedWorkflowInventory(workflow, bootstrap) {
  const jobs = Object.values(workflow.jobs ?? {});
  if (jobs.length !== 1) throw new GateError("migration_workflow_execution", "One protected environment-bound gate job is required");
  const [job] = jobs;
  const onlyKeys = (entry, allowed) => Object.keys(entry).every((key) => allowed.includes(key));
  if ((typeof job.environment === "string" ? job.environment : job.environment?.name) !== bootstrap.environment.name) throw new GateError("migration_workflow_environment", "The checker job must bind the gate App environment");
  if (!onlyKeys(workflow, ["name", "on", "permissions", "jobs"]) || !onlyKeys(job, ["name", "runs-on", "environment", "steps", "permissions", "timeout-minutes"])
    || (typeof job.environment !== "string" && !onlyKeys(job.environment, ["name"]))
    || job["runs-on"] !== "ubuntu-latest" || !Array.isArray(job.steps)) throw new GateError("migration_workflow_execution", "Unreviewed execution context cannot surround the protected checker");
  const steps = job.steps;
  const checkouts = steps.filter((step) => /^actions\/checkout@/.test(step.uses ?? ""));
  const checkout = checkouts[0];
  if (checkouts.length !== 1 || steps[0] !== checkout || !onlyKeys(checkout, ["name", "id", "uses", "with"])
    || !/^actions\/checkout@(?:v\d+|[a-f0-9]{40})$/.test(checkout.uses) || checkout.with?.["fetch-depth"] !== 0
    || checkout.with?.ref !== "${{ github.event.pull_request.base.sha || github.sha }}"
    || (checkout.with.path && checkout.with.path !== ".") || checkout.with.repository || checkout.env || checkout.run) throw new GateError("migration_workflow_checkout", "Only one full-history protected-base checkout may precede execution");
  const commands = {
    pull_request_target: "node scripts/check-instagram-release-gates.mjs --gate migrations --main-ref origin/main --event pull_request_target --candidate $CANDIDATE --head '${{ github.event.pull_request.head.sha }}'",
    push: "node scripts/check-instagram-release-gates.mjs --gate migrations --main-ref origin/main --event push --head '${{ github.sha }}'",
  };
  if (steps.length !== 3 || steps.slice(1).some((step) => !onlyKeys(step, ["name", "id", "if", "env", "run"])
    || Object.keys(step.env ?? {}).some((name) => name !== "GATE_KEY"))) throw new GateError("migration_workflow_execution", "Only the protected PR/push checker invocations are supported; extra execution requires separate review");
  for (const [event, command] of Object.entries(commands)) {
    const matches = steps.slice(1).filter((step) => step.if === `github.event_name == '${event}'` && typeof step.run === "string" && step.run.trim() === command);
    if (matches.length !== 1) throw new GateError("migration_workflow_dispatch", "Require explicit ordered protected-checker invocations for both PR and push events");
    if (event === "pull_request_target" && matches[0].name !== bootstrap.app.context) throw new GateError("migration_workflow_dispatch", "The inventoried PR checker must bind the dedicated App context");
  }
}

function workflowContract(context, bootstrap) {
  const source = committedBytes(context, WORKFLOW).toString("utf8");
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length || document.warnings.length) throw new GateError("migration_workflow_invalid", "Workflow YAML cannot be parsed unambiguously");
  const workflow = document.toJS();
  const triggers = workflow.on;
  if (!triggers || !Object.hasOwn(triggers, "pull_request_target") || !triggers.push?.branches?.includes("main") || Object.keys(triggers).some((event) => !["pull_request_target", "push"].includes(event))) throw new GateError("migration_workflow_invalid", "Require pull_request_target and push on main only");
  const permissionsSafe = (permissions) => permissions && permissions.contents === "read" && Object.keys(permissions).length === 1;
  if (!permissionsSafe(workflow.permissions)) throw new GateError("migration_workflow_permissions", "Require contents: read only");
  const jobs = Object.values(workflow.jobs ?? {});
  if (!jobs.length || jobs.some((job) => job.permissions && !permissionsSafe(job.permissions))) throw new GateError("migration_workflow_permissions", "Job permissions must not elevate workflow permissions");
  const secrets = [...source.matchAll(/secrets\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([^'"]+)['"]\s*\])/g)].map((match) => match[1] ?? match[2]);
  if (!secrets.length || secrets.some((name) => name !== bootstrap.app.privateKeySecret) || /secrets\s*\[(?!\s*['"])/.test(source) || /(?:toJSON|toJson)\s*\(\s*secrets/.test(source)) throw new GateError("migration_workflow_secret", "Only the dedicated gate App private-key secret is permitted");
  protectedWorkflowInventory(workflow, bootstrap);
}

function protectedOwners(context) {
  const source = committedBytes(context, ".github/CODEOWNERS").toString("utf8");
  const patterns = source.split(/\r?\n/).map((line) => line.replace(/\s*#.*$/, "").trim()).filter(Boolean).map((line) => line.split(/\s+/));
  for (const path of [CHECKER, ".github/workflows/ci.yml", WORKFLOW, context.spec, "docs/plans/2026-10-30-instagram-release-gates.md", "docs/specs/2026-10-30-instagram-collection-rollout-controls.md", "docs/plans/2026-10-30-instagram-collection-rollout-controls.md", ".github/CODEOWNERS", "supabase/migrations/series.sql"]) {
    const matching = patterns.filter(([pattern]) => {
      const normalized = pattern.replace(/^\//, "");
      const expression = normalized.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("**", "\0").replaceAll("*", "[^/]*").replaceAll("\0", ".*");
      return new RegExp(`^${normalized.includes("/") ? "" : "(?:.*/)?"}${expression}${normalized.endsWith("/") ? ".*" : "(?:/.*)?"}$`).test(path);
    }).at(-1);
    if (!matching || matching.length < 2) throw new GateError("codeowners_incomplete", path);
  }
}

function bootstrapReceipts(context) {
  const bootstrap = context.evidence.bootstrap;
  if (!bootstrap) { context.report.blocked.push(gap("bootstrap_evidence_pending", "Task 6 App/environment/branch-protection receipts are absent")); return; }
  artifactBytes(context, bootstrap.artifact);
  const protection = bootstrap.branchProtection;
  if (!protection.upToDate || !protection.squashOnly || !protection.codeOwnerReview || protection.administratorBypass || !protection.dismissStale || protection.requiredContext !== bootstrap.app.context || protection.expectedAppId !== bootstrap.app.id || !bootstrap.app.statusesWriteOnly || !bootstrap.environment.defaultBranchOnly) throw new GateError("bootstrap_configuration_invalid", "Required pinned App status, default-branch environment, squash/up-to-date and owner protections are not established");
  if (bootstrap.publicRepository && (bootstrap.eventPolicy.workflow !== WORKFLOW || !bootstrap.eventPolicy.pullRequestTargetAllowed)) throw new GateError("bootstrap_event_policy_missing", WORKFLOW);
  workflowContract(context, bootstrap);
  protectedOwners(context);
  const ownersAddition = context.history?.findIndex((entry) => entry.changes.some((change) => change.status === "A" && change.path === ".github/CODEOWNERS"));
  const activation = context.history?.findIndex((entry) => entry.commit === context.report.activation);
  if (ownersAddition === undefined || ownersAddition < 0 || activation === undefined || ownersAddition >= activation) throw new GateError("bootstrap_order_invalid", "CODEOWNERS must land separately before the gate workflow");
  // Syntax and reviewed claims cannot prove that this recipe fetches its merge object,
  // installs the checker dependencies or emits the pinned App status on the verified head.
  context.report.blocked.push(gap("migration_workflow_execution_unverified", "Workflow inventory is not executable bootstrap evidence: protected candidate fetch, dependency installation and dedicated App status publication require a reviewed implementation"));
}

function liveReceipts(context) {
  const live = context.evidence.live;
  if (live.status === "pending") {
    if (live.approvals.length) throw new GateError("live_evidence_scope_invalid", "Pending live ledger contains completed approvals");
    context.report.pendingEvidence.push("G-L and individual B–E approvals pending; no production action authorized");
    if (context.phase === "release") context.report.failures.push(gap("live_evidence_pending", "G-L and B–E approval receipts are required"));
    return;
  }
  const timestamps = [];
  for (const action of APPROVAL_ACTIONS) {
    const matches = live.approvals.filter((approval) => approval.action === action);
    if (matches.length !== 1) throw new GateError("live_approval_missing_or_duplicate", action);
    const approval = matches[0];
    if (approval.candidate !== context.candidate || approval.tree !== context.report.tree) throw new GateError("live_approval_stale", action);
    const proofs = approval.proofIds.map((id) => context.proofs.get(id));
    if (new Set(approval.proofIds).size !== proofs.length || proofs.some((proof) => !proof || proof.environment !== "live" || !context.validProofs.has(proof.id))) throw new GateError("live_approval_wrong_scope", action);
    artifactBytes(context, approval.artifact);
    timestamps.push(Date.parse(approval.timestamp));
  }
  if (live.approvals.some((approval) => !APPROVAL_ACTIONS.includes(approval.action)) || timestamps.some((stamp, index) => index && stamp <= timestamps[index - 1])) throw new GateError("live_approval_order_invalid", "Every numbered action, including retention dry-run and enable, requires its own later approval");
  context.report.pendingEvidence.push("Recorded live receipts validated as evidence; this checker grants no production authorization");
}

function evidenceChecks(context) {
  if (!context.evidence) throw new GateError("evidence_missing", "Supply the external redacted Task 11 per-run ledger; source inventory is not executed proof");
  const parsed = ledgerSchema.safeParse(context.evidence);
  if (!parsed.success) throw new GateError("evidence_schema_invalid", parsed.error.issues.map((issue) => issue.path.join(".")).join(", "));
  context.evidence = parsed.data;
  // Matching JSON/hashes bind content, not its origin. No trusted external verifier is implemented here.
  context.report.pendingEvidence.push("Execution/review/bootstrap/live artifact origins remain unverified; manual external review is required");
  if (context.phase === "release") context.report.blocked.push(gap("evidence_origin_unverified", "A trusted external evidence verifier is required; self-authored receipts and approvals cannot establish release readiness"));
  if (context.evidence.candidate !== context.candidate || context.evidence.tree !== context.report.tree) throw new GateError("evidence_stale_candidate", "Ledger candidate/tree must equal the checked immutable revision");
  if (context.evidence.baseline === context.candidate || spawnSync("git", ["-C", context.root, "merge-base", "--is-ancestor", context.evidence.baseline, context.candidate]).status !== 0) throw new GateError("evidence_baseline_invalid", "Accepted baseline must be a distinct reachable ancestor");
  collect(context, verifyManifest);
  if (!context.sourceHashes) return;
  collect(context, frozenInventory);
  proofInventory(context);
  acceptanceProofs(context);
  collect(context, scheduledPaidPolicy);
  collect(context, runtimeCallers);
  collect(context, dependencyAndReviewReceipts);
  collect(context, bootstrapReceipts);
  collect(context, liveReceipts);
  context.report.pendingEvidence.push("Artifact hashes and reviewed execution receipts checked; no test, hosted check, live probe or external approval was executed by this command");
}

function sourcePrerequisites(context) {
  for (const path of [...REQUIRED_FILES, ...runtimeSeeds(context)]) collect(context, () => {
    if (!context.files.has(path)) throw new GateError("required_source_missing", path);
  });
}

function collect(context, check) {
  try { check(context); } catch (error) {
    if (!(error instanceof GateError)) throw error;
    context.report.failures.push(gap(error.code, error.detail));
  }
}

export function evaluateReleaseGates(options) {
  const report = { formatVersion: 1, scope: "instagram-task11-release-gates", phase: options.phase ?? "local", gate: options.gate ?? null,
    candidate: null, tree: null, main: null, activation: null, acceptance: [], migrationSnapshots: {}, failures: [], blocked: [], pendingEvidence: [],
    localReady: false, releaseReady: false, productionActivationAuthorized: false, conclusion: "failed" };
  const context = { ...options, event: options.event ?? "local", requestedCandidate: options.candidate, evidence: options.evidence,
    phase: report.phase, report, spec: options.spec ?? DEFAULT_SPEC };
  collect(context, () => {
    context.mainSha = commitSha(context.root, context.mainRef, "main_ref_unresolved");
    context.candidate = candidateContext(context);
    context.files = trackedTree(context.root, context.candidate);
    report.candidate = context.candidate;
    report.tree = git(context.root, ["rev-parse", `${context.candidate}^{tree}`]).toString().trim();
    report.main = context.mainSha;
  });
  if (context.files) {
    if (!context.gate) collect(context, () => { report.acceptance = catalogue(context); });
    collect(context, migrationChecks);
    if (!context.gate) {
      collect(context, sourcePrerequisites);
      collect(context, evidenceChecks);
    }
  }
  report.failures = [...new Map(report.failures.map((entry) => [`${entry.code}:${entry.detail}`, entry])).values()];
  if (context.phase === "release") { report.failures.push(...report.blocked); report.blocked = []; }
  const passes = !report.failures.length && (!report.blocked.length || context.gate === "migrations");
  report.conclusion = passes ? (report.blocked.length ? "neutral" : "passed") : (report.failures.length ? "failed" : "blocked");
  report.localReady = passes && !context.gate;
  report.releaseReady = report.localReady && context.phase === "release";
  return report;
}

function cli(args) {
  const options = {};
  const flags = { "--spec": "spec", "--evidence": "evidencePath", "--main-ref": "mainRef", "--phase": "phase", "--gate": "gate", "--event": "event", "--candidate": "candidate", "--head": "head" };
  for (let index = 0; index < args.length; index += 2) {
    const key = flags[args[index]];
    if (!key || !args[index + 1] || args[index + 1].startsWith("--") || options[key] !== undefined) throw new GateError("usage", "--spec <path> --main-ref <ref> [--evidence <absolute JSON>] [--phase local|release | --gate migrations] [--event local|pull_request_target|push] [--candidate <merge SHA>] [--head <event head SHA>]");
    options[key] = args[index + 1];
  }
  if (!options.mainRef || (options.phase && options.gate) || (options.phase && !["local", "release"].includes(options.phase)) || (options.gate && options.gate !== "migrations") || (options.event && !["local", "pull_request_target", "push"].includes(options.event))) throw new GateError("usage", "Required --main-ref; choose --phase local|release or --gate migrations and a valid event");
  options.root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).toString().trim();
  if (options.evidencePath) {
    if (!isAbsolute(options.evidencePath)) throw new GateError("evidence_path_invalid", "Evidence must be an absolute local file path");
    options.evidenceDirectory = dirname(options.evidencePath);
    try { options.evidence = JSON.parse(readFileSync(options.evidencePath, "utf8")); }
    catch { throw new GateError("evidence_unreadable", "Cannot read valid evidence JSON; no input bytes are printed"); }
  }
  const report = evaluateReleaseGates(options);
  console.log(JSON.stringify(report, null, 2));
  if (!["passed", "neutral"].includes(report.conclusion)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { cli(process.argv.slice(2)); } catch (error) {
    console.error(JSON.stringify({ conclusion: "failed", releaseReady: false, productionActivationAuthorized: false, code: error.code ?? "checker_error", detail: error instanceof GateError ? error.detail : "Checker failed; no evidence input was accepted" }));
    process.exitCode = 1;
  }
}
