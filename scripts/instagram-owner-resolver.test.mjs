import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

function assertFrozenPolicy(tokens) {
  for (const required of ["--no-config", "--lock=scripts/ci/deno-analytics.lock", "--frozen"]) {
    assert.ok(tokens.includes(required), `locked command must pass ${required}`);
  }
  assert.ok(!tokens.some((token) => token === "--no-lock" || token.startsWith("--frozen=") ||
    (token.startsWith("--lock") && token !== "--lock=scripts/ci/deno-analytics.lock")),
  "locked command must not override frozen mode or the reviewed lock");
}

test("frozen policy rejects disabled mode and conflicting or lookalike lock tokens", () => {
  const valid = ["--no-config", "--lock=scripts/ci/deno-analytics.lock", "--frozen"];
  assert.doesNotThrow(() => assertFrozenPolicy(valid));
  for (const bad of ["--no-lock", "--frozen=false", "--frozen=true", "--lock=other.lock", "--lock=scripts/ci/deno-analytics.lock.bak"]) {
    assert.throws(() => assertFrozenPolicy([...valid, bad]), assert.AssertionError, bad);
  }
  assert.throws(() => assertFrozenPolicy(valid.map((token) => token === "--frozen" ? "--frozen=false" : token)), assert.AssertionError);
  assert.throws(() => assertFrozenPolicy(valid.filter((token) => token !== "--no-config")), assert.AssertionError);
});

test("owner CI resolver policy ignores hostile local Deno config and lock files", (context) => {
  const workflow = readFileSync(new URL("../.github/workflows/owner-analytics-local.yml", import.meta.url), "utf8");
  const commands = [...workflow.matchAll(/deno (?:check|run) ([^\r\n]+)/g)];
  assert.ok(commands.length >= 3, "check, seed and real composition commands must be present");
  for (const [, args] of commands) {
    const tokens = args.trim().split(/\s+/);
    const explicitFrozenLock = tokens.includes("--lock=scripts/ci/deno-analytics.lock") && tokens.includes("--frozen") && !tokens.some((token) => token.startsWith("--frozen=") || token === "--no-lock");
    assert.ok(tokens.includes("--no-config") && (tokens.includes("--no-lock") || explicitFrozenLock), "all executed Deno roots must ignore ambient resolver files and use no lock or the one reviewed frozen lock");
    assertFrozenPolicy(tokens);
  }
  // package.json discovery makes a frozen lock demand the whole application workspace; every locked command must opt out.
  const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  for (const [command] of ciWorkflow.matchAll(/deno (?:check|test|cache|run) [^\r\n]*--lock=scripts\/ci\/deno-analytics\.lock[^\r\n]*/g)) {
    assert.ok(command.split(/\s+/).includes("--no-config") && command.includes("--frozen"), "a locked analytics command must also pass --no-config and --frozen");
    assertFrozenPolicy(command.split(/\s+/));
  }
  // The one folded multi-line command is read as the shell sees it: its lines joined, then exact tokens.
  const folded = /- name: Test service proxy and MCP\r?\n\s+run: >\r?\n((?:\s{10,}\S[^\r\n]*\r?\n)+)/.exec(ciWorkflow);
  assert.ok(folded, "the service proxy and MCP step must be present");
  const foldedTokens = folded[1].trim().split(/\s+/);
  assert.equal(foldedTokens[0], "deno");
  for (const required of ["--no-config", "--lock=scripts/ci/deno-analytics.lock", "--frozen"]) assert.ok(foldedTokens.includes(required), `service proxy command must pass ${required}`);
  assertFrozenPolicy(foldedTokens);
  const directory = mkdtempSync(join(tmpdir(), "postora-owner-resolver-"));
  context.after(() => {
    const withinTemp = relative(realpathSync(tmpdir()), realpathSync(directory));
    assert.ok(withinTemp && !withinTemp.startsWith(".."));
    rmSync(directory, { recursive: true, force: true });
  });
  writeFileSync(join(directory, "deno.json"), "invalid local config");
  writeFileSync(join(directory, "deno.lock"), "invalid local lock");
  writeFileSync(join(directory, "fixture.ts"), "export const candidate = 1;\n");
  const reviewedLock = fileURLToPath(new URL("./ci/deno-analytics.lock", import.meta.url));
  const policy = commands[0][1].split(/\s+/).filter((arg) => ["--no-config", "--no-lock", "--frozen", "--node-modules-dir=none"].includes(arg))
    .concat(commands[0][1].includes("--lock=scripts/ci/deno-analytics.lock") ? [`--lock=${reviewedLock}`] : []);
  const check = (args) => spawnSync("deno", ["check", ...args, "fixture.ts"], { cwd: directory, encoding: "utf8", timeout: 30_000 });
  const controlled = check(policy);
  assert.ifError(controlled.error);
  assert.equal(controlled.status, 0, controlled.stderr);
  const negative = check(policy.filter((arg) => arg !== "--no-config"));
  assert.ifError(negative.error);
  assert.notEqual(negative.status, 0, "ambient config must break the negative control");
});
