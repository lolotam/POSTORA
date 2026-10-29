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
  collectEslintLane,
  collectEslintPair,
  compareLintLanes,
  diffSuppressionDirectives,
  extractSuppressionDirectives,
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

function sourceOf(lines) {
  return `${lines.join("\n")}\n`;
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
      suppressedMessages: [],
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
      suppressedMessages: [],
      source,
    }]);
    assert.equal(missingSpan.reason, "eslint_message_missing_span");
    const omitted = normalizeEslintReport([{
      filePath: "src/a.ts",
      messages: [],
      errorCount: 0,
      warningCount: 0,
      fatalErrorCount: 0,
      source,
    }]);
    assert.equal(omitted.ok, false);
    assert.equal(omitted.reason, "eslint_suppressed_missing");
    const incomplete = normalizeEslintReport([{
      filePath: "src/a.ts",
      messages: [],
      suppressedMessages: [{ ruleId: "@typescript-eslint/no-explicit-any", severity: 2, message: "hidden", line: 1, column: 1 }],
      errorCount: 0,
      warningCount: 0,
      fatalErrorCount: 0,
      source,
    }]);
    assert.equal(incomplete.ok, false);
    assert.equal(incomplete.reason, "eslint_suppression_incomplete");
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

  test("diff text records changed lines and copies are not renames", () => {
    const parsed = parseUnifiedDiff([
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,0 +1 @@",
      "+// eslint-disable-next-line no-unused-vars",
    ].join("\n"));
    assert.equal(parsed.suppressions, undefined);
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

  test("parsed comments classify suppressions and a parse failure stays closed", () => {
    const dir = ownedTemp();
    try {
      git(dir, ["init", "-b", "main"]);
      mkdirSync(join(dir, "src"), { recursive: true });
      const nextLine = "// eslint-disable-next-line no-unused-vars";
      writeFileSync(join(dir, "src", "A.ts"), "const kept = 1;\n");
      writeFileSync(join(dir, "notes.json"), "{}\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "base"]);
      const base = git(dir, ["rev-parse", "HEAD"]);

      writeFileSync(join(dir, "src", "A.ts"), "const label = \"eslint-disable-next-line no-unused-vars\";\n");
      writeFileSync(join(dir, "notes.json"), "{ \"note\": \"eslint-disable-next-line\" }\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "strings"]);
      const strings = readTreeDiff(dir, base, "HEAD");
      assert.equal(strings.ambiguous, null);
      assert.deepEqual(strings.suppressions, []);

      const padded = [
        nextLine,
        "const kept = 1;",
        ...Array.from({ length: 12 }, (_, index) => `const pad${index} = ${index};`),
        "",
      ].join("\n");
      writeFileSync(join(dir, "src", "A.ts"), padded);
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "directive"]);
      const directiveBase = git(dir, ["rev-parse", "HEAD^"]);
      const added = readTreeDiff(dir, directiveBase, "HEAD");
      assert.equal(added.suppressions.length, 1);
      assert.equal(added.suppressions[0].path, "src/A.ts");
      const blocked = compareDiagnostics({
        baseFindings: [],
        headFindings: [],
        diff: added,
        cleanPathGlobs: [],
        cleanNamespaces: [],
      });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.reason, "suppression_added");

      git(dir, ["mv", "src/A.ts", "src/B.ts"]);
      writeFileSync(join(dir, "src", "B.ts"), `${padded}const tail = 2;\n`);
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "rename"]);
      const renamed = readTreeDiff(dir, git(dir, ["rev-parse", "HEAD^"]), "HEAD");
      assert.equal(renamed.renames.length, 1);
      assert.deepEqual(renamed.suppressions, []);

      writeFileSync(join(dir, "src", "B.ts"), "const = ;\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "broken"]);
      const broken = readTreeDiff(dir, git(dir, ["rev-parse", "HEAD^"]), "HEAD");
      assert.match(broken.ambiguous, /base src\/B\.ts|head src\/B\.ts/);
      const refused = compareDiagnostics({
        baseFindings: [],
        headFindings: [],
        diff: broken,
        cleanPathGlobs: [],
        cleanNamespaces: [],
      });
      assert.equal(refused.ok, false);
      assert.equal(refused.reason, "ambiguous_diff");
    } finally {
      assertSafeTemp(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("suppression directives", () => {
  const nextLine = "// eslint-disable-next-line no-unused-vars";
  const kept = "const kept = 1;";
  const other = "const other = 2;";

  test("the gate sources mention directives only as text", () => {
    const templateMention = `prefix // eslint-disable-next-line no-unused-vars suffix`;
    const patternMention = /eslint-disable-next-line/;
    assert.match(templateMention, /eslint-disable-next-line/);
    assert.match(patternMention.source, /eslint-disable-next-line/);
    const files = [
      ["scripts/ci/lint-i18n-regression.mjs", readFileSync(join(HERE, "lint-i18n-regression.mjs"), "utf8")],
      ["scripts/ci/lint-i18n-regression.test.mjs", readFileSync(fileURLToPath(import.meta.url), "utf8")],
    ];
    for (const [filePath, source] of files) {
      assert.match(source, /eslint-disable/);
      const extracted = extractSuppressionDirectives(source, filePath);
      assert.equal(extracted.ok, true, extracted.detail);
      assert.deepEqual(extracted.directives, []);
    }
  });

  test("real directive comments fail and non-directives do not", () => {
    const absent = diffSuppressionDirectives("", sourceOf([nextLine, kept]), "src/a.ts");
    assert.equal(absent.ok, true);
    assert.equal(absent.suppressions.length, 1);
    const quiet = compareDiagnostics({
      baseFindings: [],
      headFindings: [],
      diff: diff({ suppressions: absent.suppressions }),
      cleanPathGlobs: [],
      cleanNamespaces: [],
    });
    assert.equal(quiet.reason, "suppression_added");

    const nonDirectives = [
      sourceOf(["const label = \"// eslint-disable-next-line no-unused-vars\";"]),
      sourceOf(["const text = `// eslint-disable-next-line no-unused-vars`;", "const re = /eslint-disable-next-line/;", "const escaped = \"say \\\"// eslint-disable-line no-unused-vars\\\"\";"]),
      sourceOf(["// see eslint-disable-next-line in the docs", kept]),
      sourceOf(["// eslint-disable no-unused-vars", kept]),
      sourceOf([kept]),
    ];
    for (const source of nonDirectives) {
      const result = diffSuppressionDirectives("", source, "src/a.ts");
      assert.equal(result.ok, true, result.detail);
      assert.deepEqual(result.suppressions, []);
    }

    const inline = diffSuppressionDirectives("", "const kept = 1; // eslint-disable-line no-unused-vars\n", "src/a.ts");
    const inlineBlock = diffSuppressionDirectives("", "const kept = 1; /* eslint-disable-line no-unused-vars */\n", "src/a.ts");
    const multiline = diffSuppressionDirectives("", "/* eslint-disable\n   no-unused-vars\n*/\nconst kept = 1;\n", "src/a.ts");
    const multilineLine = diffSuppressionDirectives("", "/* eslint-disable-line\n   no-unused-vars */\nconst kept = 1;\n", "src/a.ts");
    const jsx = diffSuppressionDirectives(
      "",
      "export function A() {\n  return <div>{/* eslint-disable-next-line no-unused-vars */}kept</div>;\n}\n",
      "src/A.tsx",
    );
    const quoted = diffSuppressionDirectives("", "/* eslint-disable 'no-unused-vars', \"eqeqeq\" */\nconst kept = 1;\n", "src/a.ts");
    const cli = diffSuppressionDirectives("", "#!/usr/bin/env node\n// eslint-disable-next-line no-console\nconsole.log(1);\n", "scripts/run.mjs");
    for (const result of [inline, inlineBlock, multiline, multilineLine, jsx, quoted, cli]) {
      assert.equal(result.ok, true, result.detail);
      assert.equal(result.suppressions.length, 1);
    }

    const removedComment = diffSuppressionDirectives(sourceOf([nextLine, kept]), sourceOf([kept]), "src/a.ts");
    const removedString = diffSuppressionDirectives(
      "const label = \"eslint-disable-next-line no-unused-vars\";\n",
      "const label = \"ok\";\n",
      "src/a.ts",
    );
    assert.deepEqual(removedComment.suppressions, []);
    assert.deepEqual(removedString.suppressions, []);
    const broken = diffSuppressionDirectives("const kept = 1;\n", "const = ;\n", "src/a.ts");
    assert.equal(broken.ok, false);
    assert.deepEqual(broken.suppressions, []);
  });

  test("moving a directive onto different code is new and moving it with that code is not", () => {
    const movedApart = diffSuppressionDirectives(
      sourceOf([nextLine, kept, other]),
      sourceOf([kept, nextLine, other]),
      "src/a.ts",
    );
    assert.equal(movedApart.suppressions.length, 1);
    assert.equal(movedApart.suppressions[0].line, 2);

    const movedTogether = diffSuppressionDirectives(
      sourceOf([nextLine, kept, "export const tail = 3;"]),
      sourceOf(["export const tail = 3;", nextLine, kept]),
      "src/a.ts",
    );
    assert.deepEqual(movedTogether.suppressions, []);

    const changedLine = diffSuppressionDirectives(
      sourceOf([nextLine, "const kept = 1;"]),
      sourceOf([nextLine, "const kept = 2;"]),
      "src/a.ts",
    );
    assert.equal(changedLine.suppressions.length, 1);

    const duplicated = diffSuppressionDirectives(
      sourceOf([nextLine, kept]),
      sourceOf([nextLine, kept, nextLine, kept]),
      "src/a.ts",
    );
    assert.equal(duplicated.suppressions.length, 1);

    const block = "/* eslint-disable no-unused-vars */";
    const enable = "/* eslint-enable no-unused-vars */";
    const distant = diffSuppressionDirectives(
      sourceOf([block, kept, other]),
      sourceOf([block, kept, "const other = 3;"]),
      "src/a.ts",
    );
    assert.deepEqual(distant.suppressions, []);
    const movedBlock = diffSuppressionDirectives(
      sourceOf([block, kept, other]),
      sourceOf([kept, block, other]),
      "src/a.ts",
    );
    assert.equal(movedBlock.suppressions.length, 1);
    const widened = diffSuppressionDirectives(
      sourceOf([block, kept, enable, other]),
      sourceOf([block, kept, other, enable]),
      "src/a.ts",
    );
    assert.equal(widened.suppressions.length, 1);
  });

  test("inline rule configuration comments are directives and lookalikes are not", () => {
    const config = "/* eslint \"no-empty\": \"off\" */";
    const added = diffSuppressionDirectives("", sourceOf([config, kept]), "src/a.ts");
    assert.equal(added.ok, true, added.detail);
    assert.equal(added.suppressions.length, 1);
    const dormant = compareDiagnostics({
      baseFindings: [],
      headFindings: [],
      diff: diff({ suppressions: added.suppressions }),
      cleanPathGlobs: [],
      cleanNamespaces: [],
    });
    assert.equal(dormant.reason, "suppression_added");
    const same = diffSuppressionDirectives(sourceOf([config, kept]), sourceOf([config, kept]), "src/a.ts");
    assert.deepEqual(same.suppressions, []);
    const changed = diffSuppressionDirectives(
      sourceOf([config, kept]),
      sourceOf(["/* eslint \"no-empty\": \"warn\" */", kept]),
      "src/a.ts",
    );
    assert.equal(changed.suppressions.length, 1);
    const lookalikes = [
      sourceOf(["const label = \"/* eslint \\\"no-empty\\\": \\\"off\\\" */\";"]),
      sourceOf(["const text = `/* eslint \\\"no-empty\\\": \\\"off\\\" */`;", "const re = /eslint\\s+off/;"]),
      sourceOf(["// eslint \"no-empty\": \"off\"", kept]),
    ];
    for (const source of lookalikes) {
      const result = diffSuppressionDirectives("", source, "src/a.ts");
      assert.equal(result.ok, true, result.detail);
      assert.deepEqual(result.suppressions, []);
    }
    const multiline = diffSuppressionDirectives(
      "",
      "/* eslint\n   \"no-empty\": \"off\"\n*/\nconst kept = 1;\n",
      "src/a.ts",
    );
    assert.equal(multiline.ok, true, multiline.detail);
    assert.equal(multiline.suppressions.length, 1);
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
      lintNoInlineConfig: {
        base: { exitCode: 1, errorCount: 1800, warningCount: 200 },
        head: { exitCode: 1, errorCount: 1800, warningCount: 200 },
        merge: { exitCode: 1, errorCount: 1800, warningCount: 200 },
      },
      suppressed: {
        base: { exitCode: 1, count: 40 },
        head: { exitCode: 1, count: 40 },
        merge: { exitCode: 1, count: 40 },
      },
      i18n: {
        base: { exitCode: 1, failureCount: 364, callsiteCount: 400 },
        head: { exitCode: 1, failureCount: 364, callsiteCount: 400 },
        merge: { exitCode: 1, failureCount: 364, callsiteCount: 400 },
      },
    },
    lanes: {
      noInlineConfig: { merge: { newCount: 0 } },
      suppressedMessages: { merge: { newCount: 0 } },
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
  assert.match(summary, /1800/);
  assert.match(summary, /364/);
  assert.match(summary, /NO REGRESSIONS/);
  assert.match(summary, /Full normalized base, head, and merge reports/);
  assert.match(summary, /not an allowance/);
  assert.match(summary, /--no-inline-config/);
  assert.match(summary, /Newly suppressed findings: 0/);
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

function lintSnapshot(dir) {
  const raw = ownedTemp();
  try {
    return collectEslintPair(REPO, dir, raw, "fixture");
  } finally {
    assertSafeTemp(raw);
    rmSync(raw, { recursive: true, force: true });
  }
}

function initFixture() {
  const dir = ownedTemp();
  git(dir, ["init", "-b", "main"]);
  return dir;
}

function commitAll(dir, message) {
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function writeRepoFile(dir, path, body) {
  const file = join(dir, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

function laneDecision(lanes) {
  return gateDecision({
    analyzerEqual: true,
    toolFailure: null,
    comparisons: [lanes.ordinary, lanes.noInlineConfig, lanes.suppressedMessages],
  });
}

function compareSnapshotLanes(baseLint, headLint, delta, globs) {
  return compareLintLanes({
    baseOrdinary: baseLint.ordinary.findings,
    headOrdinary: headLint.ordinary.findings,
    baseNoInline: baseLint.noInlineConfig.findings,
    headNoInline: headLint.noInlineConfig.findings,
    baseSuppressed: baseLint.ordinary.suppressedFindings,
    headSuppressed: headLint.ordinary.suppressedFindings,
    diff: delta,
    cleanPathGlobs: globs.cleanPathGlobs,
    cleanNamespaces: globs.cleanNamespaces,
  });
}

describe("pinned eslint lanes", () => {
  const anyOff = "/* eslint \"@typescript-eslint/no-explicit-any\": \"off\" */";
  const disableAny = "/* eslint-disable @typescript-eslint/no-explicit-any */";
  const enableAny = "/* eslint-enable @typescript-eslint/no-explicit-any */";
  const globs = () => {
    const manifest = manifestGlobs();
    return { cleanPathGlobs: manifest.cleanPathGlobs, cleanNamespaces: manifest.cleanI18nNamespaces };
  };

  function evolve(baseFiles, headFiles) {
    const dir = initFixture();
    try {
      for (const [path, body] of baseFiles) writeRepoFile(dir, path, body);
      const baseSha = commitAll(dir, "base");
      const baseLint = lintSnapshot(dir);
      assert.equal(baseLint.fatal, null, baseLint.detail || baseLint.fatal);
      for (const [path, body] of headFiles) writeRepoFile(dir, path, body);
      commitAll(dir, "head");
      const headLint = lintSnapshot(dir);
      assert.equal(headLint.fatal, null, headLint.detail || headLint.fatal);
      const delta = readTreeDiff(dir, baseSha, "HEAD");
      assert.equal(delta.ambiguous, null, delta.ambiguous);
      return { baseLint, headLint, delta };
    } finally {
      assertSafeTemp(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a new inline rule configuration hiding any is rejected inside and outside the clean manifest", () => {
    const body = `${anyOff}\nexport const unsafe: any = 1;\n`;
    const outside = evolve(
      [["src/legacy/Safe.ts", "export const safe = 1;\n"]],
      [["src/legacy/Safe.ts", "export const safe = 1;\n"], ["src/legacy/New.ts", body]],
    );
    assert.equal(outside.headLint.ordinary.exitCode, 0);
    assert.equal(outside.headLint.ordinary.errorCount, 0);
    assert.equal(outside.headLint.ordinary.suppressedCount, 0);
    assert.equal(outside.headLint.noInlineConfig.exitCode, 1);
    assert.equal(outside.headLint.noInlineConfig.errorCount, 1);
    assert.equal(outside.delta.suppressions.length, 1);
    const outsideLanes = compareSnapshotLanes(outside.baseLint, outside.headLint, outside.delta, { cleanPathGlobs: [], cleanNamespaces: [] });
    assert.equal(outsideLanes.ordinary.reason, "suppression_added");
    assert.equal(outsideLanes.noInlineConfig.ok, false);
    assert.equal(outsideLanes.noInlineConfig.reason, "new_diagnostics");
    assert.equal(outsideLanes.suppressedMessages.ok, true);
    assert.equal(laneDecision(outsideLanes).ok, false);

    const inside = evolve(
      [["src/legacy/Safe.ts", "export const safe = 1;\n"]],
      [["src/legacy/Safe.ts", "export const safe = 1;\n"], ["src/features/instagram-insights/ui/New.ts", body]],
    );
    const insideLanes = compareSnapshotLanes(inside.baseLint, inside.headLint, inside.delta, globs());
    assert.equal(insideLanes.noInlineConfig.reason, "feature_path_dirty");
    assert.equal(insideLanes.ordinary.reason, "suppression_added");
    assert.equal(laneDecision(insideLanes).ok, false);
  });

  test("a new any inside an unchanged disable range is rejected by both new lanes", () => {
    const base = [disableAny, "export const first: any = 1;", "const safe = 1;", enableAny, ""].join("\n");
    const head = [disableAny, "export const first: any = 1;", "export const second: any = 2;", "const safe = 1;", enableAny, ""].join("\n");
    const evolved = evolve([["src/legacy/Range.ts", base]], [["src/legacy/Range.ts", head]]);
    assert.equal(evolved.delta.suppressions.length, 0);
    assert.equal(evolved.baseLint.ordinary.errorCount, 0);
    assert.equal(evolved.headLint.ordinary.errorCount, 0);
    assert.equal(evolved.headLint.ordinary.exitCode, 0);
    assert.equal(evolved.baseLint.ordinary.suppressedCount, 1);
    assert.equal(evolved.headLint.ordinary.suppressedCount, 2);
    assert.equal(evolved.baseLint.noInlineConfig.errorCount, 1);
    assert.equal(evolved.headLint.noInlineConfig.errorCount, 2);
    assert.equal(evolved.headLint.noInlineConfig.exitCode, 1);
    const lanes = compareSnapshotLanes(evolved.baseLint, evolved.headLint, evolved.delta, { cleanPathGlobs: [], cleanNamespaces: [] });
    assert.equal(lanes.ordinary.ok, true);
    assert.equal(lanes.noInlineConfig.ok, false);
    assert.equal(lanes.suppressedMessages.ok, false);
    assert.equal(lanes.suppressedMessages.newDiagnostics.length, 1);
    assert.equal(laneDecision(lanes).ok, false);
  });

  test("an old any newly covered by a moved range is rejected by suppressedMessages", () => {
    const base = [
      disableAny,
      "export const first: any = 1;",
      "const safe = 1;",
      enableAny,
      "export const tail = 1;",
      "export const old: any = 1;",
      "",
    ].join("\n");
    const head = [
      disableAny,
      "export const first: any = 1;",
      "const safe = 1;",
      "export const old: any = 1;",
      enableAny,
      "export const tail = 1;",
      "",
    ].join("\n");
    const evolved = evolve([["src/legacy/Moved.ts", base]], [["src/legacy/Moved.ts", head]]);
    assert.equal(evolved.delta.suppressions.length, 0);
    assert.equal(evolved.baseLint.noInlineConfig.errorCount, evolved.headLint.noInlineConfig.errorCount);
    assert.equal(evolved.headLint.ordinary.suppressedCount, evolved.baseLint.ordinary.suppressedCount + 1);
    const lanes = compareSnapshotLanes(evolved.baseLint, evolved.headLint, evolved.delta, { cleanPathGlobs: [], cleanNamespaces: [] });
    assert.equal(lanes.suppressedMessages.ok, false);
    assert.ok(lanes.suppressedMessages.newDiagnostics.some((finding) => finding.rule === "@typescript-eslint/no-explicit-any"));
    assert.equal(laneDecision(lanes).ok, false);
  });

  test("a dormant config comment is rejected and identical historical suppressions are not", () => {
    const dormant = evolve(
      [["src/legacy/Safe.ts", "export const safe = 1;\n"]],
      [["src/legacy/Safe.ts", `${anyOff}\nexport const safe = 1;\n`]],
    );
    assert.equal(dormant.headLint.ordinary.exitCode, 0);
    assert.equal(dormant.headLint.ordinary.errorCount, 0);
    assert.equal(dormant.headLint.noInlineConfig.errorCount, 0);
    assert.equal(dormant.headLint.ordinary.suppressedCount, 0);
    assert.equal(dormant.delta.suppressions.length, 1);
    const dormantLanes = compareSnapshotLanes(dormant.baseLint, dormant.headLint, dormant.delta, { cleanPathGlobs: [], cleanNamespaces: [] });
    assert.equal(dormantLanes.ordinary.reason, "suppression_added");
    assert.equal(dormantLanes.noInlineConfig.ok, true);
    assert.equal(dormantLanes.suppressedMessages.ok, true);

    const historicalBody = `${disableAny}\nexport const old: any = 1;\n`;
    const historical = evolve(
      [["src/legacy/Old.ts", historicalBody], ["notes.json", "{}\n"]],
      [["src/legacy/Old.ts", historicalBody], ["notes.json", "{ \"note\": \"unchanged debt\" }\n"]],
    );
    assert.equal(historical.delta.suppressions.length, 0);
    assert.ok(historical.baseLint.noInlineConfig.errorCount > historical.baseLint.ordinary.errorCount);
    assert.equal(historical.baseLint.noInlineConfig.errorCount, historical.headLint.noInlineConfig.errorCount);
    assert.equal(historical.baseLint.ordinary.suppressedCount, historical.headLint.ordinary.suppressedCount);
    const historicalLanes = compareSnapshotLanes(historical.baseLint, historical.headLint, historical.delta, { cleanPathGlobs: [], cleanNamespaces: [] });
    assert.equal(historicalLanes.ordinary.ok, true);
    assert.equal(historicalLanes.noInlineConfig.ok, true);
    assert.equal(historicalLanes.suppressedMessages.ok, true);
    assert.equal(laneDecision(historicalLanes).ok, true);
  });

  test("equal-count replacement, directive lookalikes, multiline disables, and enable boundaries use pinned eslint", () => {
    const replaced = evolve(
      [["src/legacy/Swap.ts", "export const value: any = 1;\n"]],
      [["src/legacy/Swap.ts", "export function run() { if (false) { return 1; } }\n"]],
    );
    assert.equal(replaced.baseLint.ordinary.errorCount, 1);
    assert.equal(replaced.headLint.ordinary.errorCount, 1);
    const swapped = compareSnapshotLanes(
      replaced.baseLint,
      replaced.headLint,
      diff(),
      { cleanPathGlobs: [], cleanNamespaces: [] },
    );
    assert.equal(swapped.ordinary.ok, false);
    assert.equal(swapped.ordinary.reason, "new_diagnostics");
    assert.equal(swapped.ordinary.newDiagnostics.length, 1);
    assert.equal(swapped.ordinary.resolvedDiagnostics.length, 1);
    const realSwap = compareSnapshotLanes(replaced.baseLint, replaced.headLint, replaced.delta, { cleanPathGlobs: [], cleanNamespaces: [] });
    assert.equal(realSwap.ordinary.ok, false);

    const hiddenConfig = anyOff;
    const lookalike = [
      `export const label = ${JSON.stringify(hiddenConfig)};`,
      "export const template = `" + hiddenConfig + "`;",
      "export const pattern = /eslint-disable-next-line/;",
      "export const unsafe: any = 1;",
      "",
    ].join("\n");
    assert.equal(diffSuppressionDirectives("", lookalike, "src/legacy/Look.ts").suppressions.length, 0);
    const looked = evolve(
      [["src/legacy/Look.ts", "export const unsafe: any = 1;\n"]],
      [["src/legacy/Look.ts", lookalike]],
    );
    assert.equal(looked.delta.suppressions.length, 0);
    assert.equal(looked.headLint.ordinary.errorCount, 1);
    assert.equal(looked.headLint.ordinary.suppressedCount, 0);
    assert.equal(looked.headLint.noInlineConfig.errorCount, 1);

    const dir = initFixture();
    try {
      writeRepoFile(dir, "src/Multi.ts", "/* eslint-disable\n   @typescript-eslint/no-explicit-any\n*/\nexport const first: any = 1;\n");
      writeRepoFile(dir, "src/Boundary.ts", [
        disableAny,
        "export const hidden: any = 1;",
        enableAny,
        "export const shown: any = 1;",
        "",
      ].join("\n"));
      commitAll(dir, "shapes");
      const linted = lintSnapshot(dir);
      assert.equal(linted.fatal, null, linted.detail || linted.fatal);
      const multiSuppressed = linted.ordinary.suppressedFindings.filter((finding) => finding.path.endsWith("Multi.ts"));
      const boundaryMessages = linted.ordinary.findings.filter((finding) => finding.path.endsWith("Boundary.ts"));
      const boundarySuppressed = linted.ordinary.suppressedFindings.filter((finding) => finding.path.endsWith("Boundary.ts"));
      const boundaryHidden = linted.noInlineConfig.findings.filter((finding) => finding.path.endsWith("Boundary.ts"));
      assert.equal(multiSuppressed.length, 1);
      assert.equal(boundaryMessages.length, 1);
      assert.equal(boundarySuppressed.length, 1);
      assert.equal(boundaryHidden.length, 2);
      assert.equal(boundaryMessages[0].anchor, "any");
      assert.equal(boundarySuppressed[0].suppressions[0].kind, "directive");
    } finally {
      assertSafeTemp(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parser failure, a missing report, an incomplete scan, and a missing binary block", () => {
    const dir = initFixture();
    const raw = ownedTemp();
    const emptyRepo = ownedTemp();
    try {
      writeRepoFile(dir, "src/Broken.ts", "const = ;\n");
      const broken = collectEslintPair(REPO, dir, raw, "broken");
      assert.equal(broken.fatal, "eslint_fatal_message");
      assert.equal(broken.ordinary.exitCode, 1);
      assert.equal(broken.ordinary.findings.length, 0);
      assert.equal(broken.noInlineConfig.fatal, "eslint_fatal_message");

      writeRepoFile(dir, "src/Broken.ts", "export const safe = 1;\n");
      const goodFile = join(raw, "good.json");
      const good = collectEslintLane(REPO, dir, goodFile, true);
      assert.equal(good.fatal, null, good.detail || good.fatal);
      const parsed = JSON.parse(readFileSync(goodFile, "utf8"));
      assert.ok(Array.isArray(parsed[0].suppressedMessages));
      delete parsed[0].suppressedMessages;
      const stripped = normalizeEslintReport(parsed);
      assert.equal(stripped.ok, false);
      assert.equal(stripped.reason, "eslint_suppressed_missing");

      const scanDir = ownedTemp();
      try {
        mkdirSync(join(scanDir, "src"), { recursive: true });
        writeFileSync(join(scanDir, "src", "readme.txt"), "not source\n");
        const scan = collectEslintPair(REPO, scanDir, join(raw, "scan"), "scan");
        assert.ok(scan.fatal);
        assert.notEqual(scan.fatal, null);
      } finally {
        assertSafeTemp(scanDir);
        rmSync(scanDir, { recursive: true, force: true });
      }

      const blocked = join(raw, "blocked-dir");
      mkdirSync(blocked, { recursive: true });
      const missingReport = collectEslintLane(REPO, dir, blocked, true);
      assert.ok(missingReport.fatal);
      assert.notEqual(missingReport.exitCode, 0);

      assert.throws(
        () => collectEslintPair(emptyRepo, dir, join(raw, "missing-bin"), "missing"),
        (err) => err.reason === "node_modules_missing",
      );
    } finally {
      for (const path of [dir, raw, emptyRepo]) {
        assertSafeTemp(path);
        rmSync(path, { recursive: true, force: true });
      }
    }
  });
});
