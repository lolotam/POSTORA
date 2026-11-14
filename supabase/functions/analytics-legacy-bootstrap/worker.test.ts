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
    if (name === "record_analytics_legacy_bootstrap_refusal") return { error: null, data: null };
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
    if (name === "settle_analytics_legacy_bootstrap") {
      reasonCode = String(args.p_reason);
      state = reasonCode === "permission_missing" ? "permissions_missing" : reasonCode === "token_invalid" ? "needs_reconnect" : "retry";
    }
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

Deno.test("successful verification and permission bodies may use the existing eight-second request budget", async () => {
  for (const slowRequest of ["/debug_token", "/me/permissions"]) {
    const test = fixture();
    const fetcher = test.input.fetcher;
    test.input.fetcher = async (request, init) => {
      const response = await fetcher(request, init);
      if (!new URL(String(request)).pathname.endsWith(slowRequest)) return response;
      const bytes = new Uint8Array(await response.arrayBuffer());
      return new Response(new ReadableStream({ async start(controller) {
        await new Promise((resolve) => setTimeout(resolve, 4_200));
        controller.enqueue(bytes);
        controller.close();
      } }));
    };
    const outcome = await runLegacyBootstrap(test.input);
    assertEquals(outcome.accounts[0].state, "ready", slowRequest);
    assertEquals(test.counters(), { installs: 1, calls: 5 });
  }
});

Deno.test("inspection and usage persistence cannot outlive the provider's remaining request budget", async () => {
  for (const stalled of ["body", "usage_write"]) {
    const test = fixture();
    const rpc = test.input.rpc;
    let stopped: AbortSignal | undefined;
    test.input.rpc = (name, args, signal) => {
      if (name !== "record_analytics_legacy_bootstrap_usage") return rpc(name, args, signal);
      stopped = signal;
      return new Promise(() => {});
    };
    test.input.fetcher = async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return stalled === "body" ? new Response(new ReadableStream({ start() {} }))
        : Response.json({ data: {} }, { headers: { "x-app-usage": '{"call_count":20}' } });
    };
    const started = Date.now();
    const outcome = await runLegacyBootstrap({ ...test.input, deadline: started + 5_250 });
    assertEquals(outcome.accounts[0].reason_code, "provider_error");
    assertEquals(Date.now() - started < 750, true);
    if (stalled === "usage_write") assertEquals(stopped?.aborted, true);
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

for (const status of [200, 400]) Deno.test(`HTTP ${status} Graph throttles persist the app pause and the identical provider deadline on settlement`, async () => {
  for (const code of [4, 17, 32, 613]) {
    const test = fixture();
    const original = test.input.rpc;
    let recorded: unknown;
    let settled: unknown;
    test.input.rpc = async (name, args, signal) => {
      if (name === "record_analytics_legacy_bootstrap_usage") recorded = args.p_retry_at;
      if (name === "settle_analytics_legacy_bootstrap") settled = args.p_retry_at;
      return await original(name, args, signal);
    };
    test.input.fetcher = () => Promise.resolve(Response.json({ error: { code } }, { status,
      headers: { "retry-after": "259200", "x-app-usage": '{"call_count":20}' } }));
    const outcome = await runLegacyBootstrap(test.input);
    assertEquals(outcome.accounts[0].reason_code, "rate_limited");
    assertEquals(Date.parse(String(recorded)) > Date.now() + 2 * 86_400_000, true);
    assertEquals(settled, recorded);
  }
});

Deno.test("transient permission denials remain pending instead of requiring consent", async () => {
  for (const code of [10, 200]) {
    const test = fixture({ permissions: { error: { code, is_transient: true } } });
    const outcome = await runLegacyBootstrap(test.input);
    assertEquals(outcome.accounts[0].state, "permission_pending");
  }
});

Deno.test("untrusted callers cannot cause durable refusal writes even while bootstrap is disabled", async () => {
  const oldCron = Deno.env.get("CRON_SECRET");
  Deno.env.set("CRON_SECRET", secret());
  try {
    const test = fixture({ disabled: true });
    let writes = 0;
    const rpc: BootstrapRpc = () => { writes++; throw new Error("Untrusted request reached database"); };
    const forged = [btoa(JSON.stringify({ alg: "HS256" })), btoa(JSON.stringify({ role: "service_role" })), secret()].join(".");
    for (const authorization of [undefined, `Bearer ${secret()}`, `Bearer ${forged}`]) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const response = await bootstrapHandler(new Request("https://example.invalid", { method: "POST",
          headers: authorization ? { Authorization: authorization } : {}, body: '{"action":"drain"}' }), { ...test.input, rpc });
        assertEquals(response.status, 401);
        assertEquals(await response.json(), { error: "unauthorized" });
      }
    }
    assertEquals(writes, 0);
  } finally {
    if (oldCron === undefined) Deno.env.delete("CRON_SECRET"); else Deno.env.set("CRON_SECRET", oldCron);
  }
});

Deno.test("authenticated HTTP refusals persist only a closed reason; audit failure is explicit and bounded", async () => {
  const oldCron = Deno.env.get("CRON_SECRET");
  const cron = secret();
  Deno.env.set("CRON_SECRET", cron);
  try {
    const test = fixture();
    const rows: Record<string, unknown>[] = [];
    const rpc: BootstrapRpc = async (name, args) => {
      assertEquals(name, "record_analytics_legacy_bootstrap_refusal");
      rows.push(args);
      return { data: null, error: null };
    };
    for (const [method, expected] of [["GET", "invalid_method"], ["POST", "invalid_request"]] as const) {
      const request = () => new Request("https://example.invalid", { method,
        headers: { Authorization: `Bearer ${cron}` }, ...(method === "POST" ? { body: secret() } : {}) });
      const response = await bootstrapHandler(request(), { ...test.input, rpc });
      assertEquals((await response.json()).error, expected);
      assertEquals(rows.at(-1), { p_reason: expected });
      const failure = await bootstrapHandler(request(), { ...test.input, rpc: () => Promise.resolve({ data: null, error: { message: secret() } }) });
      assertEquals(failure.status, 503);
      assertEquals(await failure.json(), { error: "audit_or_store_unavailable" });
    }
    const started = Date.now();
    const timeout = await bootstrapHandler(new Request("https://example.invalid", { headers: { Authorization: `Bearer ${cron}` } }), { ...test.input,
      deadline: started + 40, rpc: () => new Promise(() => {}) });
    assertEquals(timeout.status, 503);
    assertEquals(Date.now() - started < 500, true);
  } finally {
    if (oldCron === undefined) Deno.env.delete("CRON_SECRET"); else Deno.env.set("CRON_SECRET", oldCron);
  }
});

Deno.test("job retries respect SQL's seven-day ceiling while app pauses retain the full provider deadline", async () => {
  const originalNow = Date.now;
  const now = originalNow();
  Date.now = () => now;
  try {
    // Below, immediately below, exactly at, and above the SQL settlement ceiling.
    for (const seconds of [3 * 86_400, 7 * 86_400 - 1, 7 * 86_400, 14 * 86_400]) {
      const test = fixture();
      const originalRpc = test.input.rpc;
      let pausedUntil: unknown;
      let settledUntil: unknown;
      test.input.rpc = async (name, args, signal) => {
        if (name === "record_analytics_legacy_bootstrap_usage") pausedUntil = args.p_retry_at;
        if (name === "settle_analytics_legacy_bootstrap") {
          settledUntil = args.p_retry_at;
          if (Date.parse(String(settledUntil)) > now + 7 * 86_400_000) throw new Error("BOOTSTRAP_INVALID_REASON");
        }
        return await originalRpc(name, args, signal);
      };
      test.input.fetcher = () => Promise.resolve(Response.json({ error: { code: 4 } }, { status: 429,
        headers: { "retry-after": String(seconds) } }));
      const outcome = await runLegacyBootstrap(test.input);
      assertEquals(outcome.accounts[0].state, "retry");
      assertEquals(outcome.accounts[0].reason_code, "rate_limited");
      assertEquals(pausedUntil, new Date(now + seconds * 1000).toISOString());
      assertEquals(settledUntil, new Date(now + Math.min(seconds, 7 * 86_400) * 1000).toISOString());
    }
  } finally { Date.now = originalNow; }
});
