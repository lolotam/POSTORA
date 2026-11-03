import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

function assertFrozenPolicy(tokens) {
  const boundary = tokens.findIndex((token) => token === "--" ||
    (!token.startsWith("-") && !["deno", "cache", "check", "test", "run"].includes(token)));
  const options = boundary < 0 ? tokens : tokens.slice(0, boundary);
  for (const required of ["--no-config", "--lock=scripts/ci/deno-analytics.lock", "--frozen"]) {
    assert.ok(tokens.includes(required), `locked command must pass ${required}`);
    assert.ok(options.includes(required), `Deno option must precede the entrypoint: ${required}`);
  }
  assert.ok(options.includes("--import-map=scripts/ci/deno-analytics.import-map.json"), "selected roots require the reviewed local map before the entrypoint");
  assert.ok(!tokens.some((token) => token === "--no-lock" || token.startsWith("--frozen=") ||
    (token.startsWith("--import-map") && token !== "--import-map=scripts/ci/deno-analytics.import-map.json") ||
    (token.startsWith("--lock") && token !== "--lock=scripts/ci/deno-analytics.lock")),
  "locked command must not override frozen mode or the reviewed lock");
}

const ciSteps = [
  "Typecheck and test owned analytics coordination|check,test",
  "Prove owned analytics dependency termination with real timeout ceilings|test",
  "Typecheck and test persisted owned analytics reports|check,test",
  "Typecheck and test competitor discovery (brand-scrape)|check,test",
  "Test service proxy and MCP|test",
  "Test Threads insights account selection through real composition|test",
  "Test owned Facebook Page analytics through real composition|test",
  "Typecheck and test the owner-report contract|check,test",
  "Typecheck and test protected Meta credential readers and refusals|test",
  "Typecheck and test actual protected Meta request handlers|test",
  "Typecheck and test the authenticated owner intake contract|check,test",
  "Typecheck and test the actual owner intake route|check,test",
  "Typecheck and test the owner collection worker|check,test",
  "Typecheck and test the owner rollout controls|check,test",
  "Typecheck and test the competitor collection worker|check,test",
  "Typecheck and test the actual competitor collection route|check,test",
  "Typecheck and test the competitor tracking report|check,test",
  "Typecheck and test the actual competitor tracking report route|check,test",
  "Typecheck and test the competitor retention function|check,test",
  "Typecheck and test the actual competitor retention route|check,test",
  "Typecheck and test the rollout integration suites|check,test,test",
  "Verify owned analytics workers and stored schedules against real SQL|test",
];
const ownerSteps = [
  "Check and cache the canonical composition|cache,check",
  "Check fixture safety and artifact inventory tooling|check",
  "Seed synthetic identities through real Auth|run",
  "Start real composition roots with synthetic Meta transport|run",
];

// Recognize only these existing named steps and their literal, continued or folded commands.
function assertSelectedSteps(source, expected) {
  const blocks = source.replaceAll("\r\n", "\n").split(/^      - name: /m).slice(1);
  for (const entry of expected) {
    const [name, verbs] = entry.split("|");
    const selected = blocks.filter((block) => block.startsWith(`${name}\n`));
    assert.equal(selected.length, 1, `required unique step: ${name}`);
    const block = selected[0].replace(/\\\n\s*/g, " ")
      .replace(/run: >-?\n((?: {10,}[^\n]*\n)+)/g,
        (_, body) => `run: ${body.trim().replace(/\n\s*/g, " ")}\n`);
    const commands = [...block.matchAll(/(?:^|\n)\s*(?:run: )?deno (cache|check|test|run) ([^\n]+)/g)];
    assert.deepEqual(commands.map((command) => command[1]), verbs.split(","), `recognized commands in ${name}`);
    for (const [, verb, args] of commands) assertFrozenPolicy([verb, ...args.trim().split(/\s+/)]);
  }
}

test("selected workflow commands cannot escape policy through removal, renaming or argument placement", () => {
  for (const [file, expected] of [["ci.yml", ciSteps], ["owner-analytics-local.yml", ownerSteps]]) {
    const source = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
    assertSelectedSteps(source, expected);
    assert.throws(() => assertSelectedSteps(source.replace("deno check", "deno unrecognized"), expected), assert.AssertionError);
    for (const flag of ["--lock=scripts/ci/deno-analytics.lock ", "--frozen ", "--no-config ", "--import-map=scripts/ci/deno-analytics.import-map.json "]) {
      assert.throws(() => assertSelectedSteps(source.replace(flag, ""), expected), assert.AssertionError);
    }
    const name = expected[0].split("|")[0];
    assert.throws(() => assertSelectedSteps(source.replace(name, "Renamed step"), expected), assert.AssertionError);
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const withoutStep = source.replace(new RegExp(`      - name: ${escapedName}[^]*?(?=      - name:)`), "");
    assert.throws(() => assertSelectedSteps(withoutStep, expected), assert.AssertionError);
    assertSelectedSteps(`${source}\n      - name: Unrelated unlocked step\n        run: deno test --no-lock other.test.ts\n`, expected);
  }
  const required = ["--no-config", "--lock=scripts/ci/deno-analytics.lock", "--frozen", "--import-map=scripts/ci/deno-analytics.import-map.json"];
  for (const prefix of [["run", "fixture.ts"], ["run", "--", "fixture.ts"]]) {
    assert.throws(() => assertFrozenPolicy([...prefix, ...required]), assert.AssertionError);
  }
  const owner = readFileSync(new URL("../.github/workflows/owner-analytics-local.yml", import.meta.url), "utf8");
  assert.ok(owner.split("permissions:")[0].includes('      - ".github/workflows/ci.yml"'), "CI-only edits must trigger this gate");
  assert.ok(owner.split("permissions:")[0].includes('      - "scripts/ci/deno-analytics.import-map.json"'), "map-only edits must trigger this gate");
  assert.ok(owner.split("permissions:")[0].includes('      - "supabase/functions/_shared/**"'), "vendor-only edits must trigger this gate");
  const playwright = readFileSync(new URL("../playwright.instagram-release.config.ts", import.meta.url), "utf8");
  const command = /command: "deno run ([^"]+)"/.exec(playwright);
  assert.ok(command, "canonical Playwright Deno invocation required");
  assertFrozenPolicy(["run", ...command[1].split(/\s+/)]);
});

test("the one-URL local map binds the retained expected module and license bytes", () => {
  const map = JSON.parse(readFileSync(new URL("./ci/deno-analytics.import-map.json", import.meta.url), "utf8"));
  const url = "https://esm.sh/tslib@2.8.1/denonext/tslib.mjs";
  assert.deepEqual(map, { imports: { [url]: "../../supabase/functions/_shared/vendor/tslib-2.8.1.mjs" } });
  for (const [name, size, expected] of [
    ["tslib-2.8.1.mjs", 11226, "c38da5dd6da6281964435002ce204cd586634fe3bdfb24a0ee116f48cf3292e9"],
    ["tslib-2.8.1.LICENSE.txt", 655, "210b19e543130388c68654b7497e967119ce17145f66ab7d85688fbd70f08751"],
  ]) {
    const bytes = readFileSync(new URL(`../supabase/functions/_shared/vendor/${name}`, import.meta.url));
    assert.equal(bytes.length, size);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected);
    const synthetic = Buffer.from(bytes);
    synthetic[0] ^= 1;
    assert.notEqual(createHash("sha256").update(synthetic).digest("hex"), expected, "local hash negative control");
  }
});

test("cached synthetic remote importer resolves its transitive URL through the local map without network permissions", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "postora-transitive-map-"));
  context.after(() => {
    const withinTemp = relative(realpathSync(tmpdir()), realpathSync(directory));
    assert.ok(withinTemp && !withinTemp.startsWith(".."));
    rmSync(directory, { recursive: true, force: true });
  });
  const url = "https://esm.sh/postora-synthetic-parent.mjs";
  const cache = join(directory, "cache", "remote", "https", "esm.sh");
  mkdirSync(cache, { recursive: true });
  const key = createHash("sha256").update("/postora-synthetic-parent.mjs").digest("hex");
  const parent = 'export { candidate } from "/tslib@2.8.1/denonext/tslib.mjs";';
  writeFileSync(join(cache, key), `${parent}\n// denoCacheMetadata=${JSON.stringify({ url, headers: { "content-type": "application/javascript" }, time: 1793729061 })}`);
  writeFileSync(join(directory, "leaf.ts"), "export const candidate = 42;\n");
  writeFileSync(join(directory, "entry.ts"), `import { candidate } from "${url}"; if (candidate !== 42) throw Error("wrong leaf"); console.log("synthetic-transitive-map-ok");`);
  const mapPath = join(directory, "map.json");
  const writeMap = (target) => writeFileSync(mapPath, JSON.stringify({ imports: { "https://esm.sh/tslib@2.8.1/denonext/tslib.mjs": target } }));
  writeMap("./leaf.ts");
  const args = ["run", "--cached-only", "--no-config", "--no-lock", `--import-map=${mapPath}`, "entry.ts"];
  const run = (flags) => spawnSync("deno", flags, { cwd: directory, encoding: "utf8", timeout: 15_000,
    env: { ...process.env, DENO_DIR: join(directory, "cache") } });
  const positive = run(args);
  assert.ifError(positive.error);
  assert.equal(positive.status, 0, positive.stderr);
  assert.match(positive.stdout, /synthetic-transitive-map-ok/);
  const missingMap = run(args.filter((arg) => !arg.startsWith("--import-map=")));
  assert.ifError(missingMap.error);
  assert.notEqual(missingMap.status, 0, "cached-only must refuse the unmapped remote dependency");
  assert.match(missingMap.stderr, /not found in cache|not cached|cached-only/i);
  writeMap("./missing-leaf.ts");
  const wrongMap = run(args);
  assert.ifError(wrongMap.error);
  assert.notEqual(wrongMap.status, 0, "wrong local mapping must refuse");
});

test("frozen policy rejects disabled mode and conflicting or lookalike lock tokens", () => {
  const valid = ["--no-config", "--lock=scripts/ci/deno-analytics.lock", "--frozen", "--import-map=scripts/ci/deno-analytics.import-map.json"];
  assert.doesNotThrow(() => assertFrozenPolicy(valid));
  for (const bad of ["--no-lock", "--frozen=false", "--frozen=true", "--lock=other.lock", "--lock=scripts/ci/deno-analytics.lock.bak", "--import-map=other.json"]) {
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
    assert.ok(tokens.includes("--no-config") && (tokens.includes("--no-lock") || explicitFrozenLock), "generic resolver flags required; selected roots additionally require the reviewed frozen lock and map");
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
