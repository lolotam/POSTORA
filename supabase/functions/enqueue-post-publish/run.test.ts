import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { type EnqueueDependencies, type KickPayload, run } from "./run.ts";
import { createDependencies, handleRequest } from "./index.ts";

const POST = "e3000000-0000-4000-8000-000000000001";
const OWNER = "e1000000-0000-4000-8000-000000000001";
const ACCOUNT = "e2000000-0000-4000-8000-000000000001";
const STAMP = "2026-11-06T11:00:00.123456+00:00";

function fixture(overrides: Partial<EnqueueDependencies> = {}) {
  const kicks: KickPayload[] = [];
  const logs: Record<string, unknown>[] = [];
  const calls: unknown[][] = [];
  const deps: EnqueueDependencies = {
    requestImmediatePublish: (postId, userId) => {
      calls.push(["publish_now", postId, userId]);
      return Promise.resolve(STAMP);
    },
    requestPostRetry: (postId, userId, accountIds) => {
      calls.push(["retry", postId, userId, accountIds]);
      return Promise.resolve({ status: "accepted", requested_at: STAMP, account_ids: [ACCOUNT], platforms: ["instagram"] });
    },
    readPostStatus: () => Promise.resolve("pending"),
    kick: (payload) => { kicks.push(payload); return Promise.resolve(); },
    logRefusal: (row) => { logs.push(row); return Promise.resolve(); },
    ...overrides,
  };
  return { deps, kicks, logs, calls };
}

Deno.test("publish_now accepts the owner RPC stamp verbatim and kicks once", async () => {
  const f = fixture();
  assertEquals(await run(f.deps, { callerId: OWNER, body: { post_id: POST, mode: "publish_now" } }), {
    status: 202, body: { accepted: true, post_id: POST, status: "processing" },
  });
  assertEquals(f.calls, [["publish_now", POST, OWNER]]);
  assertEquals(f.kicks, [{ post_id: POST, expected_publish_requested_at: STAMP }]);
  assertEquals(f.logs, []);
});

Deno.test("an already processing post is accepted without a second kick", async () => {
  const f = fixture({
    requestImmediatePublish: () => Promise.resolve(null),
    readPostStatus: (postId, userId) => {
      assertEquals([postId, userId], [POST, OWNER]);
      return Promise.resolve("processing");
    },
  });
  assertEquals(await run(f.deps, { callerId: OWNER, body: { post_id: POST, mode: "publish_now" } }), {
    status: 202, body: { accepted: true, post_id: POST, status: "processing", already: true },
  });
  assertEquals(f.kicks, []);
  assertEquals(f.logs.length, 1);
});

for (const [postStatus, status, reason] of [
  ["completed", 409, "not_publishable"],
  ["pending", 409, "not_publishable"],
  [null, 404, "not_found"],
] as const) {
  Deno.test(`publish_now refused RPC and status ${postStatus} returns ${status} and logs once`, async () => {
    const f = fixture({ requestImmediatePublish: () => Promise.resolve(null), readPostStatus: () => Promise.resolve(postStatus) });
    assertEquals(await run(f.deps, { callerId: OWNER, body: { post_id: POST, mode: "publish_now" } }), {
      status, body: { error: reason },
    });
    assertEquals(f.kicks, []);
    assertEquals(f.logs.length, 1);
    assertEquals(f.logs[0].message, reason);
  });
}

Deno.test("retry accepts the RPC stamp and sends only owner-scoped selected accounts to the RPC", async () => {
  const f = fixture();
  assertEquals(await run(f.deps, { callerId: OWNER, body: { post_id: POST, mode: "retry", account_ids: [ACCOUNT] } }), {
    status: 202, body: { accepted: true, post_id: POST, status: "processing" },
  });
  assertEquals(f.calls, [["retry", POST, OWNER, [ACCOUNT]]]);
  assertEquals(f.kicks, [{ post_id: POST, expected_publish_requested_at: STAMP }]);
  assertEquals(f.logs, []);
});

for (const reason of ["not_found", "not_retryable", "no_targets"] as const) {
  Deno.test(`retry refusal ${reason} maps to its HTTP status and logs once`, async () => {
    const f = fixture({ requestPostRetry: () => Promise.resolve({ status: "refused", reason }) });
    assertEquals(await run(f.deps, { callerId: OWNER, body: { post_id: POST, mode: "retry" } }), {
      status: reason === "not_found" ? 404 : 409, body: { error: reason },
    });
    assertEquals(f.kicks, []);
    assertEquals(f.logs.length, 1);
  });
}

Deno.test("a rejected kick leaves the durable request accepted and records a sanitized warning", async () => {
  const f = fixture({ kick: () => Promise.reject(new Error('permission denied for table "posts"')) });
  assertEquals(await run(f.deps, { callerId: OWNER, body: { post_id: POST, mode: "publish_now" } }), {
    status: 202, body: { accepted: true, post_id: POST, status: "processing" },
  });
  assertEquals(f.logs.length, 1);
  assertEquals(f.logs[0].message, "publish_kick_failed");
  assertEquals(JSON.stringify(f.logs).includes("permission denied"), false);
});

Deno.test("invalid enqueue bodies refuse before any RPC and log once", async () => {
  for (const body of [
    { post_id: POST, mode: "publish_now", account_ids: [ACCOUNT] },
    { post_id: POST, mode: "retry", account_ids: [] },
    { post_id: POST, mode: "retry", account_ids: Array(51).fill(ACCOUNT) },
    { post_id: POST, mode: "retry", user_id: OWNER },
    { post_id: POST, mode: "retry", platforms: ["instagram"] },
    { post_id: "invalid", mode: "publish_now" },
  ]) {
    const f = fixture();
    assertEquals((await run(f.deps, { callerId: OWNER, body })).status, 400);
    assertEquals(f.calls, []);
    assertEquals(f.kicks, []);
    assertEquals(f.logs.length, 1);
  }
});

Deno.test("an unreadable owner status is a sanitized failure, never a missing post", async () => {
  const f = fixture({
    requestImmediatePublish: () => Promise.resolve(null),
    readPostStatus: () => Promise.reject(new Error('permission denied for table "posts"')),
  });
  const response = await run(f.deps, { callerId: OWNER, body: { post_id: POST, mode: "publish_now" } });
  assertEquals(response.status, 500);
  assertEquals(JSON.stringify(response).includes("permission denied"), false);
  assertEquals(f.kicks, []);
  assertEquals(f.logs.length, 1);
});

Deno.test("HTTP refusals are logged once and use restricted CORS without reaching an RPC", async () => {
  for (const [method, body, authFails, status] of [
    ["GET", undefined, false, 405],
    ["POST", "{}", true, 401],
    ["POST", "not-json", false, 400],
    ["POST", JSON.stringify({ post_id: POST, mode: "publish_now", account_ids: [ACCOUNT] }), false, 400],
  ] as const) {
    const f = fixture();
    const response = await handleRequest(new Request("https://fixture.invalid", {
      method, body, headers: { Origin: "https://postora.cloud" },
    }), () => ({ ...f.deps, authenticate: () => authFails
      ? Promise.reject(new Error("private auth details")) : Promise.resolve({ userId: OWNER }) }));
    assertEquals(response.status, status);
    assertEquals(response.headers.get("Access-Control-Allow-Origin"), "https://postora.cloud");
    assertEquals((await response.text()).includes("private"), false);
    assertEquals(f.logs.length, 1);
    assertEquals(f.calls, []);
  }
  const preflight = await handleRequest(new Request("https://fixture.invalid", {
    method: "OPTIONS", headers: { Origin: "https://untrusted.invalid" },
  }), () => { throw new Error("Preflight must not construct privileged dependencies"); });
  assertEquals(preflight.status, 204);
  assertEquals(preflight.headers.get("Access-Control-Allow-Origin"), null);
});

Deno.test("the real adapter scopes the fallback read by owner and rejects malformed RPC acceptance", async () => {
  const oldFetch = globalThis.fetch;
  const oldUrl = Deno.env.get("SUPABASE_URL");
  const oldKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  Deno.env.set("SUPABASE_URL", "https://enqueue-fixture.invalid");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "fixture-service");
  const logs: unknown[] = [];
  let rpcBody: unknown = null;
  let missing = true;
  let kicks = 0;
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    assertEquals(url.origin, "https://enqueue-fixture.invalid");
    if (url.pathname === "/rest/v1/rpc/request_immediate_publish") {
      assertEquals(await req.json(), { p_post_id: POST, p_user_id: OWNER });
      return Response.json(rpcBody);
    }
    if (url.pathname === "/rest/v1/posts") {
      assertEquals(url.searchParams.get("id"), `eq.${POST}`);
      assertEquals(url.searchParams.get("user_id"), `eq.${OWNER}`);
      return missing ? Response.json(null) : Response.json({ message: "db unavailable" }, { status: 500 });
    }
    if (url.pathname === "/rest/v1/system_logs") {
      logs.push(await req.json());
      return new Response(null, { status: 201 });
    }
    kicks++;
    return new Response(null, { status: 200 });
  };
  try {
    const deps = createDependencies();
    const execute = () => run(deps, { callerId: OWNER, body: { post_id: POST, mode: "publish_now" } });
    assertEquals(await execute(), { status: 404, body: { error: "not_found" } });
    missing = false;
    assertEquals((await execute()).status, 500);
    rpcBody = { unexpected: "not a timestamp" };
    assertEquals((await execute()).status, 500);
    assertEquals(kicks, 0);
    assertEquals(logs.length, 3);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldUrl === undefined) Deno.env.delete("SUPABASE_URL"); else Deno.env.set("SUPABASE_URL", oldUrl);
    if (oldKey === undefined) Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY"); else Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", oldKey);
  }
});

Deno.test("background kicks return 202 before completion, drain responses, and log only unexpected outcomes", async () => {
  const oldFetch = globalThis.fetch;
  const oldUrl = Deno.env.get("SUPABASE_URL");
  const oldKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const runtime = globalThis as typeof globalThis & { EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void } };
  const oldRuntime = runtime.EdgeRuntime;
  const pending: Promise<unknown>[] = [];
  runtime.EdgeRuntime = { waitUntil: (promise) => pending.push(promise) };
  Deno.env.set("SUPABASE_URL", "https://enqueue-fixture.invalid");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "fixture-service");
  try {
    for (const outcome of [200, 409, 503, 500, "network"] as const) {
      const logs: Record<string, unknown>[] = [];
      let finish!: () => void;
      const blocked = new Promise<void>((resolve) => { finish = resolve; });
      let drained = false;
      globalThis.fetch = async (input, init) => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        assertEquals(url.origin, "https://enqueue-fixture.invalid");
        if (url.pathname === "/rest/v1/rpc/request_immediate_publish") return Response.json(STAMP);
        if (url.pathname === "/rest/v1/system_logs") {
          logs.push(await req.json());
          return new Response(null, { status: 201 });
        }
        assertEquals(url.pathname, "/functions/v1/process-post");
        assertEquals(req.headers.get("Authorization"), "Bearer fixture-service");
        assertEquals(await req.json(), { post_id: POST, expected_publish_requested_at: STAMP });
        await blocked;
        if (outcome === "network") throw new Error("credential-like private detail");
        const response = new Response("private body", { status: outcome });
        const read = response.text.bind(response);
        response.text = async () => { const body = await read(); drained = true; return body; };
        return response;
      };
      const response = await run(createDependencies(), { callerId: OWNER, body: { post_id: POST, mode: "publish_now" } });
      assertEquals(response.status, 202);
      assertEquals(drained, false);
      finish();
      await Promise.all(pending.splice(0));
      assertEquals(drained, outcome !== "network");
      assertEquals(logs.length, outcome === 500 || outcome === "network" ? 1 : 0);
      if (logs.length) {
        assertEquals(logs[0].message, "publish_kick_failed");
        assertEquals(logs[0].metadata, { post_id: POST, status: outcome === "network" ? null : outcome });
        assertEquals(JSON.stringify(logs).includes("private"), false);
      }
    }
  } finally {
    globalThis.fetch = oldFetch;
    if (oldRuntime === undefined) delete runtime.EdgeRuntime; else runtime.EdgeRuntime = oldRuntime;
    if (oldUrl === undefined) Deno.env.delete("SUPABASE_URL"); else Deno.env.set("SUPABASE_URL", oldUrl);
    if (oldKey === undefined) Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY"); else Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", oldKey);
  }
});
