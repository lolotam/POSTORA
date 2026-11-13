// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { handleHealthRequest, parseHealthRequest, type HealthHandlerPorts } from "./handler.ts";

for (const admission of ['busy', 'cooldown', 'complete'] as const) {
  Deno.test(`logical run admission ${admission} never probes providers`, async () => {
    let ran = false;
    const { ports, leases } = fakePorts({ admitRun: async () => admission,
      runChunk: async () => { ran = true; throw new Error('must not run'); } });
    const res = await handleHealthRequest(new Request('https://x.test', { method: 'POST',
      body: JSON.stringify({ action: 'run', run_token: '12000000-0000-4000-8000-000000000001' }) }), ports);
    assertEquals(res.status, admission === 'busy' ? 409 : admission === 'cooldown' ? 429 : 200);
    assertEquals(ran, false);
    assertEquals(leases.length, 2);
  });
}

function fakePorts(overrides: Partial<HealthHandlerPorts> = {}) {
  const leases: Array<{ job: string; holder: string }> = [];
  const ports: HealthHandlerPorts = {
    runChunk: async (chunk) => ({
      run_id: "run-1", chunk, done: true, next_chunk: null, results: [], skipped: [],
      summary: { total: 0, connected: 0, failed: 0, needs_relogin: 0 },
    }),
    readResults: async () => [],
    admitRun: async () => "ready",
    completeRun: async () => {},
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

Deno.test("a run body without a token parses to a run with no token", () => {
  assertEquals(parseHealthRequest({ action: "run" }).action, "run");
  assertEquals(parseHealthRequest({ action: "run", scope: "manual" }).runToken, null);
});

Deno.test("a body that says something else falls back to the defaults", () => {
  assertEquals(parseHealthRequest({ action: "delete", chunk: "x", scope: "other", run_token: 7 }), {
    action: "status",
    chunk: 1,
    scope: "manual",
    runToken: null,
  });
  assertEquals(parseHealthRequest("not an object").action, "status");
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
    new Request("https://x.test", { method: "POST", body: JSON.stringify({ action: "run", scope: "manual", run_token: "12000000-0000-4000-8000-000000000001" }) }),
    ports,
  );
  assertEquals(res.status, 409);
  assertEquals(ran, false);
});

Deno.test("a manual run takes and releases the shared lease", async () => {
  const { ports, leases } = fakePorts();
  const res = await handleHealthRequest(
    new Request("https://x.test", { method: "POST", body: JSON.stringify({ action: "run", scope: "manual", run_token: "12000000-0000-4000-8000-000000000001" }) }),
    ports,
  );
  assertEquals(res.status, 200);
  assertEquals(leases[0].job, "ai-provider-health");
  assert(leases[0].holder.length > 0);
  assertEquals(leases[0].holder, leases[1].holder);
});

Deno.test("overlapping requests for the same run cannot renew each other's lease", async () => {
  let holder: string | null = null;
  let releaseRun!: () => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseRun = resolve; });
  const { ports } = fakePorts({
    acquireLease: async (_job, requested) => {
      if (holder && holder !== requested) return false;
      holder = requested;
      return true;
    },
    runChunk: async (chunk, runId) => {
      started();
      await blocked;
      return { run_id: runId, chunk, done: true, next_chunk: null, results: [], skipped: [],
        summary: { total: 0, connected: 0, failed: 0, needs_relogin: 0 } };
    },
  });
  const request = () => new Request("https://x.test", {
    method: "POST", body: JSON.stringify({ action: "run", scope: "daily" }),
  });
  const first = handleHealthRequest(request(), ports);
  await running;
  const retry = await handleHealthRequest(request(), ports);
  releaseRun();
  assertEquals((await first).status, 200);
  assertEquals(retry.status, 409);
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

Deno.test("a failing run answers 500 without leaking the reason, and the lease is released", async () => {
  const { ports, leases } = fakePorts({
    runChunk: async () => { throw new Error("the database password is wrong"); },
  });
  const res = await handleHealthRequest(
    new Request("https://x.test", { method: "POST", body: JSON.stringify({ action: "run", scope: "daily" }) }),
    ports,
  );
  // The failure does not escape: the caller gets a status, not a stack trace.
  assertEquals(res.status, 500);
  const body = await res.text();
  assert(!body.includes("the database password is wrong"));
  // The lease is released even though the run failed.
  assertEquals(leases.filter((l) => l.job === "ai-provider-health").length, 2);
});

Deno.test("a release that fails does not replace the answer", async () => {
  const { ports } = fakePorts({
    releaseLease: async () => { throw new Error("the lease table is gone"); },
  });
  const res = await handleHealthRequest(
    new Request("https://x.test", { method: "POST", body: JSON.stringify({ action: "run", scope: "daily" }) }),
    ports,
  );
  assertEquals(res.status, 200);
});

Deno.test("manual run rejects a non-UUID token before taking a lease", async () => {
  const { ports, leases } = fakePorts();
  const res = await handleHealthRequest(new Request("https://x.test", { method: "POST",
    body: JSON.stringify({ action: "run", run_token: "token-a" }) }), ports);
  assertEquals(res.status, 400);
  assertEquals(leases.length, 0);
});
