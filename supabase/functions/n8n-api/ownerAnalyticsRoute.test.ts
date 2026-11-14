import { assert, assertEquals } from "jsr:@std/assert@1";

const ORIGIN = "http://127.0.0.1:9";
const OWNER = "e9110000-0000-4000-8000-000000000001";
const ACCOUNT = "e9120000-0000-4000-8000-000000000001";
type Handler = (request: Request) => Response | Promise<Response>;

Deno.test("registered MCP and API preserve policy refusal and HTTP-200 semantic refusal without collecting on reads", async () => {
  const previousFetch = globalThis.fetch;
  const previousServe = Deno.serve;
  const environment = new Map(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "PUBLIC_API_ORIGIN"].map((key) => [key, Deno.env.get(key)]));
  const fixtureKey = ["postora", crypto.randomUUID()].join("-");
  Deno.env.set("SUPABASE_URL", ORIGIN);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", ["fixture", "service"].join("-"));
  Deno.env.set("PUBLIC_API_ORIGIN", ORIGIN);
  let api: Handler;
  let mcp: Handler | undefined;
  let platform = "instagram";
  let targetCalls = 0;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assertEquals(url.origin, ORIGIN, "No Meta or production traffic is permitted");
    if (url.pathname.startsWith("/functions/v1/n8n-api")) {
      url.pathname = url.pathname.replace("/functions/v1", "");
      return await api(new Request(url, request));
    }
    if (url.pathname === "/rest/v1/profiles") return Response.json({ id: OWNER, preferred_timezone: "UTC" });
    if (url.pathname === "/rest/v1/social_accounts") return Response.json({ id: ACCOUNT, user_id: OWNER, platform, platform_user_id: "page-fixture", is_active: true });
    if (["user_rate_limits", "user_subscriptions", "tier_rate_limits", "rate_limit_settings"].some((table) => url.pathname === `/rest/v1/${table}`)) return Response.json([]);
    if (url.pathname === "/rest/v1/api_logs" && request.method === "HEAD") return new Response(null, { headers: { "content-range": "*/0" } });
    if (["api_logs", "system_logs"].some((table) => url.pathname === `/rest/v1/${table}`) && request.method === "POST") return new Response(null, { status: 201 });
    if (url.pathname === "/functions/v1/instagram-insights-sync") {
      targetCalls++;
      return Response.json({ error: "collection_not_eligible" }, { status: 403 });
    }
    if (url.pathname === "/functions/v1/meta-owned-analytics-sync") {
      targetCalls++;
      return Response.json({ ok: false, status: "not_eligible" });
    }
    if (url.pathname === "/functions/v1/instagram-insights-report") {
      targetCalls++;
      return Response.json({ collection: { state: "not_enabled", reason_code: "collection_not_eligible", reconnect_can_help: false },
        data: { state: "empty", observation_count: 0 }, media: { page: { items: [] } } });
    }
    throw new Error(`Unexpected analytics boundary ${url.pathname}`);
  };
  try {
    ({ handleRequest: api } = await import("./index.ts"));
    Deno.serve = ((registered: Handler) => { mcp = registered; return { finished: Promise.resolve(), shutdown: () => Promise.resolve() }; }) as typeof Deno.serve;
    await import("../mcp/index.ts");
    Deno.serve = previousServe;
    assert(mcp);
    for (const name of ["trigger_analytics_sync", "trigger_analytics_sync", "get_account_analytics"]) {
      const response = await mcp(new Request(`${ORIGIN}/functions/v1/mcp`, { method: "POST",
        headers: { Authorization: `Bearer ${fixtureKey}`, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { social_account_id: ACCOUNT } } }) }));
      const envelope = await response.json();
      assertEquals(response.status, 200);
      const result = envelope.result;
      assert(result, JSON.stringify(envelope));
      assertEquals(result.isError, name === "trigger_analytics_sync" ? true : undefined);
      assertEquals(JSON.parse(result.content[0].text), result.structuredContent);
      const receipt = name === "trigger_analytics_sync" ? result.structuredContent : result.structuredContent.collection;
      assertEquals(receipt.reason_code, "collection_not_eligible");
      assertEquals(receipt.reconnect_can_help, false);
      if (name === "trigger_analytics_sync") assertEquals(receipt.queued, false);
      platform = platform === "instagram" ? "facebook" : "instagram";
    }
    assertEquals(targetCalls, 3, "Read invokes only the persisted report, never collection");
  } finally {
    globalThis.fetch = previousFetch;
    Deno.serve = previousServe;
    for (const [key, value] of environment) { if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value); }
  }
});
