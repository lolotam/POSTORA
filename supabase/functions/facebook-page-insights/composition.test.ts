import { assertEquals, assertFalse, assertNotEquals, assertRejects, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { closedAnalyticsPeriods, analyticsWindowForPeriod } from "../_shared/analyticsCalendar.ts";
import { parseAnalyticsReport } from "../_shared/analyticsSchema.ts";
import { analyticsCursorScope, decodeAnalyticsCursor, AnalyticsCursorError } from "../_shared/metaAnalyticsCursor.ts";
import { metricDelta } from "../_shared/analyticsContract.ts";
import { handleGetPostAnalytics, type ServiceProxyDeps } from "../n8n-api/serviceProxy.ts";

const API_URL = "http://127.0.0.1:9";
const SERVICE_KEY = "facebook-analytics-fixture-service";
const OWNER = "9f010000-0000-4000-8000-000000000001";
const OTHER = "9f010000-0000-4000-8000-000000000002";
const ACCOUNT = "9f020000-0000-4000-8000-000000000001";
const FOREIGN = "9f020000-0000-4000-8000-000000000002";
const INACTIVE = "9f020000-0000-4000-8000-000000000003";
const WRONG_PLATFORM = "9f020000-0000-4000-8000-000000000004";
const MISSING = "9f020000-0000-4000-8000-000000000005";
const PAGE = "700100";
const TOKEN = "fixture-token";
Deno.env.set("SUPABASE_URL", API_URL);
Deno.env.set("SUPABASE_ANON_KEY", "fixture-anon");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);
const { handler } = await import("./index.ts");

function request(body: Record<string, unknown> = {}, token = SERVICE_KEY): Request {
  return new Request(`${API_URL}/functions/v1/facebook-page-insights`, { method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: "https://postora.cloud" },
    body: JSON.stringify({ user_id: OWNER, accountId: ACCOUNT, analyticsContractVersion: 1, periodDays: 7, ...body }) });
}

async function userToken(): Promise<string> {
  const encode = (payload: unknown) => btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: OWNER, role: "authenticated", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("facebook-analytics-fixture-signing"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned)));
  return `${unsigned}.${btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}

Deno.test("owned Facebook Page analytics composes auth, provider, exact metrics and scoped pagination", async (test) => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const windows = closedAnalyticsPeriods({ now: new Date().toISOString(), days: 7, timezone: "America/Los_Angeles" });
  const jwt = await userToken();
  const calls: URL[] = [];
  const audits: unknown[] = [];
  let mode = "normal";
  let accountReads = 0;
  const accounts = [
    { id: ACCOUNT, user_id: OWNER, platform: "facebook", is_active: true, platform_user_id: PAGE, access_token: TOKEN },
    { id: FOREIGN, user_id: OTHER, platform: "facebook", is_active: true, platform_user_id: "700200", access_token: "fixture-foreign" },
    { id: INACTIVE, user_id: OWNER, platform: "facebook", is_active: false, platform_user_id: PAGE, access_token: TOKEN },
    { id: WRONG_PLATFORM, user_id: OWNER, platform: "instagram", is_active: true, platform_user_id: PAGE, access_token: TOKEN },
  ];
  const json = (body: unknown, status = 200, version = "v25.0") => Response.json(body, { status, headers: { "facebook-api-version": version } });
  globalThis.fetch = async (input, init) => {
    const outgoing = new Request(input, init);
    const url = new URL(outgoing.url);
    if (url.origin === API_URL) {
      if (url.pathname === "/auth/v1/user") {
        assertEquals(outgoing.headers.get("Authorization"), `Bearer ${jwt}`);
        return Response.json({ id: OWNER, role: "authenticated", aud: "authenticated" });
      }
      if (url.pathname === "/rest/v1/social_accounts") {
        accountReads++;
        if (mode === "database_failed") return Response.json({ code: "57014", message: TOKEN }, { status: 500 });
        const selected = accounts.filter((account) => Object.entries(account).every(([column, value]) => {
          const filter = url.searchParams.get(column);
          return filter === null || filter === `eq.${value}`;
        }));
        return Response.json(selected[0] ?? null);
      }
      if (url.pathname === "/rest/v1/system_logs") { audits.push(await outgoing.json()); return new Response(null, { status: 201 }); }
      if (["/rest/v1/profiles", "/rest/v1/user_subscriptions", "/rest/v1/user_roles"].includes(url.pathname)) return Response.json(null);
    }
    if (url.origin !== "https://graph.facebook.com") throw new Error("Unexpected HTTP boundary");
    assertEquals(url.pathname.startsWith("/v25.0/"), true);
    assertEquals(outgoing.headers.get("Authorization"), `Bearer ${TOKEN}`);
    assertEquals(init?.redirect, "error");
    assertFalse(outgoing.url.includes(TOKEN));
    calls.push(url);
    if (url.pathname.endsWith("/me")) {
      if (mode === "expired") return json({ error: { type: "OAuthException", code: 190, error_subcode: 463, message: TOKEN } }, 400);
      return json({ id: mode === "wrong_identity" ? "700200" : PAGE }, 200, mode === "version_drift" ? "v26.0" : "v25.0");
    }
    if (url.pathname.endsWith("/posts")) {
      if (mode === "listing_failed") return json({ error: { code: 10, message: TOKEN } }, 403);
      if (mode === "budget") Date.now = () => originalNow() + 31_000;
      if (mode === "empty_listing") return json({ data: [] });
      const after = url.searchParams.get("after");
      const ids = after ? [`${PAGE}_3`] : mode === "foreign_post" ? ["700200_1"] : [`${PAGE}_1`, `${PAGE}_2`];
      const cursor = mode === "cursor_loop" ? "next-page" : after ? null : "next-page";
      return json({ data: ids.map((id) => ({ id, created_time: new Date(Date.parse(windows.current.buckets[2].since) + 1000).toISOString().replace("Z", "+0000"),
        ...(mode === "missing_text" ? {} : { message: "Fixture post" }),
        permalink_url: `https://www.facebook.com/${id}${mode === "invalid_permalink" ? '?access_token=' + TOKEN : ''}` })),
        ...(cursor ? { paging: { next: `https://graph.facebook.com/forbidden?access_token=${TOKEN}`, cursors: { after: cursor } } } : {}) });
    }
    if (url.pathname.endsWith(`/${PAGE}/insights`)) {
      const metric = url.searchParams.get("metric")!;
      const since = new Date(Number(url.searchParams.get("since")) * 1000).toISOString();
      const until = new Date(Number(url.searchParams.get("until")) * 1000).toISOString();
      const current = until === windows.current.period.until;
      if (mode === "previous_failed" && !current && metric === "page_media_view") return json({ error: { code: 2, message: TOKEN } }, 503);
      if (mode === "permission_missing" && metric === "page_post_engagements") return json({ error: { code: 200, message: TOKEN } }, 403);
      if (mode === "throttled") return Response.json({ error: { code: 4, message: TOKEN } }, { status: 429, headers: { "Retry-After": "180" } });
      if (mode === "ambiguous_parameter" && metric === "page_media_view") return json({ error: { code: 100, message: "Invalid parameter" } }, 400);
      const window = analyticsWindowForPeriod({ days: 7, since, until, timezone: "America/Los_Angeles" });
      return json({ data: mode === "missing_metric" && metric === "page_media_view" ? [] : [{ name: metric, period: "day", values: [
        ...window.buckets.filter((_bucket, index) => mode !== "missing_day" || !current || metric !== "page_media_view" || index !== 3).map((bucket, index) => ({
          end_time: bucket.until, value: metric === "page_follows" ? (current ? 100 : 80) + index : mode === "zero" || index === 0 ? 0 : current ? 2 : 1,
        })), { end_time: new Date(Date.parse(until) + 86_400_000).toISOString(), value: 9999 },
      ] }] });
    }
    if (url.pathname.endsWith("/insights")) {
      const metric = url.searchParams.get("metric")!;
      if (mode === "post_metric_failed" && url.pathname.includes(`${PAGE}_2`) && metric === "post_total_media_view_unique") return json({ error: { code: 10, message: TOKEN } }, 403);
      return json({ data: [{ name: metric, period: "day", values: [{ value: 999, end_time: windows.current.period.until }] },
        { name: metric, period: "lifetime", values: [{ value: metric === "post_media_view" ? 0 : 5 }] }] });
    }
    throw new Error("Unexpected Graph route");
  };
  try {
    let cursor = "";
    await test.step("closed-day sums, last follower snapshot and lifetime post metrics retain their distinct meanings", async () => {
      const response = await handler(request());
      assertEquals(response.status, 200);
      assertEquals(response.headers.get("Access-Control-Allow-Origin"), "https://postora.cloud");
      const { ok, ...payload } = await response.json();
      assertEquals(ok, true);
      const report = parseAnalyticsReport(payload);
      const metric = (key: string) => report.metrics.find((entry) => entry.definition.key === key)!;
      assertEquals(metric("views").current, { status: "available", value: 12 });
      assertEquals(metric("views").previous, { status: "available", value: 6 });
      assertEquals(metric("views").trend[0].metric, { status: "available", value: 0 });
      assertEquals(metric("followers").current, { status: "available", value: 106 });
      assertEquals(metric("followers").previous, { status: "available", value: 86 });
      const fabricated = structuredClone(report);
      const balance = fabricated.metrics.find((entry) => entry.definition.key === "followers")!;
      balance.current = { status: "available", value: 721 };
      balance.delta = metricDelta(balance.current, balance.previous);
      assertThrows(() => parseAnalyticsReport(fabricated), TypeError);
      assertEquals(metric("unique_viewers").current, { status: "unavailable", reason: "window_mismatch" });
      assertEquals(metric("reach").current, { status: "unavailable", reason: "capability_unverified" });
      assertEquals(report.posts.items[0].metrics.find((entry) => entry.definition.key === "views")!.current, { status: "available", value: 0 });
      assertEquals(report.posts.items[0].metrics.find((entry) => entry.definition.key === "unique_viewers")!.current, { status: "available", value: 5 });
      assertEquals(report.sync.status, "never_synced");
      assertEquals(report.posts.items[0].text, "Fixture post");
      assertEquals(report.posts.items[0].permalink, `https://www.facebook.com/${PAGE}_1`);
      cursor = report.posts.nextCursor!;
      assertNotEquals(cursor, "next-page");
      assertFalse(JSON.stringify(payload).includes(TOKEN));
      assertFalse(JSON.stringify(payload).includes("access_token"));
      const scope = analyticsCursorScope(OWNER, ACCOUNT, report.period);
      await assertRejects(() => decodeAnalyticsCursor(cursor, scope, SERVICE_KEY, "threads"), AnalyticsCursorError);
    });
    await test.step("signed second page keeps the same calendar and ends at the provider boundary", async () => {
      const body = await (await handler(request({ cursor }))).json();
      assertEquals(body.ok, true);
      assertEquals(body.posts.items.map((post: { id: string }) => post.id), [`${PAGE}_3`]);
      assertEquals(body.posts.nextCursor, null);
      assertEquals(body.posts.truncated, false);
    });
    await test.step("actual proxy-to-handler negotiation returns Facebook contract pages and rejects legacy fallback", async () => {
      const deps: ServiceProxyDeps = {
        loadAccount: async () => ({ failed: false, account: accounts[0] }),
        invoke: async (functionName, body) => {
          assertEquals(functionName, "facebook-page-insights");
          const response = await handler(new Request(`${API_URL}/functions/v1/${functionName}`, { method: "POST",
            headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
          return { status: response.status, data: await response.json() };
        },
        storeImage: async () => { throw new Error("Analytics must not store images"); },
        mediaQuotaBlocked: async () => { throw new Error("Analytics must not check upload quotas"); },
      };
      const query = new URLSearchParams({ social_account_id: ACCOUNT, period_days: "7", analyticsContractVersion: "1" });
      const first = await handleGetPostAnalytics(deps, OWNER, query);
      const { ok: _firstOk, ...firstPayload } = first.body as Record<string, unknown>;
      const firstReport = parseAnalyticsReport(firstPayload);
      assertEquals(firstReport.platform, "facebook");
      query.set("cursor", firstReport.posts.nextCursor!);
      const second = await handleGetPostAnalytics(deps, OWNER, query);
      const { ok: _secondOk, ...secondPayload } = second.body as Record<string, unknown>;
      assertEquals(parseAnalyticsReport(secondPayload).posts.nextCursor, null);
      query.delete("analyticsContractVersion");
      query.delete("cursor");
      assertEquals((await handleGetPostAnalytics(deps, OWNER, query)).status, 400);
    });
    for (const accountId of [FOREIGN, INACTIVE, WRONG_PLATFORM, MISSING]) await test.step("unavailable selector never falls back " + accountId, async () => {
      const before = calls.length;
      const response = await handler(request({ accountId }));
      assertEquals(response.status, 404);
      assertEquals(calls.length, before);
    });
    await test.step("JWT identity wins over a body owner and database failure stays a failure", async () => {
      assertEquals((await (await handler(request({ user_id: OTHER }, jwt))).json()).ok, true);
      mode = "database_failed";
      const before = calls.length;
      assertEquals((await handler(request())).status, 503);
      assertEquals(calls.length, before);
      mode = "normal";
    });
    for (const body of [{ analyticsContractVersion: 2 }, { cursor: {} }, { periodDays: 180 }, { accountId: "malformed" }]) await test.step("invalid request refuses before storage", async () => {
      const before = accountReads;
      assertEquals((await handler(request(body))).status, 400);
      assertEquals(accountReads, before);
    });
    await test.step("tampered and period-mismatched cursors refuse before Meta", async () => {
      for (const body of [{ cursor: cursor + "tampered" }, { cursor, periodDays: 14 }]) {
        const before = calls.length;
        assertEquals((await handler(request(body))).status, 400);
        assertEquals(calls.length, before);
      }
    });
    await test.step("unauthenticated and incomplete service-role calls stop before storage", async () => {
      const before = accountReads;
      assertEquals((await handler(request({}, "invalid"))).status, 401);
      assertEquals((await handler(request({ user_id: undefined }))).status, 401);
      assertEquals(accountReads, before);
      const options = await handler(new Request(`${API_URL}/functions/v1/facebook-page-insights`, { method: "OPTIONS", headers: { Origin: "https://untrusted.example" } }));
      assertEquals(options.status, 204);
      assertEquals(options.headers.has("Access-Control-Allow-Origin"), false);
    });
    for (const scenario of ["expired", "wrong_identity", "version_drift"]) await test.step("identity refusal " + scenario, async () => {
      mode = scenario;
      const before = calls.length;
      const body = await (await handler(request())).json();
      assertEquals(body.ok, false);
      assertEquals(body.reason, scenario === "expired" ? "reauth_required" : scenario === "wrong_identity" ? "wrong_account" : "capability_unverified");
      assertEquals(calls.length - before, 1);
      assertFalse(JSON.stringify(body).includes(TOKEN));
      mode = "normal";
    });
    for (const scenario of ["zero", "missing_metric", "missing_day", "previous_failed", "permission_missing", "post_metric_failed", "listing_failed", "empty_listing", "foreign_post", "cursor_loop", "budget", "throttled", "ambiguous_parameter", "missing_text", "invalid_permalink"]) {
      await test.step("metric and listing failure semantics " + scenario, async () => {
        mode = scenario;
        const body = await (await handler(request(scenario === "cursor_loop" ? { cursor } : {}))).json();
        assertEquals(body.ok, true);
        const metric = (key: string) => body.metrics.find((entry: { definition: { key: string } }) => entry.definition.key === key);
        if (scenario === "zero") { assertEquals(metric("views").current, { status: "available", value: 0 }); assertEquals(metric("views").delta.reason, "zero_baseline"); }
        if (scenario === "missing_metric" || scenario === "ambiguous_parameter") assertEquals(metric("views").current, { status: "unavailable", reason: "provider_error" });
        if (scenario === "missing_day") assertEquals(metric("views").current.coverage, { availableDays: 6, expectedDays: 7 });
        if (scenario === "previous_failed") { assertEquals(metric("views").current.status, "available"); assertEquals(metric("views").delta.status, "unavailable"); }
        if (scenario === "permission_missing") assertEquals(metric("engagements").current, { status: "unavailable", reason: "permission_missing" });
        if (scenario === "post_metric_failed") {
          const metrics = body.posts.items[1].metrics;
          assertEquals(metrics.find((entry: { definition: { key: string } }) => entry.definition.key === "views").current.status, "available");
          assertEquals(metrics.find((entry: { definition: { key: string } }) => entry.definition.key === "unique_viewers").current.reason, "permission_missing");
        }
        if (["listing_failed", "foreign_post", "invalid_permalink"].includes(scenario)) assertEquals(body.posts.status, "unavailable");
        if (scenario === "missing_text") { assertEquals(body.posts.items[0].text, ""); assertEquals(body.posts.items[0].permalink, `https://www.facebook.com/${PAGE}_1`); }
        if (scenario === "empty_listing") { assertEquals(body.posts.status, "available"); assertEquals(body.posts.items, []); }
        if (scenario === "cursor_loop") { assertEquals(body.posts.reason, "provider_error"); assertEquals(body.posts.nextCursor, null); }
        if (scenario === "budget") assertEquals(metric("views").current.status, "unavailable");
        if (scenario === "throttled") { assertEquals(typeof body.retryAt, "string"); assertEquals(Date.parse(body.retryAt) > originalNow(), true); }
        assertFalse(JSON.stringify(body).includes(TOKEN));
        Date.now = originalNow;
        mode = "normal";
      });
    }
    assertFalse(JSON.stringify(audits).includes(TOKEN));
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
});
