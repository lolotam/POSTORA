/** Loopback-only real Auth/PostgREST/report/worker composition; only Meta transport is synthetic. */
import { OWNER_RELEASE, assertOwnerReleaseUrl, ownerReleaseSql, syntheticOwnerReleaseKey } from "./instagramOwnerReleaseSeed.ts";
import { FakeMetaTransport } from "../../supabase/functions/_shared/rolloutIntegrationTestSupport.ts";

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

const originalFetch = globalThis.fetch;
const meta = new FakeMetaTransport();
meta.install();
const syntheticMetaFetch = globalThis.fetch;
meta.restore();
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (["graph.facebook.com", "graph.instagram.com"].includes(url.hostname)) return syntheticMetaFetch(input, init);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !["65431", "65435", "65436"].includes(url.port)) {
    throw new Error("Owner-release runtime refused non-fixture network access");
  }
  return originalFetch(input, init);
};

const { handler: reportHandler } = await import("../../supabase/functions/instagram-insights-report/index.ts");
const { handleRequest: registeredApi } = await import("../../supabase/functions/n8n-api/index.ts");
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

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
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
  if (url.pathname === "/functions/v1/instagram-insights-report") return reportHandler(request);
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
