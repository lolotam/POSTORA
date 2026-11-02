import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, basename, resolve } from "node:path";
import { test } from "node:test";
import { assertOwnerExecutionSource, assertPreparedOwnerExecutionSource } from "../../scripts/instagram-owner-execution-source.mjs";
import { OWNER_RELEASE, syntheticOwnerReleaseKey } from "./instagramOwnerReleaseSettings.mjs";
import { scrapeInstagramOfficial } from "../../supabase/functions/brand-scrape/instagramDiscovery.ts";
import {
  assertInstagramReleaseEnvironment, assertInstagramReleaseNetworkUrl,
  assertInstagramReleaseManifest, assertInstagramReleaseCleanupIdentity,
  createInstagramReleaseManifest, InstagramReleaseMetaTransport,
  requireInstagramReleaseLogin, requireInstagramReleaseHealth,
} from "./instagramRelease.ts";

const referenceInstant = "2026-11-02T09:00:00.000Z";

test("canonical fixture refuses public, credential-bearing and unexpected local network requests", () => {
  for (const endpoint of ["http://127.0.0.1:8080/", "http://127.0.0.1:65431/rest/v1/social_accounts"]) {
    assert.doesNotThrow(() => assertInstagramReleaseNetworkUrl(endpoint, "browser"));
  }
  for (const endpoint of ["https://api.postora.cloud", "https://example.test", "http://127.0.0.1:54321", "http://localhost:8080", "http://user:pass@127.0.0.1:65431", "http://127.0.0.1:65435/health"]) {
    assert.throws(() => assertInstagramReleaseNetworkUrl(endpoint, "browser"), /refused/);
  }
  assert.doesNotThrow(() => assertInstagramReleaseNetworkUrl("http://127.0.0.1:65435/health", "server"));
  assert.throws(() => assertInstagramReleaseNetworkUrl("https://graph.facebook.com/v22.0/me", "server"), /refused/);
});

test("inherited credentials and unreviewed Vite exports stop fixture boot", () => {
  assert.doesNotThrow(() => assertInstagramReleaseEnvironment({ PATH: "synthetic-path" }, {}));
  for (const key of ["TEST_USER_EMAIL", "OPENAI_API_KEY", "APIFY_TOKEN", "SUPABASE_SERVICE_ROLE_KEY", "VITE_UNREVIEWED", "DATABASE_URL", "NODE_OPTIONS", "HTTP_PROXY"]) {
    assert.throws(() => assertInstagramReleaseEnvironment({ [key]: "inherited" }, {}), /inherited/);
  }
  assert.doesNotThrow(() => assertInstagramReleaseEnvironment({ VITE_SUPABASE_URL: "http://127.0.0.1:65431" }, { VITE_SUPABASE_URL: "http://127.0.0.1:65431" }));
  assert.throws(() => assertInstagramReleaseEnvironment({ VITE_SUPABASE_URL: "https://api.postora.cloud" }, { VITE_SUPABASE_URL: "http://127.0.0.1:65431" }), /inherited/);
});

test("malformed manifest and foreign cleanup identities are refused before persistence", () => {
  const manifest = createInstagramReleaseManifest(referenceInstant);
  assert.doesNotThrow(() => assertInstagramReleaseManifest(manifest));
  for (const malformed of [{}, { ...manifest, namespace: "production" }, { ...manifest, referenceInstant: "yesterday" },
    { ...manifest, users: { ...manifest.users, ownerB: manifest.users.ownerA } },
    { ...manifest, users: { ...manifest.users, extraOwner: manifest.users.ownerA } },
    { ...manifest, accounts: manifest.accounts.map((account) => ({ ...account, providerId: "release_foreign" })) },
    { ...manifest, watchlists: [] }]) {
    assert.throws(() => assertInstagramReleaseManifest(malformed), /fixture/);
  }
  const identity = manifest.users.ownerA;
  assert.doesNotThrow(() => assertInstagramReleaseCleanupIdentity(manifest, { ...identity, app_metadata: { instagram_release_namespace: manifest.namespace } }));
  for (const foreign of [{ ...identity, id: crypto.randomUUID() }, { ...identity, email: "real@example.com" }, { ...identity, app_metadata: {} }]) {
    assert.throws(() => assertInstagramReleaseCleanupIdentity(manifest, foreign), /cleanup/);
  }
});

test("shared synthetic signing extraction preserves both existing owner-release JWTs", async () => {
  const encode = (payload: unknown) => Buffer.from(JSON.stringify(payload)).toString("base64url");
  for (const role of ["anon", "service_role"] as const) {
    const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role, iss: "supabase", exp: 4_102_444_800 })}`;
    const expected = `${unsigned}.${createHmac("sha256", OWNER_RELEASE.signingSecret).update(unsigned).digest("base64url")}`;
    assert.equal(await syntheticOwnerReleaseKey(role), expected);
  }
});

test("missing services, malformed health and failed login cannot begin an assembled journey", async () => {
  for (const response of [new Response(null, { status: 503 }), Response.json({ fixture: "isolated-owner-release" }), Response.json({ fixture: "instagram-release", authReachable: true, sqlReachable: false })]) {
    await assert.rejects(() => requireInstagramReleaseHealth(response), /fixture/);
  }
  for (const response of [new Response(null, { status: 401 }), Response.json({ access_token: "synthetic", user: { id: "foreign" } })]) {
    await assert.rejects(() => requireInstagramReleaseLogin(response, crypto.randomUUID()), /login/);
  }
});

test("provider transport requires exact synthetic authority, host, grammar and bounded calls", async () => {
  const manifest = createInstagramReleaseManifest(referenceInstant);
  const transport = new InstagramReleaseMetaTransport(manifest);
  const account = manifest.accounts.find((entry) => entry.key === "pageGranted")!;
  const endpoint = new URL(`https://graph.facebook.com/v22.0/${account.providerId}`);
  endpoint.search = new URLSearchParams({ fields: "followers_count,media_count", access_token: account.token }).toString();
  assert.equal((await transport.reply(new Request(endpoint))).status, 200);
  assert.equal(transport.calls.length, 1);
  endpoint.searchParams.set("access_token", "foreign");
  await assert.rejects(() => transport.reply(new Request(endpoint)), /authority/);
  endpoint.searchParams.set("access_token", account.token);
  endpoint.searchParams.set("fields", "unreviewed_field");
  await assert.rejects(() => transport.reply(new Request(endpoint)), /request/);
  await assert.rejects(() => transport.reply(new Request("https://api.apify.com/v2/acts")), /request/);
  endpoint.searchParams.set("fields", "followers_count,media_count");
  for (let index = transport.calls.length; index < 500; index += 1) await transport.reply(new Request(endpoint));
  await assert.rejects(() => transport.reply(new Request(endpoint)), /budget/);
  assert.ok(transport.calls.every((call) => !JSON.stringify(call).includes(account.token)));
});

test("remote Docker overrides and default contexts refuse before container inspection", () => {
  const previousHost = process.env.DOCKER_HOST;
  const commands: string[][] = [];
  const execute = (_program: string, args: string[]) => {
    commands.push(args);
    assert.deepEqual(args, ["context", "inspect"]);
    return JSON.stringify([{ Endpoints: { docker: { Host: "ssh://remote-production" } } }]);
  };
  try {
    process.env.DOCKER_HOST = "tcp://86.48.2.205:2376";
    assert.throws(() => assertPreparedOwnerExecutionSource("unused", execute), /local Docker/);
    assert.deepEqual(commands, []);
    delete process.env.DOCKER_HOST;
    assert.throws(() => assertPreparedOwnerExecutionSource("unused", execute), /local Docker/);
    assert.deepEqual(commands, [["context", "inspect"]]);
  } finally {
    if (previousHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = previousHost;
  }
});

test("synthetic public target keeps identity, formats and nulls through the real discovery adapter for both viewers", async () => {
  const manifest = createInstagramReleaseManifest(referenceInstant);
  const transport = new InstagramReleaseMetaTransport(manifest);
  const captures = [];
  for (const key of ["pageGranted", "otherPage"] as const) {
    const account = manifest.accounts.find((entry) => entry.key === key)!;
    const capture = await scrapeInstagramOfficial({ username: "release_competitor", viewerIgUserId: account.providerId,
      accessToken: account.token, maxPosts: 50, fetchFn: (input, init) => transport.reply(new Request(input, init)) });
    assert.equal(capture.source, "official");
    assert.equal(capture.profile.followersCount, 120);
    assert.deepEqual(capture.posts.map((post) => [post.mediaType, post.likesCount, post.videoViewCount]), [["REEL", null, 300], ["VIDEO", 20, null]]);
    captures.push(capture);
  }
  assert.deepEqual(captures[0].posts.map((post) => post.id), captures[1].posts.map((post) => post.id));
  assert.deepEqual(transport.calls.map((call) => call.account), ["pageGranted", "pageGranted", "otherPage", "otherPage"]);
});

test("canonical config dirt and untracked fixture inputs fail immutable candidate provenance", () => {
  const root = mkdtempSync(join(tmpdir(), "instagram-release-source-safety-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  try {
    git("init");
    git("config", "user.email", "fixture@example.test");
    git("config", "user.name", "Fixture safety");
    writeFileSync(join(root, "playwright.instagram-release.config.ts"), "export default {};\n");
    git("add", "."); git("commit", "-m", "Fixture candidate");
    const candidate = git("rev-parse", "HEAD");
    assert.equal(assertOwnerExecutionSource(root, candidate), candidate);
    writeFileSync(join(root, "playwright.instagram-release.config.ts"), "export default { changed: true };\n");
    assert.throws(() => assertOwnerExecutionSource(root, candidate));
    git("restore", "playwright.instagram-release.config.ts");
    mkdirSync(join(root, "e2e", "fixtures"), { recursive: true });
    writeFileSync(join(root, "e2e", "fixtures", "instagramReleaseSeed.ts"), "export {};\n");
    assert.throws(() => assertOwnerExecutionSource(root, candidate), /uncommitted/);
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("instagram-release-source-safety-"));
    rmSync(root, { recursive: true, force: true });
  }
});
