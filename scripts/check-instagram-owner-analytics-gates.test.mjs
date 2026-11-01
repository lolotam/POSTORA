import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { inventoryOwnerCandidate, OWNER_RUNTIME_ROOTS } from "./check-instagram-owner-analytics-gates.mjs";

const CHECKER = fileURLToPath(new URL("./check-instagram-owner-analytics-gates.mjs", import.meta.url));

function fixtureRepository(testContext) {
  const directory = mkdtempSync(join(tmpdir(), "postora-owner-manifest-"));
  testContext.after(() => {
    const withinTemp = relative(realpathSync(tmpdir()), realpathSync(directory));
    assert.ok(withinTemp && !withinTemp.startsWith("..") && !resolve(directory).endsWith(".."));
    rmSync(directory, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync("git", ["-C", directory, ...args], { stdio: "pipe" }).toString().trim();
  const put = (path, source) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), source);
  };
  git("init", "--quiet");
  for (const path of OWNER_RUNTIME_ROOTS) put(path, "export const handler = () => new Response();\n");
  put(OWNER_RUNTIME_ROOTS[0], 'import { readHistory } from "./readHistory.ts";\nexport const handler = () => readHistory();\n');
  put("supabase/functions/instagram-insights-report/readHistory.ts", 'export const readHistory = () => "fixture";\n');
  for (const path of [
    "src/features/instagram-insights/ui/InstagramPerformanceScreen.tsx",
    "src/pages/analytics/InstagramAnalytics.tsx", "src/i18n/locales/ar/analytics.json",
    "src/integrations/supabase/types.ts", "supabase/config.toml", "package.json",
    "package-lock.json", ".github/workflows/ci.yml",
  ]) put(path, "{}\n");
  const commit = () => {
    git("add", "--all");
    git("-c", "user.name=Owner Manifest Test", "-c", "user.email=owner-manifest@example.test", "commit", "--quiet", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  return { directory, put, commit };
}

test("hashes committed dependency bytes despite dirty checkout and never grants release readiness", (context) => {
  const fixture = fixtureRepository(context);
  fixture.put("src/features/analytics-contract/index.ts", 'export { summarizeDailyMetricValues } from "./domain/metricValue";\n');
  fixture.put("supabase/functions/_shared/analyticsContract.ts", 'export const summarizeDailyMetricValues = () => "canonical fixture";\n');
  const candidate = fixture.commit();
  fixture.put("supabase/functions/instagram-insights-report/readHistory.ts", "dirty checkout\n");
  fixture.put("supabase/functions/_shared/analyticsContract.ts", "dirty metric contract\n");
  const manifest = inventoryOwnerCandidate(fixture.directory, candidate);
  const dependency = manifest.runtimeFiles.find((file) => file.path.endsWith("/readHistory.ts"));
  assert.equal(dependency.sha256, createHash("sha256").update('export const readHistory = () => "fixture";\n').digest("hex"));
  assert.equal(manifest.runtimeFiles.length, 5);
  assert.equal(manifest.frontendAndConfigFiles.find((file) => file.path === "supabase/functions/_shared/analyticsContract.ts").sha256,
    createHash("sha256").update('export const summarizeDailyMetricValues = () => "canonical fixture";\n').digest("hex"));
  assert.equal(manifest.releaseReady, false);
  assert.equal(manifest.canonicalTask11GX, "not_evaluated");
});

test("refuses a frontend analytics bundle whose canonical metric source is absent", (context) => {
  const fixture = fixtureRepository(context);
  fixture.put("src/features/analytics-contract/index.ts", 'export { summarizeDailyMetricValues } from "./domain/metricValue";\n');
  assert.throws(() => inventoryOwnerCandidate(fixture.directory, fixture.commit()), /Missing canonical analytics metric contract/);
});

for (const [name, dependency] of [
  ["missing dependency", 'import "./missing.ts";'],
  ["runtime escape", 'import "../../../outside.ts";'],
  ["computed dynamic import", 'const target = "./readHistory.ts"; import(target);'],
]) {
  test(`refuses ${name}`, (context) => {
    const fixture = fixtureRepository(context);
    fixture.put(OWNER_RUNTIME_ROOTS[0], dependency);
    const candidate = fixture.commit();
    assert.throws(() => inventoryOwnerCandidate(fixture.directory, candidate));
  });
}

test("CLI verification rejects a changed recorded hash", (context) => {
  const fixture = fixtureRepository(context);
  const candidate = fixture.commit();
  const manifestPath = join(fixture.directory, "manifest.json");
  const run = (...args) => spawnSync(process.execPath, [CHECKER, ...args], { cwd: fixture.directory, encoding: "utf8" });
  assert.equal(run("--candidate", candidate, "--out", manifestPath).status, 0);
  assert.equal(run("--verify", manifestPath).status, 0);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.runtimeFiles[0].sha256 = "0".repeat(64);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.notEqual(run("--verify", manifestPath).status, 0);
});
