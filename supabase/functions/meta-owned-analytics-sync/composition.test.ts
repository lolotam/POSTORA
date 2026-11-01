import { assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createOwnedAnalyticsSyncHandler } from "./handler.ts";
import { MetaAnalyticsTransport } from "../_shared/metaAnalyticsTransport.ts";
import { z } from "https://esm.sh/zod@3.25.76";

const API = "https://owned-analytics.invalid";
const SERVICE = "fixture-service";
const CRON = "synthetic-cron";
const ACCOUNT = "92000000-0000-4000-8000-000000000001";
const OWNER = "91000000-0000-4000-8000-000000000001";
const TOKEN = "fixture-op";
const GRANT = "synthetic-protected-user-token";
const APP = "991100";
const SECRET = "fixture-app";
const originalEnvironment = new Map(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "CRON_SECRET", "FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET", "THREADS_APP_ID", "THREADS_APP_SECRET"]
  .map((key) => [key, Deno.env.get(key)]));
const { handler } = await import("./index.ts");

function request(platform: "facebook" | "threads", extra: Record<string, unknown> = {}, token = CRON) {
  return new Request(`${API}/functions/v1/meta-owned-analytics-sync`, { method: "POST", headers: {
    Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: "https://untrusted.invalid",
  }, body: JSON.stringify({ action: "admit", platform, accountId: ACCOUNT, ...extra }) });
}

Deno.test("registered admission keeps real token roles and refuses stale or invalid observations", async (test) => {
  const originalFetch = globalThis.fetch;
  for (const [key, value] of Object.entries({ SUPABASE_URL: API, SUPABASE_SERVICE_ROLE_KEY: SERVICE, CRON_SECRET: CRON,
    FACEBOOK_APP_ID: APP, FACEBOOK_APP_SECRET: SECRET, THREADS_APP_ID: APP, THREADS_APP_SECRET: SECRET })) Deno.env.set(key, value);
  try {
    for (const platform of ["facebook", "threads"] as const) {
      for (const scenario of ["normal", "missing_scope", "wrong_user", "wrong_app", "wrong_operational_identity", "invalid_token", "malformed", "permit_changed", "write_changed", "unknown_write", "invalid_envelope", "no_app_id", "unknown_permit", "extra_scopes"] as const) {
        await test.step(`${platform}: ${scenario}`, async () => {
          const authority = platform === "facebook" ? { platform_user_id: "992001", connection_version: 1,
            credential_id: "95000000-0000-4000-8000-000000000001", credential_revision: 1, provider_user_id: "991001", token_expires_at: null }
            : { platform_user_id: "993001", credential_generation: 1, token_expires_at: null };
          const credential = { account_id: ACCOUNT, user_id: OWNER, authority, access_token: TOKEN, permission_token: platform === "facebook" ? GRANT : TOKEN };
          const required = platform === "facebook" ? ["read_insights", "pages_read_engagement"] : ["threads_basic", "threads_manage_insights"];
          let reads = 0;
          let observations = 0;
          let providerCalls = 0;
          const audits: unknown[] = [];
          globalThis.fetch = async (input, init) => {
            const outgoing = new Request(input, init);
            const url = new URL(outgoing.url);
            if (url.origin === API) {
              assertEquals(outgoing.headers.get("authorization"), `Bearer ${SERVICE}`);
              const body = await outgoing.json();
              if (url.pathname === "/rest/v1/system_logs") { audits.push(body); return new Response(null, { status: 201 }); }
              if (url.pathname.includes("/rest/v1/rpc/read_")) {
                reads++;
                assertEquals(body.p_account_id, ACCOUNT);
                assertEquals(body.p_expected_authority, reads === 1 ? null : authority);
                if (scenario === "invalid_envelope") return Response.json({ credential: TOKEN });
                if ((scenario === "permit_changed" || scenario === "unknown_permit") && reads === 3) {
                  return Response.json({ code: scenario === "permit_changed" ? "MAH04" : "57014", message: SECRET }, { status: 400 });
                }
                return Response.json(credential);
              }
              if (url.pathname.includes("/rest/v1/rpc/observe_")) {
                observations++;
                assertEquals(body.p_expected_authority, authority);
                assertEquals(body.p_user_id, OWNER);
                assertEquals(body.p_granted_scopes, scenario === "missing_scope" ? required.slice(0, 1).sort() : [...required].sort());
                if (scenario === "write_changed" || scenario === "unknown_write") {
                  return Response.json({ code: scenario === "write_changed" ? "MAH04" : "57014", message: TOKEN }, { status: 400 });
                }
                return Response.json({ account_id: ACCOUNT, authority, state: "verified" });
              }
              throw new Error("Unexpected database request");
            }
            assertEquals(url.origin, platform === "facebook" ? "https://graph.facebook.com" : "https://graph.threads.net");
            assertEquals(outgoing.redirect, "error");
            providerCalls++;
            const headers = { "facebook-api-version": "v25.0" };
            if (url.pathname.endsWith("/debug_token")) {
              assertEquals(outgoing.headers.get("authorization"), `Bearer ${platform === "threads" ? "TH|" : ""}${APP}|${SECRET}`);
              assertEquals(url.searchParams.get("input_token"), credential.permission_token);
              if (scenario === "malformed") return Response.json({ data: { is_valid: true } }, { headers });
              return Response.json({ data: { is_valid: scenario !== "invalid_token",
                user_id: scenario === "wrong_user" ? "foreign" : "provider_user_id" in authority ? authority.provider_user_id : authority.platform_user_id,
                ...(scenario === "no_app_id" ? {} : { app_id: scenario === "wrong_app" ? "wrong" : APP }),
                scopes: scenario === "missing_scope" ? required.slice(0, 1) : scenario === "extra_scopes"
                  ? [...required, ...Array.from({ length: 40 }, (_unused, index) => `other_permission_${index}`)] : required } }, { headers });
            }
            assertEquals(url.pathname.endsWith("/me"), true);
            assertEquals(outgoing.headers.get("authorization"), `Bearer ${TOKEN}`);
            return Response.json({ id: scenario === "wrong_operational_identity" ? "foreign" : authority.platform_user_id }, { headers });
          };
          const response = await handler(request(platform));
          const body = await response.json();
          const success = scenario === "normal" || scenario === "no_app_id" && platform === "threads" || scenario === "extra_scopes";
          assertEquals(response.status, success ? 200 : ["unknown_write", "unknown_permit", "invalid_envelope"].includes(scenario) ? 503 : 409);
          assertEquals(body.ok, success);
          assertEquals(response.headers.get("access-control-allow-origin"), null);
          assertEquals(audits.length, 1);
          assertEquals(observations, ["normal", "missing_scope", "write_changed", "unknown_write", "extra_scopes"].includes(scenario) || scenario === "no_app_id" && platform === "threads" ? 1 : 0);
          if (scenario === "permit_changed" || scenario === "unknown_permit") assertEquals(providerCalls, 1);
          if (scenario === "invalid_envelope") assertEquals(providerCalls, 0);
          for (const secret of [TOKEN, GRANT, SECRET]) {
            assertFalse(JSON.stringify(body).includes(secret));
            assertFalse(JSON.stringify(audits).includes(secret));
          }
        });
      }
    }
    for (const token of ["synthetic-user-session", ""]) {
      await test.step("non-service bearer cannot read credentials", async () => {
        let reads = 0;
        globalThis.fetch = async (input) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.pathname !== "/rest/v1/system_logs") { reads++; throw new Error("Unauthorized request accessed a dependency"); }
          return new Response(null, { status: 201 });
        };
        assertEquals((await handler(request("facebook", {}, token))).status, 401);
        assertEquals(reads, 0);
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of originalEnvironment) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
});

Deno.test("admission rejects caller authority and unimplemented actions before credentials", async (test) => {
  for (const extra of [{ user_id: OWNER }, { scopes: [] }, { action: "drain" }, { accountId: "bad" }]) {
    await test.step(JSON.stringify(extra), async () => {
      let reads = 0;
      const composed = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }), app: () => ({ id: APP, secret: SECRET }),
        rpc: () => { reads++; throw new Error("must not read"); }, audit: async () => true });
      assertEquals((await composed(request("facebook", extra))).status, 400);
      assertEquals(reads, 0);
    });
  }
});

Deno.test("an admission dependency ignoring abort cannot continue provider work", async () => {
  const originalNow = Date.now;
  const started = originalNow();
  let clock = started;
  let providerCalls = 0;
  Date.now = () => clock;
  try {
    const composed = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }), app: () => ({ id: APP, secret: SECRET }),
      rpc: () => { clock = started + 39_995; return new Promise(() => undefined); },
      audit: async () => true, fetch: async () => { providerCalls++; throw new Error("must not call"); } });
    const response = await composed(request("threads"));
    assertEquals(response.status, 503);
    assertEquals(providerCalls, 0);
  } finally { Date.now = originalNow; }
});

Deno.test("missing app configuration and oversized bodies refuse before account secrets", async (test) => {
  for (const scenario of ["configuration", "body_limit"] as const) {
    await test.step(scenario, async () => {
      let reads = 0;
      const composed = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }),
        app: () => scenario === "configuration" ? null : { id: APP, secret: SECRET },
        rpc: () => { reads++; throw new Error("must not read"); }, audit: async () => true });
      const incoming = scenario === "configuration" ? request("facebook")
        : new Request(API, { method: "POST", body: "x".repeat(8193) });
      assertEquals((await composed(incoming)).status, scenario === "configuration" ? 503 : 400);
      assertEquals(reads, 0);
    });
  }
});

Deno.test("concurrent permits cannot spend more than the transport call budget", async () => {
  let calls = 0;
  let release: () => void = () => undefined;
  const permit = new Promise<void>((resolve) => { release = resolve; });
  const transport = new MetaAnalyticsTransport({ origin: "https://graph.threads.net", version: "v1.0", token: TOKEN,
    signal: new AbortController().signal, startedAt: Date.now(), maxCalls: 1, fallbackReason: "provider_error", rateLimitedReason: "provider_error",
    failureMessage: "Synthetic failure", classifyFailure: () => null, beforeRequest: () => permit,
    fetch: async () => { calls++; return Response.json({ id: "owned" }); } });
  const pending = [transport.request(["me"], {}, z.object({ id: z.string() })), transport.request(["me"], {}, z.object({ id: z.string() }))];
  release();
  const results = await Promise.all(pending);
  assertEquals(calls, 1);
  assertEquals(results.filter((reply) => reply.data !== null).length, 1);
  assertEquals(results.filter((reply) => reply.error?.kind === "budget").length, 1);
});

Deno.test("permit time is charged before a provider request can start", async () => {
  const originalNow = Date.now;
  const started = originalNow();
  let calls = 0;
  try {
    const transport = new MetaAnalyticsTransport({ origin: "https://graph.threads.net", version: "v1.0", token: TOKEN,
      signal: new AbortController().signal, startedAt: started, budgetMs: 10, fallbackReason: "provider_error", rateLimitedReason: "provider_error",
      failureMessage: "Synthetic failure", classifyFailure: () => null,
      beforeRequest: async () => { Date.now = () => started + 11; },
      fetch: async () => { calls++; return Response.json({ id: "owned" }); } });
    assertEquals((await transport.request(["me"], {}, z.object({ id: z.string() }))).error?.kind, "budget");
    assertEquals(calls, 0);
  } finally { Date.now = originalNow; }
});

Deno.test("a rate limit observed while another permit waits prevents its HTTP request", async () => {
  let permits = 0;
  let calls = 0;
  let release: () => void = () => undefined;
  const waitingPermit = new Promise<void>((resolve) => { release = resolve; });
  const retryAt = new Date(Date.now() + 60_000).toISOString();
  const transport = new MetaAnalyticsTransport({ origin: "https://graph.threads.net", version: "v1.0", token: TOKEN,
    signal: new AbortController().signal, startedAt: Date.now(), fallbackReason: "provider_error", rateLimitedReason: "rate_limited",
    failureMessage: "Synthetic failure", beforeRequest: async () => { if (++permits === 2) await waitingPermit; },
    classifyFailure: (status) => status === 429 ? { status, data: null, retryAt,
      error: { kind: "provider", reason: "rate_limited", message: "Synthetic throttle" } } : null,
    fetch: async () => { calls++; return Response.json({ error: {} }, { status: 429 }); } });
  const first = transport.request(["me"], {}, z.object({ id: z.string() }));
  const waiting = transport.request(["me"], {}, z.object({ id: z.string() }));
  assertEquals((await first).error?.reason, "rate_limited");
  release();
  const refused = await waiting;
  assertEquals(refused.error?.reason, "rate_limited");
  assertEquals(refused.retryAt, retryAt);
  assertEquals(calls, 1);
});
