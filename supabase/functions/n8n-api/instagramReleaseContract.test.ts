/** Playwright assembled lane: actual Auth, SQL, API and registered MCP; no report stubs. */
import { createHash } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { INSTAGRAM_RELEASE, requireInstagramReleaseHealth, type InstagramReleaseManifest } from "../../../e2e/fixtures/instagramRelease.ts";
import { syntheticOwnerReleaseKey } from "../../../e2e/fixtures/instagramOwnerReleaseSettings.mjs";
import type { OwnerReport } from "../instagram-insights-report/contracts.ts";

let manifest: InstagramReleaseManifest;
let serviceKey: string;
let ownerKey: string;
let ownerJwt: string;
let accountId: string;
let otherAccountId: string;
let clientCreated = false;
let readToken: string;
let noScopeToken: string;
let candidate: string;

function controlHeaders() {
  return { Authorization: `Bearer ${serviceKey}`, "X-Instagram-Release-Namespace": manifest.namespace,
    "X-Instagram-Release-Candidate": candidate };
}

async function rest(request: APIRequestContext, path: string, method = "GET", data?: unknown) {
  // All setup is confined to the independently source-checked, namespace-owned local fixture.
  return request.fetch(`${INSTAGRAM_RELEASE.apiUrl}/rest/v1/${path}`, {
    method, headers: { Authorization: `Bearer ${serviceKey}`, Prefer: "return=representation" }, data,
  });
}

async function mcp(request: APIRequestContext, token: string, args: Record<string, unknown>, method = "tools/call") {
  const response = await request.post(`${INSTAGRAM_RELEASE.apiUrl}/functions/v1/mcp/read`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    data: { jsonrpc: "2.0", id: 1, method, params: method === "tools/list" ? {} : { name: "get_post_analytics", arguments: args } },
  });
  expect(response.status()).toBe(200);
  const envelope = await response.json();
  expect(envelope.error).toBeUndefined();
  return envelope.result as { isError?: boolean; content: { type: string; text: string }[]; tools?: { name: string }[] };
}

async function api(request: APIRequestContext, args: Record<string, string | number>) {
  return request.get(`${INSTAGRAM_RELEASE.apiUrl}/functions/v1/n8n-api/api/v1/analytics`, {
    headers: { "x-api-key": ownerKey }, params: args,
  });
}

function comparable(report: OwnerReport, days: number, started: number, finished: number) {
  // Assembly uses a rolling clock. Validate it explicitly; compare every stored/report field unchanged.
  const generated = Date.parse(report.generatedAt);
  expect(generated).toBeGreaterThanOrEqual(started);
  expect(generated).toBeLessThanOrEqual(finished);
  expect(report.period.windowEnd).toBe(report.generatedAt);
  expect(Date.parse(report.period.windowEnd) - Date.parse(report.period.windowStart)).toBe(days * 86_400_000);
  const { generatedAt: _generatedAt, period, ...stored } = report;
  const { windowStart: _windowStart, windowEnd: _windowEnd, ...calendar } = period;
  return { ...stored, period: calendar };
}

test.beforeAll(async ({ request }) => {
  const health = await request.get(`${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/health`);
  manifest = await requireInstagramReleaseHealth(new Response(await health.body(), { status: health.status() }));
  const receipt = await (await request.get(`${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/health`)).json();
  candidate = receipt.candidate;
  serviceKey = await syntheticOwnerReleaseKey("service_role");
  accountId = manifest.accounts.find((account) => account.key === "pageGranted")!.id;
  otherAccountId = manifest.accounts.find((account) => account.key === "otherPage")!.id;
  const profiles = await rest(request, `profiles?id=eq.${manifest.users.ownerA.id}&select=id,api_key`);
  expect(profiles.status()).toBe(200);
  const rows = await profiles.json();
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBe(manifest.users.ownerA.id);
  expect(rows[0].api_key).toMatch(/^postora-/);
  ownerKey = rows[0].api_key;
  const login = await request.post(`${INSTAGRAM_RELEASE.apiUrl}/auth/v1/token?grant_type=password`, {
    data: { email: manifest.users.ownerA.email, password: INSTAGRAM_RELEASE.password },
  });
  expect(login.status()).toBe(200);
  const session = await login.json();
  expect(session.user.id).toBe(manifest.users.ownerA.id);
  ownerJwt = session.access_token;
  const client = await rest(request, "mcp_oauth_clients", "POST", {
    client_id: manifest.namespace, client_name: "Canonical Instagram release fixture", redirect_uris: [],
  });
  expect(client.status()).toBe(201);
  clientCreated = true;
  readToken = `synthetic-${manifest.namespace}-posts-read`;
  noScopeToken = `synthetic-${manifest.namespace}-no-posts-read`;
  const tokens = await rest(request, "mcp_oauth_tokens", "POST", [
    { token: readToken, scopes: ["posts:read"] }, { token: noScopeToken, scopes: ["accounts:read"] },
  ].map(({ token, scopes }) => ({ client_id: manifest.namespace, user_id: manifest.users.ownerA.id,
    token_hash: createHash("sha256").update(token).digest("base64url"), scopes,
    expires_at: new Date(Date.now() + 3_600_000).toISOString() })));
  expect(tokens.status()).toBe(201);
});

test.afterEach(async ({ request }) => {
  const response = await request.get(`${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/provider-calls`, { headers: controlHeaders() });
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ calls: [], networkRefusals: 0 });
});

test.afterAll(async ({ request }) => {
  if (clientCreated) {
    const response = await rest(request, `mcp_oauth_clients?client_id=eq.${manifest.namespace}`, "DELETE");
    expect(response.status()).toBe(200);
    expect(await response.json()).toHaveLength(1);
  }
});

test("SQL-backed Instagram reports retain metrics, nulls, outliers and freshness through API and scoped MCP", async ({ request }) => {
  const tools = await mcp(request, readToken, {}, "tools/list");
  expect(tools.tools?.filter((tool) => tool.name === "get_post_analytics")).toHaveLength(1);
  for (const days of [7, 14, 30, 90]) {
    const started = Date.now();
    const direct = await request.post(`${INSTAGRAM_RELEASE.apiUrl}/functions/v1/instagram-insights-report`, {
      headers: { Authorization: `Bearer ${ownerJwt}` },
      data: { social_account_id: accountId, period_days: days, user_id: manifest.users.ownerB.id },
    });
    expect(direct.status()).toBe(200);
    const report = await direct.json() as OwnerReport;
    const throughApi = await api(request, { social_account_id: accountId, period_days: days });
    expect(throughApi.status()).toBe(200);
    const apiReport = await throughApi.json() as OwnerReport;
    const throughMcp = await mcp(request, readToken, { social_account_id: accountId, period_days: days });
    expect(throughMcp.isError).not.toBe(true);
    const mcpReport = JSON.parse(throughMcp.content[0].text) as OwnerReport;
    const finished = Date.now();
    const expected = comparable(report, days, started, finished);
    expect(comparable(apiReport, days, started, finished)).toEqual(expected);
    expect(comparable(mcpReport, days, started, finished)).toEqual(expected);
    expect(report.scope).toEqual({ ownerId: manifest.users.ownerA.id, socialAccountId: accountId, platform: "instagram" });
    expect(report.source).toBe("graph_own");
    expect(report.freshness).toMatchObject({ status: "never", lastSuccessAt: null });
    const media = report.media.page.items;
    // These observations are inside every window; history_4/5 sit outside the rolling seven-day window.
    expect(media.find((item) => item.mediaId.endsWith("_six_baseline_0"))?.metrics.views).toBeNull();
    expect(media.find((item) => item.mediaId.endsWith("_midnight_0"))?.metrics.views).toBe(0);
    expect(media.find((item) => item.mediaId.endsWith("_history_0"))?.outlier).toMatchObject({ score: 3, label: "outlier", baselineMedian: 100 });
    const zeroReach = media.filter((item) => item.metrics.reach === 0);
    expect(zeroReach.length).toBeGreaterThan(0);
    expect(zeroReach.every((item) => item.engagementRate.value === null)).toBe(true);
    expect(report.account.daily.some((day) => day.reach === null)).toBe(true);
    expect(report.account.daily.some((day) => day.reach === 0)).toBe(true);
    expect(report.lagNote).toBe("provider_data_may_lag_up_to_48h");
  }
});

test("registered analytics routes refuse foreign owners, missing scopes and cursors without inventing Instagram capability", async ({ request }) => {
  const missing = crypto.randomUUID();
  const responses: unknown[] = [];
  const directResponses: unknown[] = [];
  for (const id of [otherAccountId, missing]) {
    const response = await api(request, { social_account_id: id });
    expect(response.status()).toBe(404);
    responses.push(await response.json());
    const direct = await request.post(`${INSTAGRAM_RELEASE.apiUrl}/functions/v1/instagram-insights-report`, {
      headers: { Authorization: `Bearer ${ownerJwt}` }, data: { social_account_id: id, user_id: manifest.users.ownerB.id },
    });
    expect(direct.status()).toBe(404);
    directResponses.push(await direct.json());
  }
  expect(responses[0]).toEqual(responses[1]);
  expect(directResponses[0]).toEqual(directResponses[1]);
  const foreign = await mcp(request, readToken, { social_account_id: otherAccountId });
  const nonexistent = await mcp(request, readToken, { social_account_id: missing });
  expect(foreign).toEqual(nonexistent);
  expect(foreign.isError).toBe(true);
  expect(foreign.content[0].text).toContain("Postora API error 404:");
  const denied = await mcp(request, noScopeToken, { social_account_id: accountId });
  expect(denied.isError).toBe(true);
  expect(denied.content[0].text).toContain("Postora API error 403:");
  expect(denied.content[0].text).toContain("posts:read");
  const audit = await rest(request, `system_logs?user_id=eq.${manifest.users.ownerA.id}&source=eq.mcp&select=metadata`);
  expect(audit.status()).toBe(200);
  expect(await audit.json()).toContainEqual({ metadata: { tool: "get_post_analytics", code: "SCOPE_NOT_GRANTED" } });
  const invalid = await api(request, { social_account_id: accountId, cursor: "invalid" });
  expect(invalid.status()).toBe(400);
  expect((await invalid.json()).error.code).toBe("INVALID_CURSOR");
  const invalidMcp = await mcp(request, readToken, { social_account_id: accountId, cursor: "invalid" });
  expect(invalidMcp.isError).toBe(true);
  expect(invalidMcp.content[0].text).toContain("INVALID_CURSOR");
  const canonical = await api(request, { social_account_id: accountId, analyticsContractVersion: 1 });
  expect(canonical.status()).toBe(409);
  expect(await canonical.json()).toMatchObject({ ok: false, reason: "window_mismatch" });
  const canonicalMcp = await mcp(request, readToken, { social_account_id: accountId, analyticsContractVersion: 1 });
  expect(canonicalMcp.isError).toBe(true);
  expect(canonicalMcp.content[0].text).toContain("window_mismatch");
});
