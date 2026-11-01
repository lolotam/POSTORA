import { assertEquals, assertFalse, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { analyticsWindowForPeriod, closedAnalyticsPeriods } from "../_shared/analyticsCalendar.ts";
import { parseAnalyticsReport } from "../_shared/analyticsSchema.ts";
import { handleGetPostAnalytics, type ServiceProxyDeps } from "../n8n-api/serviceProxy.ts";

const API_URL = "http://127.0.0.1:9";
const SERVICE_KEY = "fixture-key";
const PROVIDER_TOKEN = "fixture-token";
const OWNER = "9f010000-0000-4000-8000-000000000001";
const OTHER_OWNER = "9f010000-0000-4000-8000-000000000002";
const ACCOUNT = "9f020000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT = "9f020000-0000-4000-8000-000000000002";
Deno.env.set("SUPABASE_URL", API_URL);
Deno.env.set("SUPABASE_ANON_KEY", "fixture-anon");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);
const { handler } = await import("./index.ts");

function request(body: Record<string, unknown>): Request {
  return new Request(`${API_URL}/functions/v1/threads-insights`, { method: "POST",
    headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: OWNER, accountId: ACCOUNT, periodDays: 7, analyticsContractVersion: 1, ...body }) });
}

Deno.test("real Threads composition negotiates the unified contract without fabricating metrics or widening cursor scope", async (test) => {
  const originalFetch = globalThis.fetch;
  const period = closedAnalyticsPeriods({ now: new Date().toISOString(), days: 7, timezone: "America/Los_Angeles" }).current;
  const metaCalls: URL[] = [];
  const audits: unknown[] = [];
  let scenario = "normal";
  let recognizedServerFailure: { code: number; error_subcode: number } | null = null;
  let accountReads = 0;
  const originalNow = Date.now;
  globalThis.fetch = async (input, init) => {
    const outgoing = new Request(input, init);
    const url = new URL(outgoing.url);
    if (url.origin === API_URL) {
      if (url.pathname === "/rest/v1/social_accounts") {
        accountReads++;
        if (url.searchParams.get("user_id") !== `eq.${OWNER}` || ![`eq.${ACCOUNT}`, `eq.${OTHER_ACCOUNT}`].includes(url.searchParams.get("id") ?? "")) return Response.json([]);
        return Response.json([{ id: url.searchParams.get("id")!.slice(3), user_id: OWNER, platform_user_id: "thread_owner",
          platform_username: "fixture_owner", access_token: PROVIDER_TOKEN, platform: "threads", is_active: true }]);
      }
      if (url.pathname === "/rest/v1/system_logs") { audits.push(await outgoing.json()); return new Response(null, { status: 201 }); }
      if (["/rest/v1/profiles", "/rest/v1/user_subscriptions", "/rest/v1/user_roles"].includes(url.pathname)) return Response.json(null);
    }
    if (url.origin !== "https://graph.threads.net") throw new Error("Unexpected test boundary");
    metaCalls.push(url);
    assertEquals(outgoing.headers.get("Authorization"), `Bearer ${PROVIDER_TOKEN}`);
    assertFalse(outgoing.url.includes(PROVIDER_TOKEN));
    if (url.pathname.endsWith("/me")) return scenario === "expired_token"
      ? Response.json({ error: { code: 190, error_subcode: 463, message: PROVIDER_TOKEN } }, { status: 400 })
      : Response.json({ id: "thread_owner" });
    if (url.pathname.endsWith("/threads_insights")) {
      if (recognizedServerFailure) return Response.json({ error: { ...recognizedServerFailure, message: PROVIDER_TOKEN } }, { status: 503 });
      const since = new Date(Number(url.searchParams.get("since")) * 1000).toISOString();
      const until = new Date(Number(url.searchParams.get("until")) * 1000).toISOString();
      const current = until === period.period.until;
      if (!current && scenario === "previous_failed") return Response.json({ error: { code: 2, message: PROVIDER_TOKEN } }, { status: 503 });
      let ends: string[];
      try { ends = analyticsWindowForPeriod({ days: 7, since, until, timezone: "America/Los_Angeles" }).buckets.map((bucket) => bucket.until); }
      catch (error) { if (!(error instanceof RangeError)) throw error; ends = [until]; }
      const rows: Record<string, unknown>[] = [{ name: "views", period: "day", values: [
        { value: 999, end_time: since }, ...ends.filter((_end, index) => scenario !== "missing_day" || !current || index !== 3).map((end_time, index) => ({ end_time,
          value: scenario === "zero" ? 0 : current ? index === 0 ? 0 : 2 : 1 })),
      ] }, { name: "followers_count", period: "day", total_value: { value: 50 } },
      { name: "likes", period: "day", total_value: { value: 88 } }];
      return Response.json({ data: scenario === "missing_metric" && current || scenario === "previous_missing_metric" && !current
        ? rows.filter((row) => row.name !== "views") : rows });
    }
    if (url.pathname.endsWith("/threads")) {
      if (scenario === "listing_failed") return Response.json({ error: { code: 10, message: PROVIDER_TOKEN } }, { status: 403 });
      const after = url.searchParams.get("after");
      if (scenario === "budget_exhausted") Date.now = () => originalNow() + 31_000;
      const ids = after ? ["post3"] : ["post1", "post2"];
      const cursor = scenario === "repeated_cursor" ? "page-two" : after ? null : "page-two";
      return Response.json({ data: ids.map((id) => ({ id, timestamp: new Date(Date.parse(period.buckets[2].since) + 1000).toISOString(),
        text: id, permalink: scenario === "invalid_permalink" ? "http://invalid.example/private" : `https://www.threads.net/post/${id}` })),
        ...(cursor ? { paging: { next: `https://graph.threads.net/private?access_token=${PROVIDER_TOKEN}`, cursors: { after: cursor } } } : {}) });
    }
    if (url.pathname.endsWith("/insights")) {
      if (scenario === "post_failed" && url.pathname.includes("/post2/")) return Response.json({ error: { code: 10, message: PROVIDER_TOKEN } }, { status: 403 });
      return Response.json({ data: ["views", "likes", "replies", "reposts", "quotes", "shares"].map((name) => ({ name, period: "lifetime", values: [{ value: 0 }] })) });
    }
    throw new Error("Unexpected provider test route");
  };
  try {
    let cursor = "";
    await test.step("closed daily profile visits exclude the extra start bucket, and snapshots never invent follower growth", async () => {
      const response = await handler(request({}));
      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.ok, true);
      const { ok: _ok, ...payload } = body;
      const report = parseAnalyticsReport(payload);
      const visits = report.metrics.find((metric) => metric.definition.key === "profile_views")!;
      assertEquals(visits.current, { status: "available", value: 12 });
      assertEquals(visits.previous, { status: "available", value: 7 });
      assertEquals(visits.trend.length, 7);
      assertEquals(visits.trend[0].metric, { status: "available", value: 0 });
      assertEquals(report.metrics.find((metric) => metric.definition.key === "views")!.current, { status: "unavailable", reason: "capability_unverified" });
      assertEquals(report.metrics.find((metric) => metric.definition.key === "likes")!.current, { status: "unavailable", reason: "window_mismatch" });
      const followers = report.metrics.find((metric) => metric.definition.key === "followers")!;
      assertEquals(followers.current, { status: "available", value: 50 });
      assertEquals(followers.previous, { status: "unavailable", reason: "not_collected" });
      assertEquals(followers.delta.status, "unavailable");
      assertEquals(report.sync.status, "never_synced");
      assertEquals(report.source, "live");
      assertEquals(report.posts.items[0].metrics.find((metric) => metric.definition.key === "views")!.current, { status: "available", value: 0 });
      cursor = report.posts.nextCursor!;
      assertNotEquals(cursor, "page-two");
      assertFalse(JSON.stringify(body).includes(PROVIDER_TOKEN));
      assertFalse(JSON.stringify(body).includes("access_token"));
    });
    await test.step("signed continuation rebuilds the fixed-origin request and ends without duplicate posts", async () => {
      const body = await (await handler(request({ cursor }))).json();
      assertEquals(body.ok, true);
      assertEquals(body.posts.items.map((post: { id: string }) => post.id), ["post3"]);
      assertEquals(body.posts.nextCursor, null);
      assertEquals(body.posts.truncated, false);
      assertEquals(body.lastPartialAt, null);
      assertEquals(metaCalls.some((url) => url.searchParams.get("after") === "page-two"), true);
    });
    await test.step("a missing comparison metric in HTTP 200 marks an otherwise complete page partial", async () => {
      scenario = "previous_missing_metric";
      const body = await (await handler(request({ cursor }))).json();
      assertEquals(body.posts.truncated, false);
      const visits = body.metrics.find((metric: { definition: { key: string } }) => metric.definition.key === "profile_views");
      assertEquals(visits.current.status, "available");
      assertEquals(visits.previous, { status: "unavailable", reason: "provider_error" });
      assertEquals(typeof body.lastPartialAt, "string");
      scenario = "normal";
    });
    await test.step("real proxy and endpoint preserve versioned pagination without falling back to the legacy DTO", async () => {
      const deps: ServiceProxyDeps = {
        loadAccount: async () => ({ failed: false, account: { id: ACCOUNT, user_id: OWNER, platform: "threads", platform_user_id: "thread_owner", is_active: true } }),
        invoke: async (functionName, body) => {
          assertEquals(functionName, "threads-insights");
          const response = await handler(new Request(`${API_URL}/functions/v1/${functionName}`, { method: "POST",
            headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
          return { status: response.status, data: await response.json() };
        },
        storeImage: async () => { throw new Error("Analytics must not store images"); },
        mediaQuotaBlocked: async () => { throw new Error("Analytics must not check upload quotas"); },
      };
      const query = new URLSearchParams({ social_account_id: ACCOUNT, analyticsContractVersion: "1", period_days: "7" });
      const first = await handleGetPostAnalytics(deps, OWNER, query);
      const firstBody = first.body as Record<string, unknown>;
      const { ok: _firstOk, ...firstPayload } = firstBody;
      const firstReport = parseAnalyticsReport(firstPayload);
      assertEquals(first.status, 200);
      assertEquals(firstReport.posts.items.map((post) => post.id), ["post1", "post2"]);
      query.set("cursor", firstReport.posts.nextCursor!);
      const second = await handleGetPostAnalytics(deps, OWNER, query);
      const { ok: _secondOk, ...secondPayload } = second.body as Record<string, unknown>;
      const secondReport = parseAnalyticsReport(secondPayload);
      assertEquals(secondReport.posts.items.map((post) => post.id), ["post3"]);
      assertEquals(secondReport.posts.nextCursor, null);
    });
    for (const body of [{ cursor: cursor + "tampered" }, { cursor, accountId: OTHER_ACCOUNT }, { cursor, periodDays: 14 }]) {
      await test.step("tampered or account/period-mismatched continuation refuses before provider access " + JSON.stringify(Object.keys(body)), async () => {
        const before = metaCalls.length;
        const response = await handler(request(body));
        assertEquals(response.status, 400);
        assertEquals((await response.json()).reason, "invalid_cursor");
        assertEquals(metaCalls.length, before);
      });
    }
    for (const mode of ["zero", "missing_metric", "missing_day", "previous_failed", "post_failed", "listing_failed", "repeated_cursor", "budget_exhausted", "invalid_permalink"]) {
      await test.step("versioned response retains semantic refusal for " + mode, async () => {
        scenario = mode;
        const body = await (await handler(request(mode === "repeated_cursor" ? { cursor } : {}))).json();
        assertEquals(body.ok, true);
        const visits = body.metrics.find((metric: { definition: { key: string } }) => metric.definition.key === "profile_views");
        if (mode === "zero") assertEquals(visits.current, { status: "available", value: 0 });
        if (mode === "missing_metric") assertEquals(visits.current, { status: "unavailable", reason: "provider_error" });
        if (mode === "invalid_permalink") {
          assertEquals(body.posts.items[0].permalink, null);
          assertEquals(body.posts.items[0].metrics.find((metric: { definition: { key: string } }) => metric.definition.key === "views").current,
            { status: "available", value: 0 });
        }
        if (mode === "missing_day") {
          assertEquals(visits.current.status, "partial");
          assertEquals(visits.current.coverage, { availableDays: 6, expectedDays: 7 });
          assertEquals(visits.delta.status, "unavailable");
        }
        if (mode === "previous_failed") {
          assertEquals(visits.current.status, "available");
          assertEquals(visits.previous, { status: "unavailable", reason: "provider_error" });
          assertEquals(visits.delta.status, "unavailable");
        }
        if (mode === "post_failed") {
          assertEquals(body.posts.items[0].metrics.find((metric: { definition: { key: string } }) => metric.definition.key === "views").current.status, "available");
          assertEquals(body.posts.items[1].metrics.find((metric: { definition: { key: string } }) => metric.definition.key === "views").current, { status: "unavailable", reason: "permission_missing" });
          assertEquals(body.posts.status, "partial");
        }
        if (mode === "listing_failed") {
          assertEquals(body.posts.status, "unavailable");
          assertEquals(body.posts.reason, "permission_missing");
          assertEquals(body.posts.items, []);
        }
        if (mode === "repeated_cursor") {
          assertEquals(body.posts.nextCursor, null);
          assertEquals(body.posts.truncated, true);
          assertEquals(body.posts.reason, "provider_error");
        }
        if (mode === "budget_exhausted") {
          assertEquals(body.posts.status, "partial");
          assertEquals(body.posts.items[0].metrics.find((metric: { definition: { key: string } }) => metric.definition.key === "views").current,
            { status: "unavailable", reason: "provider_error" });
        }
        assertFalse(JSON.stringify(body).includes(PROVIDER_TOKEN));
        Date.now = originalNow;
        scenario = "normal";
      });
    }
    for (const [code, subcode, reason] of [
      [190, 463, "reauth_required"], [190, 0, "reauth_required"],
      [10, 0, "permission_missing"], [200, 0, "permission_missing"],
    ] as const) {
      await test.step(`versioned metrics retain the actionable reason for 503/${code}/${subcode}`, async () => {
        recognizedServerFailure = { code, error_subcode: subcode };
        try {
          const response = await handler(request({}));
          const { ok, ...payload } = await response.json();
          assertEquals(response.status, 200);
          assertEquals(ok, true);
          const report = parseAnalyticsReport(payload);
          const visits = report.metrics.find((metric) => metric.definition.key === "profile_views")!;
          assertEquals(visits.current, { status: "unavailable", reason });
          assertEquals(visits.previous, { status: "unavailable", reason });
          assertEquals(visits.delta.reason, reason);
          assertFalse(JSON.stringify(payload).includes(PROVIDER_TOKEN));
        } finally { recognizedServerFailure = null; }
      });
    }
    await test.step("expired credentials return a sanitized reauthentication refusal", async () => {
      scenario = "expired_token";
      const body = await (await handler(request({}))).json();
      assertEquals(body.ok, false);
      assertEquals(body.needsReauth, true);
      assertFalse(JSON.stringify(body).includes(PROVIDER_TOKEN));
      scenario = "normal";
    });
    await test.step("foreign scope is non-enumerating and never reaches Meta", async () => {
      const before = metaCalls.length;
      const response = await handler(request({ user_id: OTHER_OWNER }));
      assertEquals(response.status, 404);
      assertEquals(metaCalls.length, before);
    });
    for (const invalid of [{ analyticsContractVersion: 2 }, { analyticsContractVersion: "1" }, { periodDays: "7" }, { cursor: {} }, { cursor: "" }, { cursor: "x".repeat(16385) }]) {
      await test.step("unsupported contract or malformed unified input refuses before storage", async () => {
        const before = accountReads;
        const response = await handler(request(invalid));
        assertEquals(response.status, 400);
        assertEquals(accountReads, before);
      });
    }
    await test.step("omitted contract discriminator preserves legacy numeric response", async () => {
      const response = await handler(new Request(`${API_URL}/functions/v1/threads-insights`, { method: "POST",
        headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: OWNER, accountId: ACCOUNT, periodDays: 7 }) }));
      const body = await response.json();
      assertEquals(body.ok, true);
      assertEquals(typeof body.insights.views.value, "number");
      assertEquals(body.analyticsContractVersion, undefined);
    });
    assertFalse(JSON.stringify(audits).includes(PROVIDER_TOKEN));
  } finally { Date.now = originalNow; globalThis.fetch = originalFetch; }
});
