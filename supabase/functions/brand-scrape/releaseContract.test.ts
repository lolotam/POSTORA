import { assertEquals, assertRejects, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { discoveryCacheKey, discoveryMedia, InstagramDiscoveryError, resolveDiscoveryAuthority, scrapeInstagramOfficial, scrapeInstagramOwn } from "./instagramDiscovery.ts";

const OWNER = "8a000000-0000-4000-8000-000000000001";
const ACCOUNT = "8a000000-0000-4000-8000-000000000002";
const CREDENTIAL = "8a000000-0000-4000-8000-000000000003";
const ACCOUNT_ROW = { id: ACCOUNT, user_id: OWNER, platform: "instagram", platform_user_id: "77001", platform_username: "owner", access_token: "synthetic-page-token", is_active: true, ig_auth_type: "facebook_business" };
const capability = (overrides: Record<string, unknown> = {}) => ({ social_account_id: ACCOUNT, capability_present: true, login_kind: "page_linked",
  permission_read_state: "ok", scopes_authoritative: true, granted_scopes: ["instagram_manage_insights"], scopes_read_at: "2026-11-01T00:00:00Z",
  last_read_failed_at: null, last_read_error_code: null, credential_generation: 4, credential_updated_at: null,
  generation_reason: null, reconnected_at: null, has_protected_credential: true, updated_at: null, ...overrides });
const credential = (overrides: Record<string, unknown> = {}) => ({ found: true, social_account_id: ACCOUNT, platform: "instagram", credential_id: CREDENTIAL,
  credential_kind: "facebook_user", token: "synthetic-user-token", token_expires_at: null, revision: 3, capability_generation: 4, connection_version: 2, ...overrides });
const media = (id = "1", overrides: Record<string, unknown> = {}) => ({ id, timestamp: "2026-11-01T00:00:00Z", media_type: "VIDEO", media_product_type: "FEED", like_count: 0, comments_count: 0, view_count: 0, ...overrides });
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

Deno.test("official discovery uses bounded cursor grammar, deduplicates media and preserves FEED video and unavailable counts", async () => {
  const urls: URL[] = [];
  const report = await scrapeInstagramOfficial({ username: "target", viewerIgUserId: "77001", accessToken: "synthetic-user-token", maxPosts: 26,
    fetchFn: ((url) => {
      urls.push(new URL(String(url)));
      return Promise.resolve(json({ business_discovery: { id: "target", username: "target", followers_count: 0, media_count: 26,
        media: urls.length === 1 ? { data: Array.from({ length: 25 }, (_, index) => media(String(index))), paging: { cursors: { after: "page_2" }, next: "https://untrusted.invalid/?token=never" } } :
          { data: [media("0"), media("25", { like_count: -1, view_count: undefined })] } } }));
    }) as typeof fetch });
  assertEquals(urls.length, 2);
  const fields = urls[1].searchParams.get("fields")!;
  assertStringIncludes(fields, "business_discovery.username(target)");
  assertStringIncludes(fields, "media.limit(25).after(page_2)");
  assertStringIncludes(fields, "view_count");
  assertEquals(fields.includes("video_view_count"), false);
  assertEquals(urls.every((url) => url.hostname === "graph.facebook.com"), true);
  assertEquals(report.posts.length, 26);
  assertEquals(report.posts[0].mediaType, "VIDEO");
  assertEquals(report.posts[0].engagementScore, 0);
  assertEquals(report.posts[25].likesCount, null);
  assertEquals(report.posts[25].videoViewCount, null);
  assertEquals(report.posts[25].engagementScore, null);
  assertEquals(report.profile.source, "official");
  assertEquals(report.profile.followersCount, 0);
});

Deno.test("discovery refuses malformed grammar, cursor loops and provider bodies without exposing provider text", async (test) => {
  for (const scenario of ["handle", "loop", "token", "insufficient_data_10", "insufficient_data_200"] as const) await test.step(scenario, async () => {
    let requests = 0;
    const error = await assertRejects(() => scrapeInstagramOfficial({ username: scenario === "handle" ? "target){token}" : "target",
      viewerIgUserId: "77001", accessToken: "synthetic-user-token", maxPosts: 75,
      fetchFn: (() => { requests++;
        return Promise.resolve(scenario.startsWith("insufficient_data") ? json({ error: { code: scenario.endsWith("200") ? 200 : 10, message: "Insufficient viewers for this target" } }, 400) :
          scenario === "token" ? json({ error: { code: 190, message: "synthetic-user-token" } }, 400) :
          json({ business_discovery: { id: "target", media: { data: [media(String(requests))], paging: { cursors: { after: "repeated" } } } } }));
      }) as typeof fetch }), InstagramDiscoveryError);
    assertEquals(error.message.includes("synthetic-user-token"), false);
    if (scenario.startsWith("insufficient_data")) assertEquals(error.code, "DISCOVERY_PROVIDER_UNAVAILABLE");
    assertEquals(requests, scenario === "handle" ? 0 : scenario === "loop" ? 2 : 1);
  });
});

Deno.test("own-account source and FEED video survive the direct transport with missing views remaining null", async () => {
  const report = await scrapeInstagramOwn({ username: "owner", igUserId: "77001", accessToken: "synthetic-direct-token", maxPosts: 25,
    fetchFn: ((url) => Promise.resolve(new URL(String(url)).pathname.endsWith("/media") ? json({ data: [media("1", { view_count: undefined })] }) : json({ id: "77001", username: "owner", followers_count: 0 }))) as typeof fetch });
  assertEquals(report.source, "graph_own");
  assertEquals(report.profile.followersCount, 0);
  assertEquals(report.profile.followingCount, null);
  assertEquals(report.posts[0].mediaType, "VIDEO");
  assertEquals(report.posts[0].videoViewCount, null);
  assertEquals(report.posts[0].engagementScore, null);
  assertEquals(discoveryMedia(media("reel", { media_product_type: "REELS" })).mediaType, "REEL");
});

Deno.test("official and own transports reject malformed optional profile text instead of serializing unknown values", async (test) => {
  const malformedFields = [
    { name: {} }, { username: [] }, { biography: 1 }, { profile_picture_url: true }, { website: {} },
    { name: "a".repeat(256) }, { biography: "bad\u0000text" },
  ];
  for (const source of ["official", "graph_own"] as const) for (const [index, fields] of malformedFields.entries()) {
    await test.step(`${source}:${index}`, async () => {
      const profile = { id: "77001", username: "owner", media: { data: [] }, ...fields };
      const fetchFn = (() => Promise.resolve(json(source === "official" ? { business_discovery: profile } :
        { ...profile, data: [] }))) as typeof fetch;
      const error = await assertRejects(() => source === "official"
        ? scrapeInstagramOfficial({ username: "owner", viewerIgUserId: "77001", accessToken: "synthetic", maxPosts: 25, fetchFn })
        : scrapeInstagramOwn({ username: "owner", igUserId: "77001", accessToken: "synthetic", maxPosts: 25, fetchFn }), InstagramDiscoveryError);
      assertEquals(error.code, "DISCOVERY_PROVIDER_UNAVAILABLE");
      assertEquals(error.status, 502);
    });
  }
});

Deno.test("protected discovery never substitutes the Page token and scopes cache by owner and authority revision", async () => {
  const resolved = await resolveDiscoveryAuthority({ accounts: [{ ...ACCOUNT_ROW, access_token: "" }], userId: OWNER, username: "target",
    rpc: (name) => Promise.resolve({ data: name.includes("capability") ? capability() : credential(), error: null }) });
  assertEquals(resolved.authority?.token, "synthetic-user-token");
  const original = await discoveryCacheKey(OWNER, "target", resolved.cacheIdentity);
  assertEquals(original.includes("token"), false);
  assertEquals(original === await discoveryCacheKey("other-owner", "target", resolved.cacheIdentity), false);
  assertEquals(original === await discoveryCacheKey(OWNER, "target", `${resolved.cacheIdentity}:reconnected`), false);
  const absent = await resolveDiscoveryAuthority({ accounts: [ACCOUNT_ROW], userId: OWNER, username: "target",
    rpc: (name) => Promise.resolve({ data: name.includes("capability") ? capability() : credential({ found: false, credential_id: null, token: null, revision: null }), error: null }) });
  assertEquals(absent.authority, null);
  await assertRejects(() => resolveDiscoveryAuthority({ accounts: [ACCOUNT_ROW], userId: OWNER, username: "target",
    rpc: (name) => Promise.resolve({ data: name.includes("capability") ? capability() : credential({ capability_generation: 3 }), error: null }) }), InstagramDiscoveryError);
});

Deno.test("registered discovery handler retains source and null cells through cache and history, then refuses denied scopes", async () => {
  const originalFetch = globalThis.fetch;
  const originalServe = Deno.serve;
  const environment = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "APIFY_API_TOKEN"].map((name) => [name, Deno.env.get(name)] as const);
  let handler: (request: Request) => Promise<Response>;
  let cache: Record<string, unknown> | null = null;
  const history: Record<string, unknown>[] = [];
  let denied = false;
  let providerCalls = 0;
  let apifyCalls = 0;
  let authorityReads = 0;
  let apifySetting: unknown = false;
  try {
    Deno.env.set("SUPABASE_URL", "http://127.0.0.1:61999");
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "synthetic-discovery-service-key");
    Deno.env.set("APIFY_API_TOKEN", "synthetic-apify-token");
    Deno.serve = ((registered: typeof handler) => { handler = registered; return {}; }) as typeof Deno.serve;
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname === "graph.facebook.com") {
        providerCalls++;
        assertEquals(url.searchParams.get("access_token"), "synthetic-user-token");
        return json({ business_discovery: { id: "target", username: "target", media: { data: [media("1", { like_count: undefined, view_count: undefined })] } } });
      }
      if (url.hostname === "api.apify.com") {
        apifyCalls++;
        return json([{ id: "apify-1", shortCode: "synthetic", type: "Image", timestamp: "2026-11-01T00:00:00Z" }]);
      }
      assertEquals(url.origin, "http://127.0.0.1:61999");
      if (url.pathname === "/auth/v1/user") return json({ id: OWNER });
      const table = url.pathname.split("/").at(-1);
      if (table === "read_instagram_account_capability") {
        authorityReads++;
        return json(capability(denied ? { granted_scopes: [], updated_at: "2026-11-02T00:00:00Z" } : {}));
      }
      if (table === "read_facebook_user_account_credential") return json(credential());
      if (table === "social_accounts") return json([ACCOUNT_ROW]);
      if (table === "app_settings") return json(url.searchParams.get("key")?.includes("ttl") ? { value: 60 } :
        apifySetting === undefined ? [] : [{ key: "apify_enabled", value: apifySetting }]);
      if (table === "brand_scrape_cache") {
        if (request.method === "GET") return json(cache && url.searchParams.get("cache_key") === `eq.${cache.cache_key}` ? cache : null);
        cache = await request.json(); return json(null);
      }
      if (table === "brand_scrape_sessions") { history.push(await request.json()); return json(null); }
      if (table === "system_logs" || table === "profiles") return json(null);
      throw new Error(`Unexpected synthetic database route ${table}`);
    }) as typeof fetch;
    await import("./index.ts");
    const request = (platform = "instagram") => new Request("http://127.0.0.1:61999/functions/v1/brand-scrape", { method: "POST", headers: { Authorization: "Bearer synthetic-caller", "Content-Type": "application/json" }, body: JSON.stringify({ platform, username: "target" }) });
    for (const cached of [false, true]) {
      const response = await handler!(request());
      assertEquals(response.status, 200);
      const payload = await response.json();
      assertEquals(payload.source, "official");
      assertEquals(payload.profile.source, "official");
      assertEquals(payload.posts[0].likesCount, null);
      assertEquals(payload.posts[0].engagementScore, null);
      assertEquals(payload.fromCache === true, cached);
    }
    assertEquals(providerCalls, 1);
    assertEquals(history.length, 2);
    for (const session of history) assertEquals((session.profile_data as Record<string, unknown>).source, "official");
    denied = true;
    for (const setting of [false, undefined, "malformed", '"true"']) {
      apifySetting = setting;
      const refused = await handler!(request());
      assertEquals(refused.status, 409);
      assertEquals((await refused.json()).error_code, "IG_INSIGHTS_SCOPE_MISSING");
    }
    assertEquals(providerCalls, 1);
    assertEquals(apifyCalls, 0);
    apifySetting = true;
    const fallback = await handler!(request());
    assertEquals(fallback.status, 200);
    const fallbackPayload = await fallback.json();
    assertEquals(fallbackPayload.source, "apify");
    assertEquals(fallbackPayload.profile.source, "apify");
    assertEquals(fallbackPayload.warning.code, "IG_INSIGHTS_SCOPE_MISSING");
    assertEquals(fallbackPayload.posts[0].likesCount, null);
    assertEquals(apifyCalls, 1);
    const readsBeforeThreads = authorityReads;
    const threads = await handler!(request("threads"));
    assertEquals(threads.status, 200);
    assertEquals((await threads.json()).reason, "deprecated_endpoint");
    assertEquals(authorityReads, readsBeforeThreads);
    assertEquals(apifyCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Deno.serve = originalServe;
    for (const [name, value] of environment) value === undefined ? Deno.env.delete(name) : Deno.env.set(name, value);
  }
});
