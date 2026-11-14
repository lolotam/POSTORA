import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveOwnerDatabaseInputs } from "./instagram-owner-execution-source.mjs";
import { test } from "node:test";
import { assertLocalDockerSocket } from "../e2e/fixtures/instagramOwnerReleaseSafety.mjs";

test("Auth port override retains loopback isolation and refuses unsafe or colliding ports", () => {
  const settings = new URL("../e2e/fixtures/instagramOwnerReleaseSettings.mjs", import.meta.url).href;
  const script = `import { OWNER_RELEASE } from ${JSON.stringify(settings)}; console.log(OWNER_RELEASE.authUrl);`;
  const read = (port) => execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, POSTORA_OWNER_RELEASE_AUTH_PORT: port }, encoding: "utf8", stdio: "pipe",
  });
  assert.equal(read("65437").trim(), "http://127.0.0.1:65437");
  for (const port of ["80", "8080", "65431", "65436", "65536", "https://example.test", "65435/path"]) {
    assert.throws(() => read(port));
  }
});

test("fixture socket guard accepts local pipes and refuses remote or ambiguous Docker endpoints", () => {
  for (const endpoint of ["unix:///var/run/docker.sock", "npipe:////./pipe/dockerDesktopLinuxEngine"]) {
    assert.doesNotThrow(() => assertLocalDockerSocket(endpoint));
  }
  for (const endpoint of ["ssh://contabo", "tcp://86.48.2.205:2376", "tcp://127.0.0.1:2375", "npipe:////remote/pipe/docker_engine", "unix://remote/docker.sock", null, ""]) {
    assert.throws(() => assertLocalDockerSocket(endpoint));
  }
});

test("documented Deno seed and server permissions honor the selected Auth endpoint", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "postora-owner-command-"));
  context.after(() => {
    const withinTemp = relative(realpathSync(tmpdir()), realpathSync(directory));
    assert.ok(withinTemp && !withinTemp.startsWith(".."));
    rmSync(directory, { recursive: true, force: true });
  });
  const server = createServer((_request, response) => response.end("synthetic-auth"));
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  context.after(() => new Promise((done) => server.close(done)));
  const port = server.address().port;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const settings = new URL("../e2e/fixtures/instagramOwnerReleaseSettings.mjs", import.meta.url).href;
  const entry = join(directory, "probe.mjs");
  writeFileSync(entry, `import { OWNER_RELEASE } from ${JSON.stringify(settings)};
    if (OWNER_RELEASE.authUrl !== "http://127.0.0.1:${port}") throw new Error("Auth override lost");
    if (await (await fetch(OWNER_RELEASE.authUrl)).text() !== "synthetic-auth") throw new Error("Wrong endpoint");`);
  const doc = readFileSync(join(root, "docs/runbooks/instagram-owner-analytics-release.md"), "utf8");
  const commands = doc.split(/\r?\n/).filter((line) => /^deno run .*e2e\/fixtures\/instagramOwnerRelease(?:Seed|Server)\.ts$/.test(line));
  assert.equal(commands.length, 2);
  for (const command of commands) {
    // Execute the documented permission arguments against a real loopback
    // transport. Only the entrypoint is replaced; no fixture data is mutated.
    const options = command.slice("deno ".length).replace(/e2e\/fixtures\/\S+$/, "").match(/"[^"]*"|\S+/g)
      .map((token) => token.replaceAll('"', "").replace("$ownerAuthEndpoint", `127.0.0.1:${port}`));
    const result = await new Promise((done, reject) => {
      const child = spawn("deno", [...options, entry], { cwd: root,
        env: { ...process.env, POSTORA_OWNER_RELEASE_AUTH_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.on("error", reject);
      child.on("close", (code) => done({ code, output }));
    });
    assert.equal(result.code, 0, result.output);
  }
});

test("the immutable database archive includes the SQL files referenced by its suites", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "postora-owner-database-archive-"));
  context.after(() => {
    const withinTemp = relative(realpathSync(tmpdir()), realpathSync(directory));
    assert.ok(withinTemp && !withinTemp.startsWith(".."));
    rmSync(directory, { recursive: true, force: true });
  });
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const candidate = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const archive = join(directory, "database-inputs.tar");
  archiveOwnerDatabaseInputs({ root, candidate, archive });
  const extracted = join(directory, "checkout");
  mkdirSync(extracted);
  execFileSync("tar", ["-xf", archive, "-C", extracted]);
  const suite = join(extracted, "supabase/tests/agent_handoff_retirement.sql");
  const dependency = readFileSync(suite, "utf8").match(/^\\ir (.+)$/m)?.[1];
  assert.ok(dependency, "the retirement suite must exercise the production contract script");
  const contract = readFileSync(resolve(dirname(suite), dependency.trim()), "utf8");
  assert.match(contract, /old_edge_workers_drained/);
});
