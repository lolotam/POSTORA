import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyComparisonOutcome,
  assertSafeTemp,
  classifyEslintRun,
  classifyI18nRun,
  compareAnalyzer,
  compareDiagnostics,
  compileGlob,
  eslintLockPins,
  eslintPackageSpecifiers,
  gateDecision,
  i18nToFindings,
  loadCleanManifest,
  matchesAnyGlob,
  normalizeEslintReport,
  parseNameStatusZ,
  parseUnifiedDiff,
  readTreeDiff,
  renderSummary,
  selectBaseline,
  sha256Text,
  sliceSource,
  STRUCTURED_END,
  STRUCTURED_START,
  stripStructuredRegion,
} from "./lint-i18n-regression.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const CHECKER = join(REPO, "scripts", "check-i18n-coverage.mjs");
const ZERO = "0".repeat(40);
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const OTHER = "c".repeat(40);
// LF-normalized scripts/check-i18n-coverage.mjs at 4d1a16c390e38e08b45a309e298c72d9af749a2e.
// That blob has no structured region, so the hash is the detection text.
const IMMUTABLE_DETECTION_SHA256 = "e0fcbb4f182f71e285bea9bd5181e51c63a89501093f6ce0a8b040b70e0a6717";

function lintFinding(overrides) {
  return {
    kind: "lint",
    path: "src/a.ts",
    rule: "no-unused-vars",
    severity: 2,
    message: "'bad' is defined but never used.",
    anchor: "bad",
    line: 1,
    column: 7,
    category: null,
    locale: null,
    namespace: null,
    key: null,
    ...overrides,
  };
}

function i18nFinding(overrides) {
  return {
    kind: "i18n",
    path: "src/Old.tsx",
    rule: null,
    severity: null,
    message: null,
    anchor: 't("missing")',
    line: 4,
    column: 3,
    category: "MISSING",
    locale: "ar",
    namespace: "common",
    key: "missing",
    ...overrides,
  };
}

function diff(overrides = {}) {
  return {
    renames: [],
    added: new Set(),
    deleted: new Set(),
    changed: new Map(),
    suppressions: [],
    ambiguous: null,
    ...overrides,
  };
}

function manifestGlobs() {
  return loadCleanManifest(readFileSync(join(HERE, "feature-clean-manifest.json"), "utf8"));
}

function ownedTemp() {
  const dir = mkdtempSync(join(tmpdir(), "postora-lint-i18n-test-"));
  assertSafeTemp(dir);
  return dir;
}

function matchingAnalyzer(overrides = {}) {
  const pkg = JSON.stringify({ devDependencies: { eslint: "^9.32.0", globals: "^15.0.0" } });
  const lock = JSON.stringify({
    packages: {
      "node_modules/eslint": { version: "9.32.0", integrity: "sha-a" },
      "node_modules/@eslint/js": { version: "9.32.0", integrity: "sha-b" },
      "node_modules/typescript-eslint": { version: "8.38.0", integrity: "sha-c" },
      "node_modules/@typescript-eslint/eslint-plugin": { version: "8.38.0", integrity: "sha-d" },
      "node_modules/@typescript-eslint/parser": { version: "8.38.0", integrity: "sha-e" },
      "node_modules/eslint-plugin-react-hooks": { version: "5.2.0", integrity: "sha-f" },
      "node_modules/eslint-plugin-react-refresh": { version: "0.4.20", integrity: "sha-g" },
      "node_modules/globals": { version: "15.15.0", integrity: "sha-h" },
    },
  });
  return compareAnalyzer({
    baseConfig: "same",
    headConfig: "same",
    executedConfig: "same",
    mergeConfig: "same",
    baseIgnore: "",
    headIgnore: "",
    basePackageJson: pkg,
    headPackageJson: pkg,
    baseLock: lock,
    headLock: lock,
    baseChecker: "detector\n",
    headChecker: "detector\n",
    executedChecker: "detector\n",
    mergeChecker: "detector\n",
    installedEslintVersion: "9.32.0",
    ...overrides,
  });
}

function toolRun(lintFindings, i18nFindings = []) {
  return {
    lintFindings,
    i18nFindings,
    counts: {
      lint: {
        exitCode: lintFindings.length > 0 ? 1 : 0,
        errorCount: lintFindings.length,
        warningCount: 0,
        fileCount: 1,
      },
      i18n: {
        exitCode: i18nFindings.length > 0 ? 1 : 0,
        failureCount: i18nFindings.length,
        callsiteCount: i18nFindings.length,
      },
    },
  };
}

function git(repo, args) {
  const result = spawnSync("git", ["-c", "core.autocrlf=false", "-c", "user.name=lint-i18n", "-c", "user.email=lint-i18n@example.invalid", ...args], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

describe("baseline selection", () => {
  test("pull request uses the event SHAs and rejects a self baseline", () => {
    const selected = selectBaseline({ eventName: "pull_request", baseSha: BASE, headSha: HEAD });
    assert.equal(selected.ok, true);
    assert.equal(selected.mode, "pull_request_event_base");
    assert.equal(selectBaseline({ eventName: "pull_request", baseSha: HEAD, headSha: HEAD }).reason, "self_baseline");
    assert.equal(selectBaseline({ eventName: "pull_request", baseSha: "", headSha: HEAD }).reason, "invalid_base");
    assert.equal(selectBaseline({ eventName: "pull_request", baseSha: ZERO, headSha: HEAD }).reason, "invalid_base");
  });

  test("branch push uses the merge-base and main push uses the previous tip", () => {
    const branch = selectBaseline({ eventName: "push", refName: "refs/heads/feat/instagram-insights-competitors", headSha: HEAD, mergeBaseSha: BASE });
    assert.equal(branch.mode, "push_merge_base");
    assert.equal(selectBaseline({ eventName: "push", refName: "refs/heads/feat/x", headSha: HEAD, mergeBaseSha: HEAD }).reason, "self_baseline");
    assert.equal(selectBaseline({ eventName: "push", refName: "refs/heads/feat/x", headSha: HEAD }).reason, "invalid_base");
    const main = selectBaseline({ eventName: "push", refName: "refs/heads/main", headSha: HEAD, beforeSha: OTHER });
    assert.equal(main.mode, "push_main_before");
    assert.equal(selectBaseline({ eventName: "push", refName: "refs/heads/main", headSha: HEAD, beforeSha: ZERO }).reason, "invalid_base");
  });
});

describe("diagnostic comparison", () => {
  const clean = { cleanPathGlobs: [], cleanNamespaces: [] };

  test("equal-count replacement is a regression", () => {
    const result = compareDiagnostics({
      baseFindings: [lintFinding()],
      headFindings: [lintFinding({ rule: "no-undef", message: "'bad' is not defined.", anchor: "bad" })],
      diff: diff(),
      ...clean,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "new_diagnostics");
    assert.equal(result.newDiagnostics.length, 1);
    assert.equal(result.resolvedDiagnostics.length, 1);
    assert.equal(result.newDiagnostics[0].rule, "no-undef");
  });

  test("duplicating the same offending token increments the multiset", () => {
    const result = compareDiagnostics({
      baseFindings: [lintFinding({ line: 1 })],
      headFindings: [lintFinding({ line: 1 }), lintFinding({ line: 8 })],
      diff: diff(),
      ...clean,
    });
    assert.equal(result.ok, false);
    assert.equal(result.newDiagnostics.length, 1);
    assert.equal(result.newDiagnostics[0].anchor, "bad");
  });

  test("anchor drift without a changed construct is inherited", () => {
    const result = compareDiagnostics({
      baseFindings: [lintFinding({ line: 2 })],
      headFindings: [lintFinding({ line: 40 })],
      diff: diff({ changed: new Map([["src/a.ts", new Set([1])]]) }),
      ...clean,
    });
    assert.equal(result.ok, true);
    assert.equal(result.newDiagnostics.length, 0);
    assert.equal(result.resolvedDiagnostics.length, 0);
  });

  test("a modified offending construct is not inherited", () => {
    const result = compareDiagnostics({
      baseFindings: [lintFinding({ line: 4, anchor: "bad" })],
      headFindings: [lintFinding({ line: 4, anchor: "bad" })],
      diff: diff({ changed: new Map([["src/a.ts", new Set([4])]]) }),
      ...clean,
    });
    assert.equal(result.ok, false);
    assert.equal(result.newDiagnostics.length, 1);
    assert.equal(result.resolvedDiagnostics.length, 1);
  });

  test("rename keeps the diagnostic and a move into a feature path still fails", () => {
    const renamed = diff({ renames: [{ from: "src/legacy/Bad.ts", to: "src/moved/Bad.ts", score: 100 }] });
    const inherited = compareDiagnostics({
      baseFindings: [lintFinding({ path: "src/legacy/Bad.ts" })],
      headFindings: [lintFinding({ path: "src/moved/Bad.ts" })],
      diff: renamed,
      ...clean,
    });
    assert.equal(inherited.ok, true);
    const moved = compareDiagnostics({
      baseFindings: [lintFinding({ path: "src/legacy/Bad.ts" })],
      headFindings: [lintFinding({ path: "src/features/instagram-insights/ui/Bad.tsx" })],
      diff: diff({ renames: [{ from: "src/legacy/Bad.ts", to: "src/features/instagram-insights/ui/Bad.tsx", score: 100 }] }),
      cleanPathGlobs: manifestGlobs().cleanPathGlobs,
      cleanNamespaces: [],
    });
    assert.equal(moved.ok, false);
    assert.equal(moved.reason, "feature_path_dirty");
    assert.equal(moved.featurePathViolations.length, 1);
  });

  test("an ambiguous rename is not paired in a way that hides a new diagnostic", () => {
    const names = parseNameStatusZ("R100\0src/a.ts\0src/c.ts\0R90\0src/b.ts\0src/c.ts\0");
    assert.ok(names.ambiguous);
    const result = compareDiagnostics({
      baseFindings: [lintFinding({ path: "src/a.ts" }), lintFinding({ path: "src/b.ts", anchor: "other" })],
      headFindings: [lintFinding({ path: "src/c.ts" })],
      diff: diff({ ambiguous: names.ambiguous }),
      ...clean,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "ambiguous_diff");
  });

  test("a new callsite of an already-missing key is a regression", () => {
    const result = compareDiagnostics({
      baseFindings: [i18nFinding()],
      headFindings: [
        i18nFinding(),
        i18nFinding({ path: "src/features/instagram-insights/ui/Page.tsx", line: 12 }),
      ],
      diff: diff({ added: new Set(["src/features/instagram-insights/ui/Page.tsx"]) }),
      cleanPathGlobs: manifestGlobs().cleanPathGlobs,
      cleanNamespaces: manifestGlobs().cleanI18nNamespaces,
    });
    assert.equal(result.ok, false);
    assert.equal(result.newDiagnostics.some((finding) => finding.path.endsWith("Page.tsx")), true);
    assert.equal(result.featurePathViolations.length, 1);
  });

  test("the analytics namespace cannot carry a finding", () => {
    const result = compareDiagnostics({
      baseFindings: [],
      headFindings: [i18nFinding({ path: "src/pages/Analytics.tsx", namespace: "analytics", key: "fresh", anchor: 't("fresh")' })],
      diff: diff({ changed: new Map([["src/pages/Analytics.tsx", new Set([2])]]) }),
      cleanPathGlobs: [],
      cleanNamespaces: [{ locale: "ar", namespace: "analytics" }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.cleanNamespaceViolations.length, 1);
  });

  test("a new eslint-disable is not a resolution", () => {
    const result = compareDiagnostics({
      baseFindings: [lintFinding()],
      headFindings: [],
      diff: diff({ suppressions: [{ path: "src/a.ts", line: 1, text: "// eslint-disable-next-line no-unused-vars" }] }),
      ...clean,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "suppression_added");
  });
});

describe("tool failures", () => {
  test("eslint and i18n exits that are not a completed report fail closed", () => {
    assert.equal(classifyEslintRun(2, null).reason, "eslint_exit_2");
    assert.equal(classifyEslintRun(1, { ok: false, reason: "eslint_json_not_array" }).reason, "eslint_json_not_array");
    assert.equal(classifyI18nRun(1, { failureCount: 0, findings: [] }).reason, "i18n_exit_inconsistent");
    assert.equal(classifyI18nRun(0, { failureCount: 3, findings: [] }).reason, "i18n_exit_inconsistent");
    assert.equal(classifyI18nRun(null, null).reason, "i18n_exit_null");
    const source = "export const bad = any;\n";
    const column = source.indexOf("any") + 1;
    const normalized = normalizeEslintReport([{
      filePath: "src/a.ts",
      messages: [{
        ruleId: "@typescript-eslint/no-explicit-any",
        severity: 2,
        message: "Unexpected any. Specify a different type.",
        line: 1,
        column,
        endLine: 1,
        endColumn: column + 3,
      }],
      errorCount: 1,
      warningCount: 0,
      fatalErrorCount: 0,
      source,
    }]);
    assert.equal(sliceSource(source, { line: 1, column, endLine: 1, endColumn: column + 3 }), "any");
    assert.equal(normalized.ok, true);
    assert.equal(normalized.findings[0].anchor, "any");
    const missingSpan = normalizeEslintReport([{
      filePath: "src/a.ts",
      messages: [{ ruleId: "no-undef", severity: 2, message: "bad", line: 1, column: 1 }],
      errorCount: 1,
      warningCount: 0,
      source,
    }]);
    assert.equal(missingSpan.reason, "eslint_message_missing_span");
  });

  test("an analyzer mismatch refuses a clean finding delta", () => {
    const decision = gateDecision({
      analyzerEqual: false,
      toolFailure: null,
      comparisons: [{ ok: true }],
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, "analyzer_changed");
  });
});

describe("manifest and detection text", () => {
  test("feature patterns are precise and analytics stays a clean namespace", () => {
    const manifest = manifestGlobs();
    assert.equal(manifest.ignorePathGlobs, undefined);
    assert.equal(matchesAnyGlob("src/features/instagram-insights/ui/Page.tsx", manifest.cleanPathGlobs), true);
    assert.equal(matchesAnyGlob("src/features/instagram-insights-extra/Page.tsx", manifest.cleanPathGlobs), false);
    assert.equal(matchesAnyGlob("supabase/functions/_shared/outlierScore.ts", manifest.cleanPathGlobs), true);
    assert.equal(matchesAnyGlob("supabase/functions/_shared/instagramInsightsGateway.ts", manifest.cleanPathGlobs), true);
    assert.equal(matchesAnyGlob("supabase/functions/_shared/commentActions.ts", manifest.cleanPathGlobs), false);
    assert.equal(matchesAnyGlob("src/pages/analytics/InstagramAnalytics.tsx", manifest.cleanPathGlobs), false);
    assert.deepEqual(manifest.cleanI18nNamespaces, [{ locale: "ar", namespace: "analytics" }]);
    assert.throws(() => loadCleanManifest({
      cleanPathGlobs: ["src/a.ts"],
      cleanI18nNamespaces: [{ locale: "ar", namespace: "analytics" }],
      ignoreNamespaces: ["common"],
    }), /manifest_ignore/);
  });

  test("structured output is the only checker difference from the immutable detection fixture", () => {
    const current = readFileSync(CHECKER, "utf8").replace(/\r\n/g, "\n");
    const detection = stripStructuredRegion(current);
    assert.equal(sha256Text(detection), IMMUTABLE_DETECTION_SHA256);
    assert.notEqual(sha256Text(current), IMMUTABLE_DETECTION_SHA256);
    assert.match(detection, /failures \+= missing\.length/);
    assert.doesNotMatch(detection, /STRUCTURED_OUTPUT_REGION/);
    assert.match(current, /STRUCTURED_OUTPUT_REGION/);
    const preserved = matchingAnalyzer({
      baseChecker: detection,
      headChecker: current,
      executedChecker: current,
      mergeChecker: current,
    });
    assert.equal(preserved.equal, true);
    assert.equal(preserved.structuredOutputOnly, true);
    assert.equal(preserved.hashes.i18nDetection.base, preserved.hashes.i18nDetection.head);
    assert.equal(preserved.hashes.i18nDetection.head, preserved.hashes.i18nDetection.executed);
    assert.equal(preserved.hashes.i18nChecker.head, preserved.hashes.i18nChecker.executed);
    assert.notEqual(preserved.hashes.i18nChecker.base, preserved.hashes.i18nChecker.executed);
  });

  test("an unchanged executable is accepted and a detection edit is refused", () => {
    const unchanged = matchingAnalyzer();
    assert.equal(unchanged.equal, true);
    assert.equal(unchanged.structuredOutputOnly, false);
    assert.equal(unchanged.hashes.i18nChecker.base, unchanged.hashes.i18nChecker.executed);
    assert.equal(unchanged.hashes.i18nDetection.base, unchanged.hashes.i18nDetection.executed);
    const detection = "failures += missing.length;\n";
    const executed = `${detection}${STRUCTURED_START}const structured = true;\n${STRUCTURED_END}`;
    const structuredOnly = matchingAnalyzer({
      baseChecker: detection,
      headChecker: executed,
      executedChecker: executed,
      mergeChecker: executed,
    });
    assert.equal(structuredOnly.equal, true);
    assert.equal(structuredOnly.structuredOutputOnly, true);
    assert.equal(structuredOnly.hashes.i18nChecker.head, structuredOnly.hashes.i18nChecker.executed);
    const mutated = `failures += missing.length + 1;\n${STRUCTURED_START}const structured = true;\n${STRUCTURED_END}`;
    const refused = matchingAnalyzer({
      baseChecker: detection,
      headChecker: mutated,
      executedChecker: mutated,
      mergeChecker: mutated,
    });
    assert.equal(refused.equal, false);
    assert.ok(refused.differences.includes("i18n_detection"));
  });

  test("eslint package pins compare version and integrity", () => {
    const pkg = JSON.stringify({ devDependencies: { eslint: "^9.32.0", globals: "^15.0.0" } });
    assert.equal(eslintPackageSpecifiers(pkg)["devDependencies:eslint"], "^9.32.0");
    const lock = JSON.stringify({
      packages: {
        "node_modules/eslint": { version: "9.32.0", integrity: "sha-a" },
        "node_modules/@eslint/js": { version: "9.32.0", integrity: "sha-b" },
        "node_modules/typescript-eslint": { version: "8.38.0", integrity: "sha-c" },
        "node_modules/@typescript-eslint/eslint-plugin": { version: "8.38.0", integrity: "sha-d" },
        "node_modules/@typescript-eslint/parser": { version: "8.38.0", integrity: "sha-e" },
        "node_modules/eslint-plugin-react-hooks": { version: "5.2.0", integrity: "sha-f" },
        "node_modules/eslint-plugin-react-refresh": { version: "0.4.20", integrity: "sha-g" },
        "node_modules/globals": { version: "15.15.0", integrity: "sha-h" },
      },
    });
    assert.equal(eslintLockPins(lock)["node_modules/eslint"].integrity, "sha-a");
    const analyzer = compareAnalyzer({
      baseConfig: "same",
      headConfig: "same",
      executedConfig: "same",
      mergeConfig: "different",
      baseIgnore: "",
      headIgnore: "",
      basePackageJson: pkg,
      headPackageJson: pkg,
      baseLock: lock,
      headLock: lock,
      baseChecker: "detector\n",
      headChecker: "detector\n",
      executedChecker: "detector\n",
      installedEslintVersion: "9.32.0",
    });
    assert.equal(analyzer.equal, false);
    assert.ok(analyzer.differences.includes("eslint_config_base_merge"));
  });
});

describe("git diffs and the i18n callsite report", () => {
  test("git rename mapping and a duplicated token use the real diff", () => {
    const dir = ownedTemp();
    try {
      git(dir, ["init", "-b", "main"]);
      mkdirSync(join(dir, "src", "legacy"), { recursive: true });
      writeFileSync(join(dir, "src", "legacy", "Bad.ts"), "export const bad = any;\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "base"]);
      const base = git(dir, ["rev-parse", "HEAD"]);
      git(dir, ["mv", "src/legacy/Bad.ts", "src/legacy/Moved.ts"]);
      git(dir, ["commit", "-m", "rename"]);
      const renamed = readTreeDiff(dir, base, "HEAD");
      assert.deepEqual(renamed.renames, [{ from: "src/legacy/Bad.ts", to: "src/legacy/Moved.ts", score: 100 }]);
      assert.equal(renamed.added.size, 0);

      writeFileSync(join(dir, "src", "legacy", "Moved.ts"), "export const bad = any;\nexport const bad = any;\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "duplicate"]);
      const duplicateBase = git(dir, ["rev-parse", "HEAD^"]);
      const duplicated = readTreeDiff(dir, duplicateBase, "HEAD");
      const source = readFileSync(join(dir, "src", "legacy", "Moved.ts"), "utf8");
      const column = source.split("\n")[0].indexOf("any") + 1;
      const anchor = sliceSource(source, { line: 1, column, endLine: 1, endColumn: column + 3 });
      assert.equal(anchor, "any");
      const finding = (line) => lintFinding({ path: "src/legacy/Moved.ts", anchor, line, rule: "@typescript-eslint/no-explicit-any", message: "Unexpected any. Specify a different type." });
      const compared = compareDiagnostics({
        baseFindings: [finding(1)],
        headFindings: [finding(1), finding(2)],
        diff: duplicated,
        cleanPathGlobs: [],
        cleanNamespaces: [],
      });
      assert.equal(compared.ok, false);
      assert.ok(compared.newDiagnostics.length >= 1);
      assert.equal(compared.newDiagnostics.every((item) => item.anchor === "any"), true);
    } finally {
      assertSafeTemp(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("added eslint-disable lines are suppressions and copies are not renames", () => {
    const parsed = parseUnifiedDiff([
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,0 +1 @@",
      "+// eslint-disable-next-line no-unused-vars",
    ].join("\n"));
    assert.equal(parsed.suppressions.length, 1);
    assert.equal(parsed.changed.get("src/a.ts").has(1), true);
    const copied = parseNameStatusZ("C100\0src/a.ts\0src/b.ts\0");
    assert.equal(copied.renames.length, 0);
    assert.equal(copied.added.has("src/b.ts"), true);
  });

  test("structured i18n output keeps set-based failure counts and records every callsite", () => {
    const dir = ownedTemp();
    try {
      mkdirSync(join(dir, "scripts"), { recursive: true });
      mkdirSync(join(dir, "src", "i18n", "locales", "ar"), { recursive: true });
      writeFileSync(join(dir, "scripts", "check-i18n-coverage.mjs"), readFileSync(CHECKER));
      writeFileSync(join(dir, "src", "i18n", "index.ts"), 'export const i18n = { defaultNS: "common", ns: ["common", "analytics"] };\n');
      writeFileSync(join(dir, "src", "i18n", "locales", "ar", "common.json"), `${JSON.stringify({
        save: "حفظ",
        nested: { orphan: "يتيم" },
      }, null, 2)}\n`);
      writeFileSync(join(dir, "src", "i18n", "locales", "ar", "analytics.json"), `${JSON.stringify({ title: "عنوان" }, null, 2)}\n`);
      writeFileSync(join(dir, "src", "HasMissing.tsx"), [
        'export function HasMissing() {',
        '  const { t } = useTranslation("common");',
        '  t("save");',
        '  t("missing");',
        '  t("missing");',
        "}",
        "",
      ].join("\n"));
      writeFileSync(join(dir, "src", "AlsoMissing.tsx"), [
        'export function AlsoMissing() {',
        '  const { t } = useTranslation("common");',
        '  return t("missing");',
        "}",
        "",
      ].join("\n"));
      writeFileSync(join(dir, "src", "AnalyticsPage.tsx"), [
        'export function AnalyticsPage() {',
        '  const { t } = useTranslation("analytics");',
        '  return t("title");',
        "}",
        "",
      ].join("\n"));
      const jsonPath = join(dir, "report.json");
      const withJson = spawnSync(process.execPath, [join(dir, "scripts", "check-i18n-coverage.mjs"), "--json", jsonPath], { cwd: dir, encoding: "utf8" });
      assert.equal(withJson.status, 1, withJson.stderr);
      assert.match(withJson.stderr, /FAILED: 2 i18n coverage issue\(s\) found\./);
      const payload = JSON.parse(readFileSync(jsonPath, "utf8"));
      assert.equal(payload.failureCount, 2);
      assert.equal(payload.locale, "ar");
      const missing = payload.findings.filter((finding) => finding.category === "MISSING");
      const orphans = payload.findings.filter((finding) => finding.category === "ORPHAN");
      const analytics = payload.findings.filter((finding) => finding.namespace === "analytics");
      assert.equal(missing.length, 3);
      assert.equal(new Set(missing.map((finding) => finding.key)).size, 1);
      assert.deepEqual(orphans.map((finding) => finding.key), ["nested.orphan"]);
      assert.equal(typeof orphans[0].line, "number");
      assert.equal(analytics.length, 0);
      const findings = i18nToFindings(payload);
      assert.equal(findings.length, payload.findings.length);

      const plain = spawnSync(process.execPath, [join(dir, "scripts", "check-i18n-coverage.mjs")], { cwd: dir, encoding: "utf8" });
      assert.equal(plain.status, 1);
      assert.match(plain.stderr, /FAILED: 2 i18n coverage issue\(s\) found\./);
      assert.doesNotMatch(plain.stdout, /STRUCTURED_OUTPUT_REGION/);
    } finally {
      assertSafeTemp(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("the job summary states full counts and does not call historical lint a pass", () => {
  const summary = renderSummary({
    baseSha: BASE,
    headSha: HEAD,
    mergeTreeSha: "d".repeat(40),
    baselineMode: "pull_request_event_base",
    ok: true,
    reason: null,
    counts: {
      lint: {
        base: { exitCode: 1, errorCount: 1418, warningCount: 129 },
        head: { exitCode: 1, errorCount: 1418, warningCount: 129 },
        merge: { exitCode: 1, errorCount: 1418, warningCount: 129 },
      },
      i18n: {
        base: { exitCode: 1, failureCount: 364, callsiteCount: 400 },
        head: { exitCode: 1, failureCount: 364, callsiteCount: 400 },
        merge: { exitCode: 1, failureCount: 364, callsiteCount: 400 },
      },
    },
    newCount: 0,
    resolvedCount: 2,
    newDiagnostics: [],
    featurePathViolations: [],
    cleanNamespaceViolations: [],
    suppressions: [],
    headNewCount: 0,
    analyzer: { differences: [], structuredOutputOnly: true },
    normalizedReports: { base: {}, head: {}, merge: {} },
  });
  assert.match(summary, /no regressions only/);
  assert.match(summary, /1418/);
  assert.match(summary, /364/);
  assert.match(summary, /NO REGRESSIONS/);
  assert.match(summary, /Full normalized base, head, and merge reports/);
  assert.doesNotMatch(summary, /lint passed/i);
  assert.doesNotMatch(summary, /full lint passes/i);
});

test("head and merge findings both stay in the artifact when the trees differ", () => {
  const inherited = lintFinding({ path: "src/legacy/Kept.ts", anchor: "kept" });
  const headOnly = lintFinding({ path: "src/head-only.ts", anchor: "headOnly" });
  const mergeOnly = lintFinding({ path: "src/merge-only.ts", anchor: "mergeOnly" });
  const clean = { cleanPathGlobs: [], cleanNamespaces: [] };
  const baseRun = toolRun([inherited]);
  const headRun = toolRun([inherited, headOnly]);
  const mergeRun = toolRun([inherited, mergeOnly]);
  const headComparison = compareDiagnostics({
    baseFindings: [inherited],
    headFindings: [inherited, headOnly],
    diff: diff(),
    ...clean,
  });
  const mergeComparison = compareDiagnostics({
    baseFindings: [inherited],
    headFindings: [inherited, mergeOnly],
    diff: diff(),
    ...clean,
  });
  assert.equal(headComparison.ok, false);
  assert.equal(mergeComparison.ok, false);
  const bothFail = {
    analyzer: { hashes: { eslint_config_base_head: { left: "config-hash", right: "config-hash" } } },
  };
  assert.throws(
    () => applyComparisonOutcome(bothFail, { baseRun, headRun, mergeRun, mergeComparison, headComparison }),
    (err) => {
      assert.equal(err.reason, "new_diagnostics");
      return true;
    },
  );
  assert.equal(bothFail.ok, false);
  assert.equal(bothFail.reason, "new_diagnostics");
  assert.equal(bothFail.findingSamples, undefined);
  assert.equal(bothFail.normalizedReports.head.lint.exitCode, 1);
  assert.equal(bothFail.normalizedReports.merge.lint.exitCode, 1);
  assert.notEqual(bothFail.normalizedReports.head.lint.exitCode, 0);
  assert.equal(bothFail.normalizedReports.head.lint.errorCount, 2);
  assert.equal(bothFail.normalizedReports.head.lint.findings.some((finding) => finding.anchor === "headOnly"), true);
  assert.equal(bothFail.normalizedReports.merge.lint.findings.some((finding) => finding.anchor === "mergeOnly"), true);
  assert.equal(bothFail.normalizedReports.head.lint.findings.some((finding) => finding.anchor === "mergeOnly"), false);
  assert.equal(bothFail.normalizedReports.merge.lint.findings.some((finding) => finding.anchor === "headOnly"), false);
  assert.equal(bothFail.normalizedReports.base.lint.findings.some((finding) => finding.anchor === "kept"), true);
  assert.notEqual(bothFail.normalizedReports.head.lint.sha256, bothFail.normalizedReports.merge.lint.sha256);
  assert.equal(bothFail.normalizedReports.head.lint.sha256.length, 64);
  assert.equal(bothFail.analyzer.hashes.eslint_config_base_head.left, "config-hash");

  const mergeClean = compareDiagnostics({
    baseFindings: [inherited],
    headFindings: [inherited],
    diff: diff(),
    ...clean,
  });
  assert.equal(mergeClean.ok, true);
  const headOnlyReport = { analyzer: { hashes: { i18nChecker: { executed: "executed-hash" } } } };
  assert.throws(
    () => applyComparisonOutcome(headOnlyReport, {
      baseRun,
      headRun,
      mergeRun: baseRun,
      mergeComparison: mergeClean,
      headComparison,
    }),
    (err) => {
      assert.equal(err.reason, "new_diagnostics");
      return true;
    },
  );
  assert.equal(headOnlyReport.ok, false);
  assert.equal(headOnlyReport.newDiagnostics.some((finding) => finding.anchor === "headOnly"), true);
  assert.equal(headOnlyReport.normalizedReports.head.lint.findings.some((finding) => finding.anchor === "headOnly"), true);
  assert.equal(headOnlyReport.normalizedReports.merge.lint.findings.some((finding) => finding.anchor === "kept"), true);
  assert.equal(headOnlyReport.normalizedReports.merge.lint.findings.some((finding) => finding.anchor === "headOnly"), false);
  assert.equal(headOnlyReport.normalizedReports.head.lint.exitCode, 1);
  assert.equal(headOnlyReport.analyzer.hashes.i18nChecker.executed, "executed-hash");
});

test("glob compilation rejects an empty pattern", () => {
  assert.throws(() => compileGlob(""), /manifest_glob/);
});
