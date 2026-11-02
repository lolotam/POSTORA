/** Loopback Auth/PostgREST/SQL and real registered routes; provider HTTP alone is synthetic. */
import { fileURLToPath } from "node:url";
import { assertPreparedOwnerExecutionSource } from "../../scripts/instagram-owner-execution-source.mjs";
import { ownerReleaseSql, syntheticOwnerReleaseKey } from "./instagramOwnerReleaseSeed.ts";
import { cleanupInstagramRelease, seedInstagramRelease } from "./instagramReleaseSeed.ts";
import {
  INSTAGRAM_RELEASE, InstagramReleaseMetaTransport, assertInstagramReleaseEnvironment,
  assertInstagramReleaseNetworkUrl, type ProviderScenario, type ReleaseAccountKey, type ReleaseUserKey,
} from "./instagramRelease.ts";

const candidate = assertPreparedOwnerExecutionSource(fileURLToPath(new URL("../../", import.meta.url)));
const anonKey = await syntheticOwnerReleaseKey("anon");
const serviceKey = await syntheticOwnerReleaseKey("service_role");
const { cronSecret, providerSecret } = INSTAGRAM_RELEASE;
const runtimeEnvironment = {
  SUPABASE_URL: INSTAGRAM_RELEASE.apiUrl, SUPABASE_ANON_KEY: anonKey, SUPABASE_SERVICE_ROLE_KEY: serviceKey,
  CRON_SECRET: cronSecret, FACEBOOK_APP_ID: INSTAGRAM_RELEASE.appId,
  FACEBOOK_APP_SECRET: providerSecret, INSTAGRAM_APP_ID: INSTAGRAM_RELEASE.appId,
  PUBLIC_API_ORIGIN: INSTAGRAM_RELEASE.apiUrl, PUBLIC_APP_ORIGIN: INSTAGRAM_RELEASE.appUrl,
  VITE_SUPABASE_URL: INSTAGRAM_RELEASE.apiUrl, VITE_SUPABASE_PUBLISHABLE_KEY: anonKey,
};
assertInstagramReleaseEnvironment(Deno.env.toObject(), runtimeEnvironment);
for (const [key, synthetic] of Object.entries(runtimeEnvironment)) Deno.env.set(key, synthetic);

const nativeFetch = globalThis.fetch;
let providerReady = false;
let networkRefusals = 0;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (["graph.facebook.com", "graph.instagram.com"].includes(url.hostname)) {
    if (!providerReady) throw new Error("Instagram release provider requested before fixture ownership");
    return provider.reply(request);
  }
  try { assertInstagramReleaseNetworkUrl(request.url, "server"); }
  catch (refusal) { networkRefusals += 1; throw refusal; }
  return nativeFetch(request, { redirect: "error" });
};

type Handler = (request: Request) => Response | Promise<Response>;
async function registeredRoute(path: string): Promise<Handler> {
  const nativeServe = Deno.serve;
  let captured: Handler | undefined;
  try {
    Deno.serve = ((handler: Handler) => {
      if (captured) throw new Error("Instagram release route registered more than once");
      captured = handler;
      return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
    }) as typeof Deno.serve;
    await import(path);
  } finally { Deno.serve = nativeServe; }
  if (!captured) throw new Error("Instagram release production route did not register");
  return captured;
}

const routes = new Map<string, Handler>([
  ["brand-scrape", await registeredRoute("../../supabase/functions/brand-scrape/index.ts")],
  ["instagram-insights-sync", await registeredRoute("../../supabase/functions/instagram-insights-sync/index.ts")],
  ["competitor-snapshot-sync", await registeredRoute("../../supabase/functions/competitor-snapshot-sync/index.ts")],
  ["competitor-retention", await registeredRoute("../../supabase/functions/competitor-retention/index.ts")],
  ["mcp", await registeredRoute("../../supabase/functions/mcp/index.ts")],
  ["instagram-insights-report", (await import("../../supabase/functions/instagram-insights-report/index.ts")).handler],
  ["competitor-tracking-report", await registeredRoute("../../supabase/functions/competitor-tracking-report/index.ts")],
  // The canonical registry currently refuses Instagram. Register its actual refusal, never a fabricated calendar.
  ["meta-owned-analytics-report", (await import("../../supabase/functions/meta-owned-analytics-report/index.ts")).handler],
]);
const registeredApi = (await import("../../supabase/functions/n8n-api/index.ts")).handleRequest;
const seed = await seedInstagramRelease();
const provider = new InstagramReleaseMetaTransport(seed.manifest);
providerReady = true;
let cleaned = false;
let stopping: Promise<void> | undefined;

async function cleanup(): Promise<void> {
  if (cleaned) return;
  if (!stopping) stopping = cleanupInstagramRelease(seed)
    .then(() => { cleaned = true; })
    .finally(() => { stopping = undefined; });
  await stopping;
}

async function health(): Promise<Response> {
  const [auth, sql] = await Promise.all([
    fetch(`${INSTAGRAM_RELEASE.authUrl}/health`, { signal: AbortSignal.timeout(3_000) }),
    fetch(`${INSTAGRAM_RELEASE.restUrl}/social_accounts?select=id&limit=0`, { headers: { Authorization: `Bearer ${serviceKey}` }, signal: AbortSignal.timeout(3_000) }),
  ]);
  await Promise.all([auth.body?.cancel(), sql.body?.cancel()]);
  return Response.json({ fixture: "instagram-release", authReachable: auth.ok, sqlReachable: sql.ok,
    manifest: seed.manifest, candidate, networkRefusals, routes: [...routes.keys()],
    blockers: ["instagram_canonical_registry_unverified", "target_ineligible_provider_signal_unverified", "threshold_unavailable_provider_signal_unverified", "worker_reference_clock_seam_missing"],
    pendingAssembly: ["protected_oauth_reconnect_transport", "admin_enabled_interactive_apify_transport", "full_journeys_and_retention_races"],
  }, { status: auth.ok && sql.ok && networkRefusals === 0 && !cleaned ? 200 : 503 });
}

async function fixtureControl(request: Request, path: string): Promise<Response> {
  if (path === "health" && request.method === "GET") return health();
  if (request.headers.get("Authorization") !== `Bearer ${serviceKey}`) return new Response(null, { status: 401 });
  if (request.headers.get("X-Instagram-Release-Namespace") !== seed.manifest.namespace
    || request.headers.get("X-Instagram-Release-Candidate") !== candidate) return new Response(null, { status: 409 });
  if (path === "provider-calls" && request.method === "GET") return Response.json({ calls: provider!.calls, networkRefusals });
  if (path === "cleanup" && request.method === "POST") { await cleanup(); return Response.json({ cleaned }); }
  if (cleaned) return Response.json({ error: "fixture_cleaned" }, { status: 409 });
  if (path === "state" && request.method === "GET") return fixtureState();
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const body: unknown = await request.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) return new Response(null, { status: 400 });
  const input = body as Record<string, unknown>;
  if (path === "provider-scenario") return setProviderScenario(input);
  if (path === "quota") return setQuota(input);
  if (path === "drain") return drain(input);
  return new Response(null, { status: 404 });
}

async function fixtureState(): Promise<Response> {
  const owners = Object.values(seed.manifest.users).map((user) => `'${user.id}'`).join(",");
  const state = JSON.parse(await ownerReleaseSql(`SELECT jsonb_build_object(
   'users',(SELECT count(*) FROM auth.users WHERE id IN (${owners})),
   'admins',(SELECT COALESCE(jsonb_agg(user_id),'[]'::jsonb) FROM public.user_roles WHERE user_id IN (${owners}) AND role='admin'),
   'quotas',(SELECT jsonb_object_agg(user_id,max_tracked_competitors) FROM public.user_quotas WHERE user_id IN (${owners})),
   'active',(SELECT jsonb_object_agg(user_id,total) FROM (SELECT user_id,count(*) total FROM public.competitor_watchlist WHERE user_id IN (${owners}) AND is_active GROUP BY user_id) counts),
   'active_cron',(SELECT count(*) FROM cron.job WHERE active),
   'completed_jobs',(SELECT count(*) FROM public.instagram_collection_jobs WHERE user_id IN (${owners}) AND status='completed'));`));
  return Response.json(state);
}

function setProviderScenario(input: Record<string, unknown>): Response {
  const scenarios: ProviderScenario[] = ["normal", "token_expired", "permission_denied", "network_failure", "threshold_unavailable", "empty_metric"];
  if (Object.keys(input).sort().join(",") !== "account,scenario" || !seed.manifest.accounts.some((account) => account.key === input.account)
    || !scenarios.includes(input.scenario as ProviderScenario)) return new Response(null, { status: 400 });
  provider!.scenarios.set(input.account as ReleaseAccountKey, input.scenario as ProviderScenario);
  return Response.json({ scenario: input.scenario });
}

async function setQuota(input: Record<string, unknown>): Promise<Response> {
  if (Object.keys(input).sort().join(",") !== "limit,owner" || !["ownerA", "ownerB"].includes(String(input.owner))
    || ![-1, 0, 3, 5, 20].includes(Number(input.limit)) || typeof input.limit !== "number") return new Response(null, { status: 400 });
  const owner = seed.manifest.users[input.owner as ReleaseUserKey];
  await ownerReleaseSql(`UPDATE public.user_quotas SET max_tracked_competitors=${input.limit} WHERE user_id='${owner.id}';`);
  return Response.json({ owner: input.owner, limit: input.limit });
}

async function drain(input: Record<string, unknown>): Promise<Response> {
  if (Object.keys(input).join(",") !== "kind" || !["owner", "competitor"].includes(String(input.kind))) return new Response(null, { status: 400 });
  const name = input.kind === "owner" ? "instagram-insights-sync" : "competitor-snapshot-sync";
  // Intake remains a separate authenticated request: a drain never seeds or invents a completed job.
  return routes.get(name)!(new Request(`${INSTAGRAM_RELEASE.apiUrl}/functions/v1/${name}`, { method: "POST",
    headers: { Authorization: `Bearer ${INSTAGRAM_RELEASE.cronSecret}`, "Content-Type": "application/json" }, body: JSON.stringify({ action: "drain" }) }));
}

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/__instagram-release/")) return fixtureControl(request, url.pathname.slice("/__instagram-release/".length));
  if (cleaned) return Response.json({ error: "fixture_cleaned" }, { status: 503 });
  const functionName = url.pathname.split("/")[3];
  if (url.pathname.startsWith("/functions/v1/n8n-api/")) {
    url.pathname = url.pathname.replace("/functions/v1", "");
    return registeredApi(new Request(url, request));
  }
  if (url.pathname.startsWith("/functions/v1/") && routes.has(functionName)) return routes.get(functionName)!(request);
  const proxy = url.pathname.startsWith("/auth/v1/") ? { base: INSTAGRAM_RELEASE.authUrl, prefix: "/auth/v1" }
    : url.pathname.startsWith("/rest/v1/") ? { base: INSTAGRAM_RELEASE.restUrl, prefix: "/rest/v1" } : null;
  if (!proxy) return Response.json({ error: "fixture_route_not_found" }, { status: 404 });
  return fetch(new Request(`${proxy.base}${url.pathname.slice(proxy.prefix.length)}${url.search}`, request));
}

async function serveRequest(request: Request): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (origin && origin !== INSTAGRAM_RELEASE.appUrl) return new Response(null, { status: 403 });
  try {
    const response = request.method === "OPTIONS" ? new Response(null, { status: 204 }) : await route(request);
    const headers = new Headers(response.headers);
    if (origin) headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Headers", "authorization,x-client-info,apikey,content-type,prefer,range,x-instagram-release-namespace,x-instagram-release-candidate");
    headers.set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    headers.set("Access-Control-Expose-Headers", "content-range");
    return new Response(response.body, { status: response.status, headers });
  } catch {
    console.error("Canonical Instagram release route failed");
    return Response.json({ error: "fixture_route_failed" }, { status: 500 });
  }
}

async function startServer() {
  try { return Deno.serve({ hostname: "127.0.0.1", port: 65431 }, serveRequest); }
  catch (failure) { await cleanup(); throw failure; }
}

const server = await startServer();
const signals: Deno.Signal[] = Deno.build.os === "windows" ? ["SIGINT"] : ["SIGINT", "SIGTERM"];
for (const signal of signals) Deno.addSignalListener(signal, () => {
  void cleanup().then(() => server.shutdown()).catch(() => { console.error("Canonical Instagram release cleanup failed"); Deno.exit(1); });
});
