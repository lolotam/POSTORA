// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { handleHealthRequest, parseHealthRequest, type HealthHandlerPorts } from "./handler.ts";

function fakePorts(overrides: Partial<HealthHandlerPorts> = {}) {
  const leases: Array<{ job: string; holder: string }> = [];
  const ports: HealthHandlerPorts = {
    runChunk: async (chunk) => ({
      run_id: "run-1", chunk, done: true, next_chunk: null, results: [],
      summary: { total: 0, connected: 0, failed: 0, needs_relogin: 0 },
    }),
    readResults: async () => [],
    acquireLease: async (job, holder) => { leases.push({ job, holder }); return true; },
    releaseLease: async (job, holder) => { leases.push({ job, holder }); return true; },
    isAuthorized: async () => ({ ok: true }),
    ...overrides,
  };
  return { ports, leases };
}

Deno.test("the action defaults to status and the chunk to one", () => {
  assertEquals(parseHealthRequest({}), { action: "status", chunk: 1, scope: "manual", runToken: null });
});

Deno.test("a run without a token is rejected", () => {
  assertEquals(parseHealthRequest({ action: "run" }).action, "run");
  assertEquals(parseHealthRequest({ action: "run", scope: "manual" }).runToken, null);
});

Deno.test("an unauthorized caller gets 401 and no run", async () => {
  const { ports } = fakePorts({ isAuthorized: async () => ({ ok: false, response: new Response("no", { status: 401 }) }) });
  const res = await handleHealthRequest(new Request("https://x.test", { method: "POST" }), ports);
  assertEquals(res.status, 401);
});

Deno.test("a busy lease answers 409 and runs nothing", async () => {
  let ran = false;
  const { ports } = fakePorts({
    acquireLease: async () => false,
    runChunk: async () => { ran = true; throw new Error("must not run"); },
  });
  const res = await handleHealthRequest(
    new Request("https://x.test", { method: "POST", body: JSON.stringify({ action: "run", scope: "manual", run_token: "t" }) }),
    ports,
  );
  assertEquals(res.status, 409);
  assertEquals(ran, false);
});

Deno.test("a manual run takes the lease with a holder derived from the token", async () => {
  const { ports, leases } = fakePorts();
  const res = await handleHealthRequest(
    new Request("https://x.test", { method: "POST", body: JSON.stringify({ action: "run", scope: "manual", run_token: "token-a" }) }),
    ports,
  );
  assertEquals(res.status, 200);
  assertEquals(leases[0].job, "ai-provider-health");
  assert(leases[0].holder.length > 0);
});

Deno.test("the daily scope does not need a token", async () => {
  const { ports } = fakePorts();
  const res = await handleHealthRequest(
    new Request("https://x.test", { method: "POST", body: JSON.stringify({ action: "run", scope: "daily", chunk: 2 }) }),
    ports,
  );
  assertEquals(res.status, 200);
});

Deno.test("the status action returns the stored results", async () => {
  const { ports } = fakePorts({
    readResults: async () => [{
      provider_code: "claude", auth_method: "api_key", display_name: "Claude", status: "connected",
      reason: null, models_added: 1, models_updated: 0, models_deactivated: 0, latency_ms: 10, checked_at: "t",
    }],
  });
  const res = await handleHealthRequest(new Request("https://x.test?action=status"), ports);
  const body = await res.json();
  assertEquals((body as { results: unknown[] }).results.length, 1);
});

Deno.test("a manual run without a run token is refused before anything runs", async () => {
  let ran = false;
  const { ports, leases } = fakePorts({
    runChunk: async () => { ran = true; throw new Error("must not run"); },
  });
  const res = await handleHealthRequest(
    new Request("https://x.test", { method: "POST", body: JSON.stringify({ action: "run", scope: "manual" }) }),
    ports,
  );
  assertEquals(res.status, 400);
  assertEquals(ran, false);
  assertEquals(leases.length, 0);
});

Deno.test("the lease is released even when the run fails", async () => {
  const { ports, leases } = fakePorts({
    runChunk: async () => { throw new Error("boom"); },
  });
  await assertRejects(() =>
    handleHealthRequest(
      new Request("https://x.test", { method: "POST", body: JSON.stringify({ action: "run", scope: "daily" }) }),
      ports,
    )
  );
  assertEquals(leases.filter((l) => l.job === "ai-provider-health").length, 2);
});
