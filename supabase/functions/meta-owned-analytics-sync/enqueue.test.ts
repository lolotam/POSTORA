import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createOwnedAnalyticsSyncHandler, type OwnedAnalyticsSyncDeps } from "./handler.ts";

const OWNER = "91000000-0000-4000-8000-000000000001";
const ACCOUNT = "92000000-0000-4000-8000-000000000001";
function request(platform: "facebook" | "threads", extra: Record<string, unknown> = {}) {
  return new Request("https://owned-analytics.invalid", { method: "POST", headers: { Authorization: "Bearer synthetic-service" },
    body: JSON.stringify({ action: "enqueue", user_id: OWNER, platform, accountId: ACCOUNT, ...extra }) });
}

Deno.test("service account enqueue verifies ownership/policy before provider work and audits every refusal", async () => {
  for (const scenario of ["unauthorized", "foreign", "collection_disabled", "not_eligible", "invalid"]) {
    let calls = 0, providers = 0, audits = 0;
    const handler = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: false, status: 401 }),
      authorizeEnqueue: async (_req, owner) => { assertEquals(owner, OWNER); return scenario !== "unauthorized"; },
      app: () => ({ id: "app", secret: "synthetic-secret" }),
      rpc: (name, args) => {
        calls++;
        assertEquals(name, "read_meta_analytics_enqueue_scope");
        assertEquals(args, { p_user_id: OWNER, p_platform: "facebook", p_account_id: ACCOUNT });
        return Promise.resolve(scenario === "foreign" ? { data: null, error: { code: "MAH02" } }
          : { data: { status: scenario }, error: null });
      },
      fetch: async () => { providers++; throw new Error("Policy refusal must precede provider requests"); },
      audit: async () => { audits++; return true; },
    });
    const response = await handler(request("facebook", scenario === "invalid" ? { force: true } : {}));
    assertEquals(response.status, scenario === "unauthorized" ? 401 : scenario === "foreign" ? 404 : scenario === "invalid" ? 401 : 200);
    assertEquals(calls, ["invalid", "unauthorized"].includes(scenario) ? 0 : 1);
    assertEquals(providers, 0);
    assertEquals(audits, 1);
  }
});

Deno.test("Facebook and Threads account enqueue retain ordinary queue and retry receipts after admission", async () => {
  for (const platform of ["facebook", "threads"] as const) {
    for (const status of ["queued", "throttled", "success"] as const) {
      const authority = platform === "facebook" ? { platform_user_id: "page1", connection_version: 1,
        credential_id: "95000000-0000-4000-8000-000000000001", credential_revision: 1, provider_user_id: "person1", token_expires_at: null }
        : { platform_user_id: "threads1", credential_generation: 1, token_expires_at: null };
      const scopes = platform === "facebook" ? ["read_insights", "pages_read_engagement"] : ["threads_basic", "threads_manage_insights"];
      let enqueues = 0;
      const deps: OwnedAnalyticsSyncDeps = {
        authorize: () => ({ ok: false, status: 401 }), authorizeEnqueue: async () => true,
        app: () => ({ id: "app1", secret: "synthetic-secret" }),
        rpc: (name, args) => {
          if (name === "read_meta_analytics_enqueue_scope") return Promise.resolve({ data: { status: "eligible" }, error: null });
          if (name.startsWith("read_") && name.endsWith("_analytics_admission_credential")) return Promise.resolve({ data: {
            account_id: ACCOUNT, user_id: OWNER, authority, access_token: "synthetic-access", permission_token: "synthetic-grant",
          }, error: null });
          if (name.startsWith("observe_")) return Promise.resolve({ data: { account_id: ACCOUNT, authority, state: "verified" }, error: null });
          assertEquals(name, "enqueue_meta_analytics_for_user");
          assertEquals(args, { p_user_id: OWNER, p_platform: platform, p_account_id: ACCOUNT });
          enqueues++;
          return Promise.resolve({ data: { status, job_id: ACCOUNT, ...(status === "throttled" ? { retry_after_seconds: 120 } : {}) }, error: null });
        },
        fetch: async (input) => {
          const url = new URL(String(input));
          return Response.json(url.pathname.endsWith("/debug_token") ? { data: { is_valid: true, app_id: "app1", scopes,
            user_id: "provider_user_id" in authority ? authority.provider_user_id : authority.platform_user_id } }
            : { id: authority.platform_user_id }, { headers: { "facebook-api-version": "v25.0" } });
        },
        audit: async () => true,
      };
      const response = await createOwnedAnalyticsSyncHandler(deps)(request(platform));
      assertEquals(response.status, status === "queued" ? 202 : status === "throttled" ? 429 : 200);
      const receipt = await response.json();
      assertEquals(receipt.status, status);
      if (status === "throttled") assertEquals(receipt.retry_after_seconds, 120);
      assertEquals(enqueues, 1);
      assertEquals(JSON.stringify(receipt).includes("synthetic-"), false);
    }
  }
});
