import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { evaluateReleaseGates } from "./check-instagram-release-gates.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CHECKER = fileURLToPath(new URL("./check-instagram-release-gates.mjs", import.meta.url));
const SPEC = "docs/specs/2026-10-30-instagram-release-gates.md";
const SOURCE = "docs/specs/2026-10-26-instagram-insights-and-competitor-tracking.md";
const TASK8 = "docs/specs/2026-10-30-competitor-ui-and-retention.md";
const WORKFLOW = ".github/workflows/instagram-migration-gate.yml";
const BASELINE = "supabase/tests/baseline_schema.sql";
const SPEC_TEXT = readFileSync(join(ROOT, SPEC), "utf8");
const MIGRATIONS = [...SPEC_TEXT.matchAll(/^\| \d+(?: \/ \w+)? \| `(\d{14}_[^`]+\.sql)`/gm)].map((match) => match[1]);
const MEMBERS = MIGRATIONS.slice(-3);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function repository(context, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "postora-gx-"));
  context.after(() => {
    const withinTemp = relative(realpathSync(tmpdir()), realpathSync(root));
    assert.ok(withinTemp && !withinTemp.startsWith("..") && !isAbsolute(withinTemp));
    rmSync(root, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" }).toString().trim();
  const put = (path, source) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  };
  const commit = () => {
    git("add", "--all");
    git("-c", "user.name=Release Gate Test", "-c", "user.email=release@example.test", "commit", "--quiet", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  git("init", "--quiet");
  git("branch", "-M", "main");
  for (const path of [SPEC, SOURCE, TASK8]) put(path, readFileSync(join(ROOT, path)));
  if (options.unassigned) put(SPEC, MEMBERS.reduce((markdown, name) => markdown.replace(name, `*unassigned*${name.slice(14)}`), SPEC_TEXT));
  put(BASELINE, "-- BASELINE_MIGRATION: 20260830120300_fixture.sql  BASELINE_COUNT: 0  BASELINE_SUM: synthetic\n");
  for (const name of MIGRATIONS.slice(0, -3)) put(`supabase/migrations/${name}`, "-- synthetic migration\n");
  const baseline = commit();
  if (!options.unassigned) for (const name of MEMBERS) put(`supabase/migrations/${name}`, "-- synthetic series member\n");
  const memberCommit = options.unassigned ? baseline : commit();
  git("update-ref", "refs/remotes/origin/main", memberCommit);
  const evaluate = (options = {}) => evaluateReleaseGates({ root, spec: SPEC, mainRef: "origin/main", gate: "migrations", ...options });
  const activate = () => { put(WORKFLOW, "name: migration gate\n"); const sha = commit(); git("update-ref", "refs/remotes/origin/main", sha); return sha; };
  return { root, put, git, commit, baseline, memberCommit, evaluate, activate };
}

const codes = (report) => [...report.failures, ...report.blocked].map((gap) => gap.code);

function fullLedger(context, customize = () => {}) {
  const fixture = repository(context);
  const paths = new Set();
  const runtime = SPEC_TEXT.slice(SPEC_TEXT.indexOf("### Function and module set"), SPEC_TEXT.indexOf("### Schedules and switches"));
  const runtimeCells = runtime.split(/\r?\n/).filter((line) => line.startsWith("| ")).map((line) => line.split("|")[2]).join("\n");
  for (const match of runtimeCells.matchAll(/`([^`\n]+\.ts)`/g)) {
    const brace = match[1].match(/\{([^}]+)\}/);
    for (const path of brace ? brace[1].split(",").map((name) => match[1].replace(brace[0], name)) : [match[1]]) paths.add(`supabase/functions/${path}`);
  }
  const extra = [
    "src/pages/analytics/InstagramAnalytics.tsx", "src/features/instagram-insights/index.ts", "src/features/competitor-tracking/index.ts",
    "src/features/analytics-contract/index.ts", "src/i18n/index.ts", "src/integrations/supabase/types.ts", "supabase/functions/_shared/outlierScore.ts",
    ...["analyticsContract", "analyticsCalendar", "analyticsRegistry", "analyticsSchema", "analyticsProjection"].map((name) => `supabase/functions/_shared/${name}.ts`),
  ];
  extra.forEach((path) => paths.add(path));
  paths.forEach((path) => fixture.put(path, "export function execute() {}\n"));
  const entrypoints = new Map();
  for (const path of paths) {
    if (path.endsWith("/index.ts") && path.startsWith("supabase/functions/")) { if (!entrypoints.has(path)) entrypoints.set(path, []); continue; }
    const root = path.startsWith("src/") ? "src/pages/analytics/InstagramAnalytics.tsx" : path.includes("/_shared/") ? "supabase/functions/instagram-insights-report/index.ts" : `${path.split("/").slice(0, 3).join("/")}/index.ts`;
    if (!entrypoints.has(root)) entrypoints.set(root, []);
    if (path !== root) entrypoints.get(root).push(path);
  }
  const chains = [];
  for (const [entrypoint, callees] of entrypoints) {
    const imports = callees.map((path, index) => `import { execute as call${index} } from "${posix.relative(posix.dirname(entrypoint), path).replace(/^(?!\.)/, "./")}";`);
    const calls = callees.map((path, index) => `call${index}();`);
    fixture.put(entrypoint, [...imports, ...calls, "export function execute() {}", ""].join("\n"));
    callees.forEach((callee, index) => chains.push({ entrypoint, steps: [{ caller: entrypoint, line: imports.length + index + 1, callee, symbol: "execute" }] }));
  }
  const competitorRoot = "supabase/functions/competitor-snapshot-sync/index.ts";
  fixture.put(competitorRoot, readFileSync(join(fixture.root, competitorRoot), "utf8") + "const ports = { createServiceWorker: () => ({ paidFallback: { enabled: false } }) };\nexecute(ports);\n");
  const required = [
    CHECKER.slice(ROOT.length).replaceAll("\\", "/"), "scripts/check-instagram-release-gates.test.mjs", "scripts/check-instagram-owner-analytics-gates.mjs",
    "e2e/fixtures/instagramRelease.ts", "e2e/fixtures/instagramReleaseSeed.ts", "e2e/fixtures/instagramReleaseServer.ts", "e2e/fixtures/instagramReleaseSafety.test.ts",
    "e2e/fixtures/competitorTracking.ts", "e2e/analytics.spec.ts", "playwright.instagram-release.config.ts",
    "supabase/functions/brand-scrape/releaseContract.test.ts", "supabase/functions/n8n-api/instagramReleaseContract.test.ts",
    "docs/journeys/2026-10-26-instagram-insights-and-competitor-tracking.md", "docs/runbooks/instagram-insights-release.md", "docs/runbooks/competitor-tracking-retention.md",
    "docs/plans/2026-10-30-instagram-release-gates.md", "docs/specs/2026-10-30-instagram-collection-rollout-controls.md", "docs/plans/2026-10-30-instagram-collection-rollout-controls.md",
    "supabase/tests/README.md", "scripts/db-harness.sh", "supabase/config.toml", "package.json", "package-lock.json", ".github/workflows/ci.yml", "src/i18n/locales/ar/analytics.json",
  ];
  required.forEach((path) => fixture.put(path, "// synthetic retained source\n"));
  fixture.put(".gitignore", ".evidence/\n");
  fixture.put(".github/CODEOWNERS", "* @release-owner\n");
  fixture.commit();
  const workflow = [
    "name: Instagram migration gate", "on:", "  pull_request_target: {}", "  push:", "    branches: [main]", "permissions:", "  contents: read", "jobs:",
    "  check:", "    runs-on: ubuntu-latest", "    environment: release-gate", "    steps:", "      - uses: actions/checkout@v4", "        with:", "          fetch-depth: 0",
    "          ref: ${{ github.event.pull_request.base.sha || github.sha }}", "      - name: gate-app-context", "        if: github.event_name == 'pull_request_target'", "        env:", "          GATE_KEY: ${{ secrets.INSTAGRAM_GATE_APP_KEY }}",
    "        run: node scripts/check-instagram-release-gates.mjs --gate migrations --main-ref origin/main --event pull_request_target --candidate $CANDIDATE --head '${{ github.event.pull_request.head.sha }}'",
    "      - name: protected push gate", "        if: github.event_name == 'push'", "        run: node scripts/check-instagram-release-gates.mjs --gate migrations --main-ref origin/main --event push --head '${{ github.sha }}'",
  ].join("\n");
  fixture.put(WORKFLOW, workflow);
  customize(fixture);
  const candidate = fixture.commit();
  fixture.git("update-ref", "refs/remotes/origin/main", candidate);
  const tree = fixture.git("rev-parse", `${candidate}^{tree}`);
  const artifact = (name, bytes) => { const path = join(fixture.root, ".evidence", name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); return { path, sha256: digest(bytes) }; };
  const review = artifact("review.txt", "Synthetic reviewed proof receipt; not actual release or live evidence.\n");
  const rows = [...SPEC_TEXT.matchAll(/^\| ([DAIHSUEJ]\d+|T8-\d{2}) \| ([\w-]+) \|/gm)].map((match) => ({ id: match[1], inventoryStatus: match[2] }));
  const report = { errors: [], suites: [{ specs: rows.map((row) => ({
    title: `${row.id} synthetic acceptance`, file: "e2e/analytics.spec.ts", ok: true,
    tests: [{ projectName: "chromium", expectedStatus: "passed", status: "expected", results: [{ status: "passed", errors: [] }] }],
  })) }], stats: { expected: rows.length, skipped: 0, unexpected: 0, flaky: 0 } };
  const browser = artifact("playwright.json", JSON.stringify(report));
  const source = { path: "e2e/analytics.spec.ts", sha256: digest(fixture.git("show", `${candidate}:e2e/analytics.spec.ts`) + "\n") };
  const proofs = rows.map((row) => ({ id: row.id, candidate, tree, testTitle: `${row.id} synthetic acceptance`, source,
    command: "npx playwright test --project=chromium", version: "synthetic-fixture-1", exit: 0, status: "passed", environment: "local", reviewer: "Synthetic reviewer", artifact: browser,
    skipped: 0, flaky: 0, failures: 0, attempts: 1, reporter: "playwright", project: "chromium" }));
  const ledger = {
    formatVersion: 1, scope: "instagram-task11-release-gates", baseline: fixture.baseline, candidate, tree, inventoryReview: { artifact: review, reviewer: "Synthetic reviewer" },
    acceptance: rows.map((row) => ({ ...row, requiredTests: [{ file: source.path, title: `${row.id} synthetic acceptance`, project: "chromium" }], proofIds: [row.id], blocker: null, resolution: { artifact: review, reviewer: "Synthetic reviewer" } })),
    proofs: [...proofs, { ...proofs[0], id: "hosted", environment: "hosted" }], artifacts: [],
    runtimeCallers: chains.map((chain) => ({ ...chain, artifact: review, reviewer: "Synthetic reviewer" })),
    migrationSnapshots: fixture.evaluate().migrationSnapshots,
    dependencies: ["Task 2", "Task 6", "Task 8", "Task 9", "Task 10", "collection rollout controls", "D8/A6/I3 decision"].map((name) => ({ name, status: "resolved", artifact: review, reviewer: "Synthetic reviewer" })),
    reviews: ["architecture", "clean-code-guard", "test-guard", "docs-guard", "independent review", "negative control", "rollback"].map((name) => ({ name, status: "passed", artifact: review, reviewer: "Synthetic reviewer", version: "fixture-1", scope: candidate })),
    hosted: { proofIds: ["hosted"] },
    bootstrap: { artifact: review, reviewer: "Synthetic reviewer", branchProtection: { upToDate: true, requiredContext: "gate-app-context", expectedAppId: "fixture-app", squashOnly: true, codeOwnerReview: true, administratorBypass: false, dismissStale: true },
      app: { id: "fixture-app", context: "gate-app-context", statusesWriteOnly: true, privateKeySecret: "INSTAGRAM_GATE_APP_KEY" }, environment: { name: "release-gate", defaultBranchOnly: true }, publicRepository: true, eventPolicy: { workflow: WORKFLOW, pullRequestTargetAllowed: true } },
    live: { status: "pending", approvals: [] },
  };
  const inventory = fixture.evaluate({ gate: undefined, evidence: ledger });
  for (const missing of inventory.failures.filter((entry) => entry.code === "source_manifest_incomplete")) ledger.artifacts.push({ path: missing.detail, sha256: digest(execFileSync("git", ["-C", fixture.root, "show", `${candidate}:${missing.detail}`])) });
  ledger.inventoryReview.artifact = artifact("inventory.json", JSON.stringify({ formatVersion: 1, baseline: ledger.baseline, candidate, tree,
    acceptance: ledger.acceptance.map(({ id, requiredTests }) => ({ id, requiredTests })), fixtureSchema: ledger.artifacts.find((file) => file.path === "e2e/fixtures/instagramReleaseSeed.ts") }));
  const evaluate = (options = {}) => fixture.evaluate({ gate: undefined, evidence: ledger, ...options });
  return { ...fixture, evaluate, ledger, report, artifact, browser, review, candidate, workflow };
}

test("real canonical catalogue contains 66 source and 12 Task 8 requirements without treating inventory as execution", (context) => {
  const fixture = repository(context);
  const report = fixture.evaluate({ gate: undefined, phase: "local" });
  assert.equal(report.acceptance.length, 78);
  assert.equal(report.acceptance.filter((row) => row.id.startsWith("T8-")).length, 12);
  assert.ok(report.acceptance.every((row) => row.execution === "missing"));
  assert.equal(report.localReady, false);
  assert.equal(report.releaseReady, false);
  assert.ok(codes(report).includes("evidence_missing"));
});

for (const [scenario, change, expected] of [
  ["missing source ID", (text) => text.replace(/^\| D1 \|.*\r?\n/m, ""), "acceptance_inventory_mismatch"],
  ["duplicated source ID", (text) => text.replace(/^\| D1 \|.*$/m, (row) => `${row}\n${row}`), "acceptance_id_duplicate"],
  ["missing Task 8 ID", (text) => text.replace(/^\| T8-12 \|.*\r?\n/m, ""), "acceptance_inventory_mismatch"],
  ["unknown inventory status", (text) => text.replace("| D1 | blocked-on-dependency |", "| D1 | passed |"), "inventory_status_invalid"],
]) {
  test(`${scenario} in the committed Markdown fails closed`, (context) => {
    const fixture = repository(context);
    fixture.put(SPEC, change(SPEC_TEXT));
    fixture.commit();
    assert.ok(codes(fixture.evaluate({ gate: undefined })).includes(expected));
  });
}

test("pre-bootstrap local inventory names activation gap, while migration/release gates fail", (context) => {
  const fixture = repository(context);
  const local = fixture.evaluate({ gate: undefined, phase: "local" });
  assert.ok(local.blocked.some((gap) => gap.code === "activation_unresolved"));
  assert.ok(fixture.evaluate().failures.some((gap) => gap.code === "activation_unresolved"));
  assert.ok(fixture.evaluate({ gate: undefined, phase: "release" }).failures.some((gap) => gap.code === "activation_unresolved"));
});

test("unresolvable main ref is a named failure, never an empty history", (context) => {
  const fixture = repository(context);
  assert.ok(codes(fixture.evaluate({ mainRef: "missing-main" })).includes("main_ref_unresolved"));
});

test("member snapshots use their merge parents despite newer unrelated migrations and baseline regeneration", (context) => {
  const fixture = repository(context);
  fixture.activate();
  fixture.put("supabase/migrations/20261101000000_unrelated.sql", "-- later\n");
  fixture.put(BASELINE, "-- BASELINE_MIGRATION: 20261101000000_unrelated.sql\n");
  const tip = fixture.commit();
  fixture.git("update-ref", "refs/remotes/origin/main", tip);
  const report = fixture.evaluate();
  assert.equal(report.migrationSnapshots.R1.commit, fixture.baseline);
  assert.equal(report.migrationSnapshots.R1.newestVersion, "20261030130000");
  assert.ok(!codes(report).includes("member_snapshot_stale"));
  assert.ok(!codes(report).includes("member_stale_version"));
  assert.equal(report.conclusion, "neutral");
});

for (const mutation of ["edit", "delete", "rename", "readd"]) {
  test(`post-activation migration ${mutation} remains latched after restoration`, (context) => {
    const fixture = repository(context);
    fixture.activate();
    const path = `supabase/migrations/${MEMBERS[0]}`;
    if (mutation === "edit") fixture.put(path, "-- altered\n");
    else if (mutation === "rename") fixture.git("mv", path, path.replace(".sql", "_renamed.sql"));
    else fixture.git("rm", path);
    fixture.commit();
    if (mutation === "rename") fixture.git("mv", path.replace(".sql", "_renamed.sql"), path);
    else fixture.put(path, mutation === "readd" ? "-- different bytes\n" : "-- synthetic series member\n");
    const tip = fixture.commit();
    fixture.git("update-ref", "refs/remotes/origin/main", tip);
    assert.ok(codes(fixture.evaluate()).includes("member_modified_after_merge"));
    assert.ok(codes(fixture.evaluate()).includes("migration_reserved_prefix_violation"));
  });
}

test("collision remains latched when either colliding path is subsequently removed", (context) => {
  const fixture = repository(context);
  fixture.activate();
  const collision = `supabase/migrations/${MEMBERS[0].slice(0, 14)}_collision.sql`;
  fixture.put(collision, "-- duplicate version\n");
  fixture.commit();
  fixture.git("rm", collision);
  const tip = fixture.commit();
  fixture.git("update-ref", "refs/remotes/origin/main", tip);
  assert.ok(codes(fixture.evaluate()).includes("migration_version_collision"));
});

test("collision resolved before activation does not create a historical freeze", (context) => {
  const fixture = repository(context);
  const collision = `supabase/migrations/${MEMBERS[0].slice(0, 14)}_old_collision.sql`;
  fixture.put(collision, "-- old\n"); fixture.commit();
  fixture.git("rm", collision); fixture.commit();
  fixture.activate();
  assert.ok(!codes(fixture.evaluate()).includes("migration_version_collision"));
});

for (const mutation of ["add", "edit", "delete", "rename"]) {
  test(`activation commit cannot ${mutation} a migration`, (context) => {
    const fixture = repository(context);
    const path = `supabase/migrations/${MIGRATIONS[0]}`;
    if (mutation === "add") fixture.put("supabase/migrations/20261101000000_extra.sql", "-- extra\n");
    if (mutation === "edit") fixture.put(path, "-- changed\n");
    if (mutation === "delete") fixture.git("rm", path);
    if (mutation === "rename") fixture.git("mv", path, path.replace(".sql", "_renamed.sql"));
    fixture.activate();
    assert.ok(fixture.evaluate().failures.some((gap) => gap.code === "activation_unresolved"));
  });
}

test("deleting and readding workflow cannot move the activation boundary", (context) => {
  const fixture = repository(context);
  const activation = fixture.activate();
  fixture.git("rm", WORKFLOW); fixture.commit();
  fixture.put(`supabase/migrations/${MIGRATIONS[0]}`, "-- changed after first activation\n"); fixture.commit();
  fixture.activate();
  const report = fixture.evaluate();
  assert.equal(report.activation, activation);
  assert.ok(codes(report).includes("migration_reserved_prefix_violation"));
});

test("CLI rejects absent mandatory ref and rejects malformed evidence without exposing its bytes", (context) => {
  const fixture = repository(context);
  const evidence = join(fixture.root, "evidence.json");
  writeFileSync(evidence, "not JSON: private synthetic content");
  const run = (...args) => spawnSync(process.execPath, [CHECKER, "--spec", SPEC, ...args], { cwd: fixture.root, encoding: "utf8" });
  assert.equal(run("--phase", "local").status, 1);
  const invalid = run("--phase", "local", "--main-ref", "origin/main", "--evidence", evidence);
  assert.equal(invalid.status, 1);
  assert.ok(!invalid.stdout.includes("private synthetic content"));
  assert.ok(!invalid.stderr.includes("private synthetic content"));
});

test("complete synthetic ledger retains local bookkeeping while executable bootstrap and live approval remain pending", (context) => {
  const fixture = fullLedger(context);
  const report = fixture.evaluate();
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.blocked.map((entry) => entry.code), ["migration_workflow_execution_unverified"]);
  assert.equal(report.acceptance.filter((row) => row.execution === "passed").length, 78);
  assert.equal(report.localReady, false);
  assert.equal(report.releaseReady, false);
  assert.equal(report.productionActivationAuthorized, false);
  assert.ok(report.pendingEvidence.some((entry) => entry.includes("G-L")));
  fixture.ledger.hosted.proofIds = [];
  assert.deepEqual(fixture.evaluate().blocked.map((entry) => entry.code), ["migration_workflow_execution_unverified"]);
  const release = fixture.evaluate({ phase: "release" });
  assert.equal(release.releaseReady, false);
  assert.ok(codes(release).includes("hosted_evidence_pending"));
  assert.ok(codes(release).includes("live_evidence_pending"));
});

function executionReceipt(proof, changes = {}) {
  return { formatVersion: 1, scope: "instagram-release-execution",
    ...Object.fromEntries(Object.entries(proof).filter(([key]) => !["artifact", "reporter"].includes(key))), ...changes };
}

test("execution receipts must contain the claimed result instead of arbitrary matching-hash bytes", async (context) => {
  const fixture = fullLedger(context);
  for (const [scenario, body, expected] of [
    ["ordinary reviewed text", "Reviewed, therefore passed", "report_json_invalid"],
    ["unrelated JSON", JSON.stringify({ passed: true }), "execution_receipt_invalid"],
    ["different command", JSON.stringify(executionReceipt(fixture.ledger.proofs[0], { command: "true" })), "execution_receipt_mismatch"],
    ["different source", JSON.stringify(executionReceipt(fixture.ledger.proofs[0], { source: { path: "unrelated.ts", sha256: "0".repeat(64) } })), "execution_receipt_mismatch"],
    ["hidden retry", JSON.stringify(executionReceipt(fixture.ledger.proofs[0], { attempts: 2 })), "execution_receipt_mismatch"],
  ]) await context.test(scenario, () => {
    const ledger = structuredClone(fixture.ledger);
    ledger.proofs[0].reporter = "receipt";
    ledger.proofs[0].artifact = fixture.artifact("execution.json", body);
    assert.ok(codes(fixture.evaluate({ evidence: ledger })).includes(expected));
  });
});

test("fabricated matching receipts and approvals never establish authenticated release origin", (context) => {
  const fixture = fullLedger(context);
  const ledger = structuredClone(fixture.ledger);
  const proof = { ...ledger.proofs[0], reporter: "receipt" };
  proof.artifact = fixture.artifact("local-execution.json", JSON.stringify(executionReceipt(proof)));
  ledger.proofs[0] = proof;
  const local = fixture.evaluate({ evidence: ledger });
  assert.equal(local.acceptance[0].execution, "passed");
  assert.deepEqual(local.blocked.map((entry) => entry.code), ["migration_workflow_execution_unverified"]);
  ledger.live = { status: "passed", approvals: ["B1", "B2", "B3", "C1", "C2", "C3", "D1", "D2", "D3", "E1", "E2", "E3-dry-run", "E3-enable", "E4"].map((action, index) => {
    const liveProof = { ...proof, id: `live-${action}`, environment: "live", command: "node production-read-only-probe.mjs" };
    liveProof.artifact = fixture.artifact(`live-${action}.json`, JSON.stringify(executionReceipt(liveProof)));
    ledger.proofs.push(liveProof);
    return { action, candidate: ledger.candidate, tree: ledger.tree, reference: `synthetic-${action}`, approver: "Waleed",
      timestamp: `2026-11-01T00:00:${String(index).padStart(2, "0")}Z`, operator: "Synthetic operator", configuration: "Synthetic configuration",
      accounts: ["opaque-fixture-target"], proofIds: [liveProof.id], artifact: fixture.review };
  }) };
  const report = fixture.evaluate({ phase: "release", evidence: ledger });
  assert.equal(report.releaseReady, false);
  assert.ok(codes(report).includes("evidence_origin_unverified"));
  assert.equal(report.productionActivationAuthorized, false);
});

test("reviewed evidence rejects incomplete, duplicated, failed, skipped, flaky and wrong-scope receipts", async (context) => {
  const fixture = fullLedger(context);
  const original = structuredClone(fixture.ledger);
  for (const [scenario, mutate, expected] of [
    ["missing T8 requirement", (ledger) => { ledger.acceptance = ledger.acceptance.filter((row) => row.id !== "T8-12"); }, "acceptance_evidence_missing"],
    ["duplicated requirement", (ledger) => ledger.acceptance.push(ledger.acceptance[0]), "acceptance_id_duplicate"],
    ["unknown execution status", (ledger) => { ledger.proofs[0].status = "existing"; }, "evidence_schema_invalid"],
    ["stale candidate", (ledger) => { ledger.proofs[0].candidate = fixture.baseline; }, "proof_stale_candidate"],
    ["nonzero execution", (ledger) => { ledger.proofs[0].exit = 1; }, "proof_not_clean"],
    ["skipped execution", (ledger) => { ledger.proofs[0].skipped = 1; }, "proof_not_clean"],
    ["flaky execution", (ledger) => { ledger.proofs[0].flaky = 1; }, "proof_not_clean"],
    ["retry execution", (ledger) => { ledger.proofs[0].attempts = 2; }, "proof_not_clean"],
    ["hosted proof presented as local", (ledger) => { ledger.proofs[0].environment = "hosted"; }, "required_test_unproved"],
    ["duplicate proof", (ledger) => ledger.proofs.push(ledger.proofs[0]), "proof_duplicate"],
    ["absent proof artifact", (ledger) => { ledger.proofs[0].artifact.path = join(fixture.root, "absent.json"); }, "artifact_missing"],
    ["changed proof artifact", (ledger) => { ledger.proofs[0].artifact.sha256 = "0".repeat(64); }, "artifact_hash_mismatch"],
    ["wrong source bytes", (ledger) => { ledger.proofs[0].source.sha256 = "0".repeat(64); }, "proof_wrong_source"],
    ["narrowed frozen title", (ledger) => { ledger.acceptance[0].requiredTests[0].title = "weaker test"; }, "inventory_expectations_changed"],
    ["unresolved dependency", (ledger) => { ledger.dependencies[0].status = "pending"; }, "dependency_unresolved"],
    ["missing actual caller", (ledger) => { ledger.runtimeCallers = []; }, "runtime_caller_missing"],
    ["wrong claimed hosted proof", (ledger) => { ledger.hosted.proofIds = ["D1"]; }, "hosted_evidence_invalid"],
    ["falsely completed live gate", (ledger) => { ledger.live.status = "passed"; }, "live_approval_missing_or_duplicate"],
  ]) await context.test(scenario, () => {
    const ledger = structuredClone(original);
    mutate(ledger);
    assert.ok(codes(fixture.evaluate({ evidence: ledger })).includes(expected), expected);
  });
});

test("native Playwright result and redaction boundaries cannot be overridden by green ledger counters", async (context) => {
  const fixture = fullLedger(context);
  for (const [scenario, mutate, expected] of [
    ["malformed native report", (report) => { report.suites = {}; }, "playwright_report_invalid"],
    ["skipped native test", (report) => { report.stats.skipped = 1; }, "playwright_run_not_clean"],
    ["native retry", (report) => { report.suites[0].specs[0].tests[0].results.push({ status: "passed" }); }, "playwright_run_not_clean"],
    ["wrong native file", (report) => { report.suites[0].specs[0].file = "e2e/unrelated.spec.ts"; }, "proof_wrong_scope"],
    ["wrong native project", (report) => { report.suites[0].specs[0].tests[0].projectName = "firefox"; }, "proof_wrong_scope"],
    ["duplicated native title", (report) => { report.suites[0].specs.push(report.suites[0].specs[0]); report.stats.expected++; }, "proof_wrong_scope"],
  ]) await context.test(scenario, () => {
    const report = structuredClone(fixture.report);
    mutate(report);
    const ledger = structuredClone(fixture.ledger);
    ledger.proofs[0].artifact = fixture.artifact("changed-playwright.json", JSON.stringify(report));
    assert.ok(codes(fixture.evaluate({ evidence: ledger })).includes(expected));
  });
  await context.test("native rootDir-relative filenames retain repository source binding", () => {
    const report = structuredClone(fixture.report);
    report.config = { configFile: "F:/isolated-checkout/playwright.instagram-release.config.ts", rootDir: "F:/isolated-checkout/e2e" };
    report.suites[0].specs.forEach((spec) => { spec.file = "analytics.spec.ts"; });
    const ledger = structuredClone(fixture.ledger);
    const normalized = fixture.artifact("normalized-playwright.json", JSON.stringify(report));
    ledger.proofs.forEach((proof) => { proof.artifact = normalized; });
    const normalizedReport = fixture.evaluate({ evidence: ledger });
    assert.deepEqual(normalizedReport.failures, []);
    assert.equal(normalizedReport.acceptance.filter((row) => row.execution === "passed").length, 78);
    assert.deepEqual(normalizedReport.blocked.map((entry) => entry.code), ["migration_workflow_execution_unverified"]);
  });
  await context.test("credential evidence is rejected without printing its matching bytes", () => {
    const ledger = structuredClone(fixture.ledger);
    ledger.proofs[0].reporter = "receipt";
    ledger.proofs[0].artifact = fixture.artifact("unsafe.txt", 'https://graph.example.test/data?access_token=synthetic-secret');
    const report = fixture.evaluate({ evidence: ledger });
    assert.ok(codes(report).includes("artifact_redaction_failed"));
    assert.ok(!JSON.stringify(report).includes("synthetic-secret"));
  });
  for (const [scheme, credential] of [["postgres userinfo", "postgres://fixture:synthetic-private@db.example.test/database"], ["HTTP userinfo", "https://fixture:synthetic-private@example.test/report"], ["Basic authorization", "Authorization: Basic Zml4dHVyZTpzeW50aGV0aWMtcHJpdmF0ZQ=="]]) {
    await context.test(`${scheme} cannot enter retained evidence`, () => {
      const ledger = structuredClone(fixture.ledger);
      ledger.proofs[0].artifact = fixture.artifact("userinfo.txt", credential);
      const report = fixture.evaluate({ evidence: ledger });
      assert.ok(codes(report).includes("artifact_redaction_failed"));
      assert.ok(!JSON.stringify(report).includes("synthetic-private"));
    });
  }
});

function mergeCandidate(fixture, change) {
  const base = fixture.git("rev-parse", "origin/main");
  change?.();
  const head = fixture.commit();
  const tree = fixture.git("rev-parse", `${head}^{tree}`);
  const candidate = fixture.git("-c", "user.name=Release Gate Test", "-c", "user.email=release@example.test", "commit-tree", tree, "-p", base, "-p", head, "-m", "candidate merge");
  return { base, head, candidate };
}

test("PR gate checks the explicitly passed merge tree and rejects invalid base/head/ref bindings", async (context) => {
  const fixture = repository(context);
  fixture.activate();
  const refs = mergeCandidate(fixture, () => fixture.put("unrelated.txt", "candidate\n"));
  const valid = fixture.evaluate({ event: "pull_request_target", candidate: refs.candidate, head: refs.head });
  assert.equal(valid.conclusion, "neutral");
  for (const [scenario, candidate, head] of [
    ["absent ref", "0".repeat(40), refs.head], ["one parent", refs.head, refs.head], ["wrong head", refs.candidate, refs.base], ["missing explicit merge ref", undefined, refs.head],
  ]) await context.test(scenario, () => assert.ok(codes(fixture.evaluate({ event: "pull_request_target", candidate, head })).includes("candidate_ref_invalid")));
  fixture.git("update-ref", "refs/remotes/origin/main", refs.head);
  assert.ok(codes(fixture.evaluate({ event: "pull_request_target", candidate: refs.candidate, head: refs.head })).includes("candidate_ref_invalid"));
});

test("candidate-only collision fails while protected base stays green, without executing candidate checker", (context) => {
  const fixture = repository(context);
  fixture.activate();
  const refs = mergeCandidate(fixture, () => {
    fixture.put(`supabase/migrations/${MEMBERS[0].slice(0, 14)}_collision.sql`, "-- collision\n");
    fixture.put("scripts/check-instagram-release-gates.mjs", "throw new Error('candidate checker must never execute');\n");
  });
  const candidate = fixture.evaluate({ event: "pull_request_target", candidate: refs.candidate, head: refs.head });
  assert.ok(codes(candidate).includes("migration_version_collision"));
  assert.equal(fixture.evaluate({ candidate: refs.base }).conclusion, "neutral");
});

test("push evaluates the immutable pushed SHA rather than current checkout or a later main tree", (context) => {
  const fixture = repository(context);
  const pushed = fixture.activate();
  fixture.put(`supabase/migrations/${MEMBERS[0]}`, "-- future modification\n");
  const later = fixture.commit();
  fixture.git("update-ref", "refs/remotes/origin/main", later);
  const report = fixture.evaluate({ event: "push", head: pushed });
  assert.equal(report.candidate, pushed);
  assert.equal(report.conclusion, "neutral");
  assert.ok(codes(fixture.evaluate({ event: "push", head: pushed, candidate: pushed })).includes("candidate_ref_invalid"));
});

test("recorded member snapshots are compared by fields and refuse a stale snapshot", (context) => {
  const fixture = repository(context);
  fixture.activate();
  const actual = fixture.evaluate().migrationSnapshots;
  const reordered = Object.fromEntries(Object.entries(actual).map(([member, fields]) => [member, { marker: fields.marker, commit: fields.commit, newestVersion: fields.newestVersion }]));
  assert.equal(fixture.evaluate({ evidence: { migrationSnapshots: reordered } }).conclusion, "passed");
  reordered.R1.newestVersion = "20261030120000";
  assert.ok(codes(fixture.evaluate({ evidence: { migrationSnapshots: reordered } })).includes("member_snapshot_mismatch"));
});

test("manifest Inventory state edits pass but assigned version/order/suffix rewrites fail", async (context) => {
  const fixture = repository(context);
  fixture.activate();
  const refs = mergeCandidate(fixture, () => fixture.put(SPEC, SPEC_TEXT.replace("existing; in inspected main", "existing; inspected again")));
  assert.equal(fixture.evaluate({ event: "pull_request_target", ...refs }).conclusion, "neutral");
  for (const [scenario, source] of [
    ["version", SPEC_TEXT.replace(MEMBERS[0], MEMBERS[0].replace("20261031090000", "20261031090100"))],
    ["order", SPEC_TEXT.replace("16 / R1", "19 / R1")],
    ["suffix", SPEC_TEXT.replace(MEMBERS[0], MEMBERS[0].replace("rollout_controls", "other_controls"))],
  ]) await context.test(scenario, () => {
    fixture.put(SPEC, source);
    const head = fixture.commit();
    const candidate = fixture.git("-c", "user.name=Release Gate Test", "-c", "user.email=release@example.test", "commit-tree", fixture.git("rev-parse", `${head}^{tree}`), "-p", refs.base, "-p", head, "-m", "candidate");
    const report = fixture.evaluate({ event: "pull_request_target", candidate, head });
    assert.ok(codes(report).includes(scenario === "suffix" ? "migration_manifest_invalid" : "manifest_rewritten"));
  });
});

test("unassigned member can only acquire its own added migration, and cannot alter its gate in the same PR", (context) => {
  const fixture = repository(context, { unassigned: true });
  fixture.activate();
  const base = fixture.git("rev-parse", "origin/main");
  const baseSpec = fixture.git("show", `${base}:${SPEC}`);
  const refs = mergeCandidate(fixture, () => {
    fixture.put(`supabase/migrations/${MEMBERS[0]}`, "-- new member\n");
    fixture.put(SPEC, baseSpec.replace(`*unassigned*${MEMBERS[0].slice(14)}`, MEMBERS[0]));
  });
  assert.equal(fixture.evaluate({ event: "pull_request_target", ...refs }).conclusion, "neutral");
  fixture.put(".github/workflows/ci.yml", "name: weakened\n");
  const head = fixture.commit();
  const candidate = fixture.git("-c", "user.name=Release Gate Test", "-c", "user.email=release@example.test", "commit-tree", fixture.git("rev-parse", `${head}^{tree}`), "-p", base, "-p", head, "-m", "candidate");
  assert.ok(codes(fixture.evaluate({ event: "pull_request_target", candidate, head })).includes("gate_self_modification"));
});

test("unmerged members are blocked locally and fail the release phase", (context) => {
  const fixture = repository(context, { unassigned: true });
  fixture.activate();
  const local = fixture.evaluate({ gate: undefined, phase: "local" });
  const release = fixture.evaluate({ gate: undefined, phase: "release" });
  assert.ok(local.blocked.some((gap) => gap.code === "member_not_on_main"));
  assert.ok(release.failures.some((gap) => gap.code === "member_not_on_main"));
  assert.equal(release.releaseReady, false);
});

test("a workflow rename destination establishes the original activation boundary", (context) => {
  const fixture = repository(context);
  fixture.put(".github/workflows/gate-draft.yml", "name: migration gate\n");
  fixture.commit();
  fixture.git("mv", ".github/workflows/gate-draft.yml", WORKFLOW);
  const activation = fixture.commit();
  fixture.git("update-ref", "refs/remotes/origin/main", activation);
  const report = fixture.evaluate();
  assert.equal(report.activation, activation);
  assert.equal(report.conclusion, "neutral");
});

test("deleting a migration cannot make its reserved version available to a new path", (context) => {
  const fixture = repository(context);
  fixture.activate();
  const original = "supabase/migrations/20261102000000_original.sql";
  fixture.put(original, "-- reserved bytes\n");
  fixture.commit();
  fixture.git("rm", original);
  fixture.commit();
  fixture.put(original.replace("original", "replacement"), "-- different bytes\n");
  const head = fixture.commit();
  fixture.git("update-ref", "refs/remotes/origin/main", head);
  assert.ok(codes(fixture.evaluate()).includes("migration_reserved_prefix_violation"));
});

test("a post-activation collision remains failed after either path is renamed or deleted", async (context) => {
  for (const target of ["original", "collision"]) for (const operation of ["delete", "rename"]) {
    await context.test(`${target} ${operation}`, () => {
      const fixture = repository(context);
      fixture.activate();
      const collision = `supabase/migrations/${MEMBERS[0].slice(0, 14)}_collision.sql`;
      fixture.put(collision, "-- duplicate version\n");
      fixture.commit();
      const path = target === "original" ? `supabase/migrations/${MEMBERS[0]}` : collision;
      if (operation === "delete") fixture.git("rm", path);
      else fixture.git("mv", path, path.replace(".sql", "_renamed.sql"));
      const head = fixture.commit();
      fixture.git("update-ref", "refs/remotes/origin/main", head);
      assert.ok(codes(fixture.evaluate()).includes("migration_version_collision"));
    });
  }
});

test("claimed bootstrap receipts cannot override unsafe committed workflow behavior", async (context) => {
  for (const [scenario, rewrite, expected] of [
    ["candidate-code trigger", (source) => source.replace("pull_request_target: {}", "pull_request: {}"), "migration_workflow_invalid"],
    ["elevated repository token", (source) => source.replace("contents: read", "contents: write"), "migration_workflow_permissions"],
    ["unapproved secret", (source) => source.replace("secrets.INSTAGRAM_GATE_APP_KEY", "secrets.OTHER_KEY"), "migration_workflow_secret"],
    ["candidate checkout", (source) => source.replace("github.event.pull_request.base.sha || github.sha", "github.event.pull_request.head.sha"), "migration_workflow_checkout"],
    ["dummy protected job before untrusted head job", (source) => source + "\n  attack:\n    environment: release-gate\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n      - run: npm test\n", "migration_workflow_execution"],
    ["head checkout after protected checkout", (source) => source + "\n      - uses: actions/checkout@v4\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n", "migration_workflow_checkout"],
    ["head execution after dummy base checkout", (source) => source + "\n      - run: git checkout $CANDIDATE && npm test\n", "migration_workflow_execution"],
    ["local action execution", (source) => source + "\n      - uses: ./.github/actions/from-candidate\n", "migration_workflow_execution"],
    ["checker secret environment belongs to another job", (source) => source.replace("    environment: release-gate\n", "") + "\n  dummy:\n    environment: release-gate\n    steps: []\n", "migration_workflow_execution"],
    ["markers in comments cannot certify a different command", (source) => source.replace("run: node scripts/check-instagram-release-gates.mjs", "# node scripts/check-instagram-release-gates.mjs\n        run: npm test #"), "migration_workflow_dispatch"],
    ["runtime preload cannot execute before protected checker", (source) => source.replace("          GATE_KEY:", "          NODE_OPTIONS: --require ./candidate.js\n          GATE_KEY:"), "migration_workflow_execution"],
    ["custom shell cannot replace the protected command", (source) => source.replace("        env:", "        shell: bash -c 'npm test; {0}'\n        env:"), "migration_workflow_execution"],
  ]) await context.test(scenario, () => {
    const fixture = fullLedger(context, (draft) => draft.put(WORKFLOW, rewrite(readFileSync(join(draft.root, WORKFLOW), "utf8"))));
    assert.ok(codes(fixture.evaluate()).includes(expected));
  });
});

test("type-only imports, declarations and comments cannot certify runtime consumers", (context) => {
  const invalid = [
    ["supabase/functions/instagram-insights-report/assemble.ts", "export interface execute {}\n"],
    ["supabase/functions/instagram-insights-sync/worker.ts", "export declare function execute(): void;\n"],
    ["supabase/functions/competitor-retention/run.ts", "// execute() is documented, but no implementation exists.\n"],
  ];
  const fixture = fullLedger(context, (draft) => {
    for (const [path, source] of invalid) draft.put(path, source);
    const path = "supabase/functions/instagram-insights-sync/index.ts";
    const source = readFileSync(join(draft.root, path), "utf8");
    const statement = source.match(/^import \{[^\n]+directGraphProvider\.ts";/m)?.[0];
    assert.ok(statement, "fixture must contain the actual direct-provider import");
    draft.put(path, source.replace(statement, statement.replace("import {", "import type {")));
  });
  const failures = fixture.evaluate().failures.filter((gap) => gap.code === "runtime_call_missing");
  for (const [path] of invalid) assert.ok(failures.some((gap) => gap.detail.includes(path)), path);
  assert.ok(failures.some((gap) => gap.detail.includes("directGraphProvider.ts")));
});

test("scheduled paid fallback requires a literal disabled policy without spreads", async (context) => {
  for (const policy of ["{ enabled: true }", "{ ...externalPolicy, enabled: false }"]) {
    await context.test(policy, () => {
      const fixture = fullLedger(context, (draft) => {
        const path = "supabase/functions/competitor-snapshot-sync/index.ts";
        const source = readFileSync(join(draft.root, path), "utf8");
        draft.put(path, source.replace("paidFallback: { enabled: false }", `paidFallback: ${policy}`));
      });
      assert.ok(codes(fixture.evaluate()).includes("scheduled_apify_policy_unproved"));
    });
  }
});
