import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runLegacyBootstrap, type BootstrapRpc } from "./worker.ts";
import { BootstrapFailure } from "./provider.ts";
import { bootstrapHandler } from "./handler.ts";

const accountId = crypto.randomUUID();
const jobId = crypto.randomUUID();
const leaseId = crypto.randomUUID();
const secret = () => ["synthetic", crypto.randomUUID()].join("-");
const apps = { facebook: { id: "200001", secret: secret() }, instagram: { id: "200002", secret: secret() } };
function fixture(options: { lost?: "install" | "permission"; permissions?: unknown; disabled?: boolean; denied?: boolean } = {}) {
  const credential = secret();
  let state = "verifying";
  let revision = 1;
  let installed = false;
  let installs = 0;
  let calls = 0;
  let reasonCode: string | null = null;
  const projection = () => ({ job_id: jobId, account_id: accountId, state, revision, installed, reason_code: reasonCode });
  const rpc: BootstrapRpc = async (name, args) => {
    if (name === "dispatch_analytics_legacy_bootstrap") return { error: null, data: {
      status: options.disabled ? "disabled" : "dispatched", account_ids: options.disabled ? [] : [accountId] } };
    if (name === "begin_analytics_legacy_bootstrap") return { error: null, data: { ...projection(), lease_id: leaseId,
      user_id: crypto.randomUUID(), capture: { token: credential, login_kind: "page_linked", platform: "instagram",
        platform_user_id: "178001", page_id: "100001", provider_user_id: null } } };
    if (name === "permit_analytics_legacy_bootstrap") return { error: null, data: options.denied !== true };
    if (name === "record_analytics_legacy_bootstrap_usage") return { error: null, data: null };
    if (name === "commit_analytics_legacy_bootstrap") {
      installs++;
      installed = true; state = "permission_pending"; revision++;
      if (options.lost === "install") throw new Error(credential);
    }
    if (name === "complete_analytics_legacy_bootstrap") {
      const permissions = args.p_permissions as { state: string; scopes: string[] };
      state = permissions.state === "failed" ? "permission_pending" : permissions.scopes.includes("instagram_manage_insights") ? "ready" : "permissions_missing";
      revision++;
      if (options.lost === "permission") throw new Error(credential);
    }
    if (name === "settle_analytics_legacy_bootstrap") { state = "retry"; reasonCode = String(args.p_reason); }
    return { error: null, data: projection() };
  };
  const fetcher: typeof fetch = async () => {
    calls++;
    const payloads = [
      { data: { is_valid: true, type: "USER", app_id: "200001", user_id: "300001", expires_at: 0, data_access_expires_at: 0 } },
      { id: "300001" }, { data: [{ id: "100001" }] }, { id: "100001", instagram_business_account: { id: "178001" } },
      options.permissions ?? { data: [{ permission: "instagram_manage_insights", status: "granted" }] },
    ];
    return Response.json(payloads[calls - 1]);
  };
  return { input: { rpc, apps, fetcher }, counters: () => ({ calls, installs }), credential };
}

Deno.test("lost install or permission replies reconcile durable receipt without replay or token exposure", async () => {
  for (const lost of ["install", "permission"] as const) {
    const test = fixture({ lost });
    const outcome = await runLegacyBootstrap(test.input);
    assertEquals(outcome.accounts[0].state, "ready");
    assertEquals(test.counters(), { installs: 1, calls: 5 });
    assertEquals(JSON.stringify(outcome).includes(test.credential), false);
    assertEquals(JSON.stringify(outcome).includes("capture"), false);
  }
});
Deno.test("malformed and empty permission reads have distinct durable outcomes", async () => {
  for (const [permissions, expected] of [[{}, "permission_pending"], [{ data: [] }, "permissions_missing"]] as const) {
    const test = fixture({ permissions });
    const outcome = await runLegacyBootstrap(test.input);
    assertEquals(outcome.accounts[0].state, expected);
  }
});
Deno.test("disabled master and revoked request permit make zero provider calls", async () => {
  for (const options of [{ disabled: true }, { denied: true }]) {
    const test = fixture(options);
    await runLegacyBootstrap(test.input);
    assertEquals(test.counters(), { installs: 0, calls: 0 });
  }
});
Deno.test("one shared deadline bounds a DB call even if the driver ignores cancellation", async () => {
  const test = fixture();
  test.input.rpc = () => new Promise(() => {});
  const started = Date.now();
  await assertRejects(() => runLegacyBootstrap({ ...test.input, deadline: started + 40 }), BootstrapFailure);
  assertEquals(Date.now() - started < 500, true);
});
Deno.test("usage exhaustion stops verification immediately and retains a longer provider retry", async () => {
  const test = fixture();
  const originalFetch = test.input.fetcher;
  const originalRpc = test.input.rpc;
  let retryAt = "";
  test.input.fetcher = async (request, init) => {
    const response = await originalFetch(request, init);
    response.headers.set("x-app-usage", '{"call_count":85}');
    response.headers.set("retry-after", String(3 * 24 * 60 * 60));
    return response;
  };
  test.input.rpc = async (name, args, signal) => {
    if (name === "record_analytics_legacy_bootstrap_usage") retryAt = String(args.p_retry_at);
    return await originalRpc(name, args, signal);
  };
  const outcome = await runLegacyBootstrap(test.input);
  assertEquals(outcome.accounts[0].reason_code, "rate_limited");
  assertEquals(test.counters(), { installs: 0, calls: 1 });
  assertEquals(Date.parse(retryAt) > Date.now() + 2 * 86_400_000, true);
});
Deno.test("actual handler refuses raw token input, signed-in users and malformed bodies; response is redacted", async () => {
  const oldCron = Deno.env.get("CRON_SECRET");
  const cron = secret();
  Deno.env.set("CRON_SECRET", cron);
  try {
    const test = fixture();
    const unauthorized = await bootstrapHandler(new Request("https://example.invalid", { method: "POST", body: '{"action":"drain"}' }), test.input);
    assertEquals(unauthorized.status, 401);
    const forged = [btoa(JSON.stringify({ alg: "HS256" })), btoa(JSON.stringify({ role: "service_role" })), crypto.randomUUID()].join(".");
    const impersonated = await bootstrapHandler(new Request("https://example.invalid", { method: "POST",
      headers: { Authorization: `Bearer ${forged}` }, body: '{"action":"drain"}' }), test.input);
    assertEquals(impersonated.status, 401);
    const raw = await bootstrapHandler(new Request("https://example.invalid", { method: "POST",
      headers: { Authorization: `Bearer ${cron}` }, body: JSON.stringify({ action: "drain", token: test.credential }) }), test.input);
    assertEquals(raw.status, 400);
    assertEquals((await raw.text()).includes(test.credential), false);
    const good = await bootstrapHandler(new Request("https://example.invalid", { method: "POST",
      headers: { Authorization: `Bearer ${cron}` }, body: '{"action":"drain"}' }), test.input);
    assertEquals(good.status, 200);
    const body = await good.text();
    assertEquals(body.includes(test.credential), false);
    assertEquals(JSON.parse(body).accounts[0].state, "ready");
  } finally {
    if (oldCron === undefined) Deno.env.delete("CRON_SECRET"); else Deno.env.set("CRON_SECRET", oldCron);
  }
});
