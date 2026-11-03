/** Loopback-only real Auth/PostgREST/report/worker composition; only Meta transport is synthetic. */
import { OWNER_RELEASE, assertOwnerReleaseUrl, ownerReleaseSql, seedOwnerRelease, syntheticOwnerReleaseKey } from "./instagramOwnerReleaseSeed.ts";
import { FakeMetaTransport } from "../../supabase/functions/_shared/rolloutIntegrationTestSupport.ts";
import { fileURLToPath } from "node:url";
import { assertPreparedOwnerExecutionSource } from "../../scripts/instagram-owner-execution-source.mjs";
import { META_ACCOUNTS, META_PLATFORMS, MetaOwnedProviderFixture, type MetaFixturePlatform } from "./metaOwnedRelease.ts";

assertPreparedOwnerExecutionSource(fileURLToPath(new URL("../../", import.meta.url)));

for (const endpoint of [OWNER_RELEASE.apiUrl, OWNER_RELEASE.authUrl, OWNER_RELEASE.restUrl]) assertOwnerReleaseUrl(endpoint);
const configuredUrl = Deno.env.get("SUPABASE_URL");
if (configuredUrl && configuredUrl !== OWNER_RELEASE.apiUrl) throw new Error("Refusing a shared-stack SUPABASE_URL in owner-release fixtures");

const anonKey = await syntheticOwnerReleaseKey("anon");
const serviceKey = await syntheticOwnerReleaseKey("service_role");
Deno.env.set("SUPABASE_URL", OWNER_RELEASE.apiUrl);
Deno.env.set("SUPABASE_ANON_KEY", anonKey);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", serviceKey);
Deno.env.set("CRON_SECRET", "synthetic-owner-release-cron-secret");
Deno.env.set("PUBLIC_API_ORIGIN", OWNER_RELEASE.apiUrl);
Deno.env.set("PUBLIC_APP_ORIGIN", "http://127.0.0.1:8080");
for (const platform of ["FACEBOOK", "THREADS"]) {
  Deno.env.set(`${platform}_APP_ID`, "770001");
  Deno.env.set(`${platform}_APP_SECRET`, "owned-fixture-app");
}

const originalFetch = globalThis.fetch;
const meta = new FakeMetaTransport();
const ownedMeta = new MetaOwnedProviderFixture();
meta.install();
const syntheticMetaFetch = globalThis.fetch;
meta.restore();
const rpcFailures: { name: string; status: number; code: string | null }[] = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (["graph.facebook.com", "graph.threads.net"].includes(url.hostname)) {
    const reply = ownedMeta.reply(new Request(input, init));
    if (reply) return reply;
  }
  if (["graph.facebook.com", "graph.instagram.com"].includes(url.hostname)) return syntheticMetaFetch(input, init);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !["65431", "65435", "65436"].includes(url.port)) {
    throw new Error("Owner-release runtime refused non-fixture network access");
  }
  let response: Response;
  try { response = await originalFetch(input, init); } catch (error) {
    if (url.pathname.startsWith("/rest/v1/rpc/")) rpcFailures.push({ name: url.pathname.split("/").at(-1)!, status: 0, code: error instanceof Error ? error.name : "transport_error" });
    throw error;
  }
  if (url.pathname.startsWith("/rest/v1/rpc/") && !response.ok) {
    const receipt = await response.clone().json();
    rpcFailures.push({ name: url.pathname.split("/").at(-1)!, status: response.status,
      code: typeof receipt?.code === "string" ? receipt.code : null });
  }
  return response;
};

const { handler: reportHandler } = await import("../../supabase/functions/instagram-insights-report/index.ts");
const { handleRequest: registeredApi } = await import("../../supabase/functions/n8n-api/index.ts");
const { handler: savedMetaReport } = await import("../../supabase/functions/meta-owned-analytics-report/index.ts");
const { handler: savedMetaSync } = await import("../../supabase/functions/meta-owned-analytics-sync/index.ts");
type Handler = (request: Request) => Response | Promise<Response>;
let syncHandler: Handler | null = null;
let mcpHandler: Handler | null = null;
const serve = Deno.serve;
try {
  // Capture the real registered route; do not replace its auth, stores or worker.
  Deno.serve = ((registered: Handler) => {
    syncHandler = registered;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  }) as typeof Deno.serve;
  await import("../../supabase/functions/instagram-insights-sync/index.ts");
  Deno.serve = ((registered: Handler) => {
    mcpHandler = registered;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  }) as typeof Deno.serve;
  await import("../../supabase/functions/mcp/index.ts");
} finally {
  Deno.serve = serve;
}
if (!syncHandler || !mcpHandler) throw new Error("A real owner release composition did not register");
const registeredSync = syncHandler as Handler;
const registeredMcp = mcpHandler as Handler;
let generationFenceTriggered = false;
let generationChangeMs = 0;

async function historyFingerprint() {
  const histories = ["ig_media_insight_snapshots", "ig_account_insight_daily", "ig_account_profile_observations"];
  const entries = histories.flatMap((table) => [`'${table}'`, `(SELECT md5(COALESCE(jsonb_agg(to_jsonb(history) ORDER BY history.id)::text,'[]')) FROM public.${table} history WHERE user_id='${OWNER_RELEASE.ownerId}' AND social_account_id='${OWNER_RELEASE.accountId}')`]);
  return JSON.parse(await ownerReleaseSql(`SELECT jsonb_build_object(${entries.join(",")});`));
}

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/__owner-release/meta-owned") {
    if (request.headers.get("Authorization") !== `Bearer ${serviceKey}`) return new Response(null, { status: 401 });
    if (request.method === "GET") {
      const fingerprints: Record<string, unknown> = {};
      for (const platform of META_PLATFORMS) {
        const prefix = platform === "facebook" ? "fb" : "threads";
        const tables = [`${prefix}_analytics_report_state`, `${prefix}_analytics_permission_observations`, `${prefix}_analytics_collection_jobs`,
          `${prefix}_analytics_collection_operations`, `${prefix}_analytics_collection_checkpoints`, `${prefix}_analytics_captures`, `${prefix}_analytics_metric_values`, `${prefix}_post_insight_snapshots`];
        for (const table of tables) fingerprints[table] = await ownerReleaseSql(`SELECT md5(COALESCE(jsonb_agg(to_jsonb(history) ORDER BY to_jsonb(history)::text)::text,'[]')) FROM public.${table} history
          WHERE social_account_id IN (${META_ACCOUNTS.filter((account) => account.platform === platform && ["archived", "foreign"].includes(account.kind)).map((account) => `'${account.id}'`).join(",")});`);
      }
      return Response.json({ calls: ownedMeta.calls, fingerprints });
    }
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const input = await request.json();
    if (!META_PLATFORMS.includes(input.platform) || !["drain", "disconnect", "revision"].includes(input.action)) return new Response(null, { status: 400 });
    const platform: MetaFixturePlatform = input.platform;
    const account = META_ACCOUNTS.find((entry) => entry.platform === platform && entry.kind === "active")!;
    if (input.action === "disconnect") {
      await ownerReleaseSql(`UPDATE public.social_accounts SET is_active=false,needs_reauth=true,token_expires_at=clock_timestamp()-interval '1 hour' WHERE id='${account.id}' AND user_id='${account.owner}';`);
      return Response.json({ disconnected: account.id });
    }
    if (input.action === "revision") {
      await ownerReleaseSql(`UPDATE public.${platform === "facebook" ? "fb" : "threads"}_analytics_report_state SET report_revision=report_revision+1 WHERE social_account_id='${account.id}' AND user_id='${account.owner}';`);
      return Response.json({ changed: account.id });
    }
    const invoke = (action: string) => savedMetaSync(new Request(`${OWNER_RELEASE.apiUrl}/functions/v1/meta-owned-analytics-sync`, {
      method: "POST", headers: { Authorization: "Bearer synthetic-owner-release-cron-secret", "Content-Type": "application/json" }, body: JSON.stringify({ action, platform }),
    }));
    const enqueued = await invoke("enqueue-daily");
    const enqueue = await enqueued.json();
    if (!enqueued.ok) return Response.json({ enqueue }, { status: enqueued.status });
    const drained = await invoke("drain");
    return Response.json({ enqueue, drain: await drained.json() }, { status: drained.status });
  }
  if (url.pathname === "/__owner-release/health") {
    const [auth, sql] = await Promise.all([
      originalFetch(`${OWNER_RELEASE.authUrl}/health`),
      originalFetch(`${OWNER_RELEASE.restUrl}/social_accounts?select=id&limit=0`, { headers: { Authorization: `Bearer ${serviceKey}` } }),
    ]);
    await Promise.all([auth.body?.cancel(), sql.body?.cancel()]);
    return Response.json({ fixture: "isolated-owner-release", authReachable: auth.ok, sqlReachable: sql.ok }, { status: auth.ok && sql.ok ? 200 : 503 });
  }
  if (url.pathname === "/__owner-release/provider-calls") {
    if (request.headers.get("Authorization") !== `Bearer ${serviceKey}`) return new Response(null, { status: 401 });
    return Response.json(meta.calls.map(({ host, kind, target }) => ({ host, kind, target })));
  }
  if (url.pathname === "/__owner-release/collection-off") {
    if (request.method !== "POST" || request.headers.get("Authorization") !== `Bearer ${serviceKey}`) return new Response(null, { status: 401 });
    await ownerReleaseSql("UPDATE public.app_settings SET value='false'::jsonb WHERE key='collection_instagram_insights_enabled';");
    const enabled = await ownerReleaseSql("SELECT value::text FROM public.app_settings WHERE key='collection_instagram_insights_enabled';");
    return Response.json({ collectionEnabled: enabled === "true" });
  }
  if (url.pathname === "/__owner-release/generation-fence") {
    if (request.headers.get("Authorization") !== `Bearer ${serviceKey}`) return new Response(null, { status: 401 });
    if (request.method === "POST") {
      await seedOwnerRelease();
      generationFenceTriggered = false;
      generationChangeMs = 0;
      rpcFailures.length = 0;
      meta.reset();
      meta.setHook(async (call) => {
        if (call.target !== "ig-owner-release" || generationFenceTriggered) return;
        const changeStarted = performance.now();
        // Use real PostgREST inside the provider deadline; spawning Docker CLI probes can exceed it on Windows.
        const changed = await originalFetch(`${OWNER_RELEASE.restUrl}/instagram_account_capabilities?user_id=eq.${OWNER_RELEASE.ownerId}&social_account_id=eq.${OWNER_RELEASE.accountId}&select=credential_generation`, {
          method: "PATCH", headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "return=representation" },
          body: JSON.stringify({ credential_generation: 2 }),
        });
        if (!changed.ok) throw new Error("Fixture generation change was refused");
        const generations = await changed.json();
        if (generations.length !== 1 || generations[0].credential_generation !== 2) throw new Error("Fixture generation change did not reach its exact target");
        generationFenceTriggered = true;
        generationChangeMs = performance.now() - changeStarted;
      });
    } else if (request.method !== "GET") return new Response(null, { status: 405 });
    return Response.json({ triggered: generationFenceTriggered, history: await historyFingerprint(), rpcFailures, generationChangeMs });
  }
  if (url.pathname === "/functions/v1/instagram-insights-report") return reportHandler(request);
  if (url.pathname === "/functions/v1/meta-owned-analytics-report") return savedMetaReport(request);
  if (url.pathname === "/functions/v1/meta-owned-analytics-sync") return savedMetaSync(request);
  if (url.pathname === "/functions/v1/instagram-insights-sync") return registeredSync(request);
  if (url.pathname.startsWith("/functions/v1/n8n-api/")) {
    url.pathname = url.pathname.replace("/functions/v1", "");
    return registeredApi(new Request(url, request));
  }
  if (["/functions/v1/mcp", "/functions/v1/mcp/read"].includes(url.pathname)) {
    return registeredMcp(request);
  }
  const proxy = url.pathname.startsWith("/auth/v1/") ? { base: OWNER_RELEASE.authUrl, prefix: "/auth/v1" }
    : url.pathname.startsWith("/rest/v1/") ? { base: OWNER_RELEASE.restUrl, prefix: "/rest/v1" } : null;
  if (!proxy) return Response.json({ error: "fixture_route_not_found" }, { status: 404 });
  const destination = `${proxy.base}${url.pathname.slice(proxy.prefix.length)}${url.search}`;
  return originalFetch(new Request(destination, request));
}

Deno.serve({ hostname: "127.0.0.1", port: 65431 }, async (request) => {
  const origin = request.headers.get("Origin");
  if (origin && !["http://127.0.0.1:8080", "http://localhost:8080"].includes(origin)) return new Response(null, { status: 403 });
  try {
    const response = request.method === "OPTIONS" ? new Response(null, { status: 204 }) : await route(request);
    const headers = new Headers(response.headers);
    if (origin) headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type, prefer, range");
    headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    headers.set("Access-Control-Expose-Headers", "content-range");
    return new Response(response.body, { status: response.status, headers });
  } catch {
    console.error("Isolated owner-release route failed");
    return Response.json({ error: "fixture_route_failed" }, { status: 500 });
  }
});
