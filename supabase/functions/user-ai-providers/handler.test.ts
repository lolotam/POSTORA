import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type AdminClient,
  createRateLimiter,
  type DbResult,
  type Dependencies,
  handleRequest,
  type Query,
} from "./handler.ts";
import { PROVIDERS } from "./validation.ts";

type Row = Record<string, unknown>;
type Call = { name: string; args: unknown[] };
const key = "user-private-key-1234";
// Fakes stop at the auth, fetch, and database boundaries. SQL grants and actual
// Vault transactions are covered by the separately owned migration harness.
const timestamp = Date.UTC(2026, 8, 6);

Deno.test("database failures never masquerade as missing keys or successful writes", async () => {
  const cases: { action: string; results: DbResult[] }[] = [
    { action: "list", results: [failed()] },
    { action: "save_key", results: [failed()] },
    // Malformed or foreign rows from the RPC are never reported as a saved key.
    { action: "save_key", results: [ok(null)] },
    { action: "save_key", results: [ok([])] },
    { action: "save_key", results: [ok([stored("x", "claude")])] },
    { action: "test_key", results: [failed()] },
    { action: "test_key", results: [ok(stored()), failed()] },
    { action: "test_key", results: [ok(stored()), ok(key), failed()] },
    { action: "delete_key", results: [failed()] },
    { action: "delete_key", results: [ok("yes")] },
    { action: "join_waitlist", results: [failed()] },
  ];
  for (const scenario of cases) {
    const f = fixture(scenario.results);
    const result = await f.run({
      action: scenario.action,
      provider_code: scenario.action === "join_waitlist" ? "codex" : "openai",
      api_key: key,
    });
    assertEquals(result, {
      status: 500,
      body: { ok: false, code: "STORE_FAILED" },
    });
    assertEquals(f.remaining(), 0);
    assert(!JSON.stringify([result, f.logs]).includes(key));
  }
});

Deno.test("delete reports a missing row as 404 through the locked RPC", async () => {
  const missing = fixture([ok(false)]);
  assertEquals(
    (await missing.run({ action: "delete_key", provider_code: "openai" }))
      .status,
    404,
  );
  assertEquals(missing.fetchCount(), 0);
});

Deno.test("test_key has its own ten-attempt limit without consuming save attempts", async () => {
  const f = fixture(Array.from({ length: 10 }, () => ok(null)), 401);
  for (let i = 0; i < 10; i++) {
    assertEquals(
      (await f.run({ action: "test_key", provider_code: "openai" })).status,
      404,
    );
  }
  assertEquals(
    (await f.run({ action: "test_key", provider_code: "openai" })).body.code,
    "RATE_LIMITED",
  );
  assertEquals(
    (await f.run({ action: "save_key", provider_code: "openai", api_key: key }))
      .status,
    400,
  );
});
const stored = (id = "new-secret", provider = "openai") => ({
  id: "row-id",
  provider_code: provider,
  credentials_secret_id: id,
  key_hint: "1234",
  status: "active",
  last_verified_at: new Date(timestamp).toISOString(),
  updated_at: "updated",
});
const ok = (data: unknown = null): DbResult => ({ data, error: null });
const failed = (): DbResult => ({ data: null, error: { message: key } });

function fixture(results: DbResult[] = [], status = 200) {
  const calls: Call[] = [];
  const logs: unknown[] = [];
  const responses = [...results];
  let fetchCount = 0;
  const next = () => {
    assert(responses.length > 0, "Unexpected database operation");
    return Promise.resolve(responses.shift()!);
  };
  const query: Query = {
    select: (columns) => {
      calls.push({ name: "select", args: [columns] });
      return query;
    },
    eq: (column, value) => {
      calls.push({ name: "eq", args: [column, value] });
      return query;
    },
    in: (column, values) => {
      calls.push({ name: "in", args: [column, values] });
      return query;
    },
    contains: (column, values) => {
      calls.push({ name: "contains", args: [column, values] });
      return query;
    },
    upsert: (values, options) => {
      calls.push({ name: "upsert", args: [values, options] });
      return query;
    },
    update: (values) => {
      calls.push({ name: "update", args: [values] });
      return query;
    },
    delete: () => {
      calls.push({ name: "delete", args: [] });
      return query;
    },
    maybeSingle: next,
    then: (resolve, reject) => next().then(resolve, reject),
  };
  const admin: AdminClient = {
    from: (table) => {
      calls.push({ name: "from", args: [table] });
      return query;
    },
    rpc: (name, params) => {
      calls.push({ name, args: [params] });
      return next();
    },
  };
  const deps: Dependencies = {
    admin,
    serviceRoleKey: "service-role",
    anonClient: (authorization) => {
      assertEquals(authorization, "Bearer user-token");
      return {
        auth: {
          getUser: () =>
            Promise.resolve({
              data: { user: { id: "verified-user" } },
              error: null,
            }),
        },
      };
    },
    fetch: () => {
      fetchCount++;
      return Promise.resolve(new Response(null, { status }));
    },
    now: () => timestamp,
    rateLimit: createRateLimiter(),
    log: (event) => logs.push(event),
  };
  const run = (body: Row, token = "user-token", method = "POST") =>
    handleRequest(
      new Request("https://example.test", {
        method,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }),
      deps,
      () => Promise.resolve(body),
    );
  return {
    deps,
    calls,
    logs,
    run,
    fetchCount: () => fetchCount,
    remaining: () => responses.length,
  };
}
for (const provider of PROVIDERS) {
  Deno.test(`save ${provider} stores through the transactional RPC under the verified owner and returns only status`, async () => {
    const f = fixture([ok([stored("secret-id", provider)])]);
    const result = await f.run({
      action: "save_key",
      provider_code: provider,
      api_key: `  ${key}  `,
      user_id: "attacker",
    });
    assertEquals(result.status, 200);
    assertEquals(result.body.data, {
      provider_code: provider,
      key_hint: "1234",
      status: "active",
      last_verified_at: new Date(timestamp).toISOString(),
    });
    assertEquals(
      f.calls.find((c) => c.name === "save_user_ai_provider_key")?.args,
      [{
        p_user_id: "verified-user",
        p_provider_code: provider,
        p_api_key: key,
        p_key_hint: "1234",
        p_verified_at: new Date(timestamp).toISOString(),
      }],
    );
    assert(!JSON.stringify(result).includes(key));
    assert(!JSON.stringify(result).includes("secret-id"));
    assert(!JSON.stringify(result).includes("credentials_secret_id"));
    assert(!JSON.stringify(f.logs).includes(key));
    assertEquals(f.logs.length, 1);
    assertEquals(f.remaining(), 0);
  });
}

for (
  const [status, expectedStatus, code] of [[401, 400, "AI_USER_KEY_INVALID"], [
    429,
    503,
    "AI_PROVIDER_UNREACHABLE",
  ], [503, 503, "AI_PROVIDER_UNREACHABLE"]] as const
) {
  Deno.test(`save provider ${status} leaves all stored state untouched`, async () => {
    const f = fixture([], status);
    const result = await f.run({
      action: "save_key",
      provider_code: "openai",
      api_key: key,
    });
    assertEquals(result, { status: expectedStatus, body: { ok: false, code } });
    assertEquals(f.calls, []);
  });
}
Deno.test("save network error stores nothing and never exposes exception secrets", async () => {
  const f = fixture();
  f.deps.fetch = () => Promise.reject(new Error(key));
  const result = await f.run({
    action: "save_key",
    provider_code: "gemini",
    api_key: key,
  });
  assertEquals(result.status, 503);
  assertEquals(result.body.code, "AI_PROVIDER_UNREACHABLE");
  assertEquals(f.calls, []);
  assert(!JSON.stringify([result, f.logs]).includes(key));
});

Deno.test("save is one transactional RPC and nothing else touches the database", async () => {
  const f = fixture([ok([stored("any", "claude")])]);
  const result = await f.run({
    action: "save_key",
    provider_code: "claude",
    api_key: key,
  });
  assertEquals(result.status, 200);
  const dbCalls = f.calls.filter((c) => c.name !== "eq");
  assertEquals(dbCalls.map((c) => c.name), ["save_user_ai_provider_key"]);
  assertEquals(f.remaining(), 0);
});
for (const status of [200, 401, 429, 503]) {
  Deno.test(`test_key provider ${status} heals, invalidates, or preserves the row`, async () => {
    const transient = status === 429 || status === 503;
    const after = status === 200 ? stored() : { ...stored(), status: "invalid" };
    const f = fixture([ok(stored()), ok(key), ...transient ? [] : [ok(), ok(after)]], status);
    const result = await f.run({
      action: "test_key",
      provider_code: "openai",
      user_id: "attacker",
    });
    assertEquals(result.status, transient ? 503 : status === 200 ? 200 : 400);
    assertEquals(f.calls.find((c) => c.name === "get_user_ai_provider_key")?.args, [{
      p_user_id: "verified-user",
      p_provider_code: "openai",
      p_include_invalid: true,
    }]);
    const update = f.calls.find((c) => c.name === "update");
    assertEquals(
      update?.args[0],
      transient ? undefined : status === 200
        ? {
          status: "active",
          last_verified_at: new Date(timestamp).toISOString(),
          last_error_code: null,
        }
        : { status: "invalid", last_error_code: "AI_USER_KEY_INVALID" },
    );
    if (!transient) {
      // The status write is conditioned on the row version read before the provider call.
      assert(f.calls.some((c) => c.name === "eq" && c.args[0] === "updated_at" && c.args[1] === "updated"));
    }
    assert(!JSON.stringify([result, f.logs]).includes(key));
    assertEquals(f.remaining(), 0);
  });
}
Deno.test("a stale test result never overwrites a key replaced during the provider call", async () => {
  const replaced = { ...stored(), key_hint: "9999", status: "active", updated_at: "later" };
  const f = fixture([ok(stored()), ok(key), ok(), ok(replaced)], 401);
  const result = await f.run({ action: "test_key", provider_code: "openai" });
  assertEquals(result.status, 200);
  assertEquals((result.body.data as Row).key_hint, "9999");
  assert(f.calls.some((c) => c.name === "eq" && c.args[0] === "updated_at" && c.args[1] === "updated"));
});
Deno.test("missing test key returns connection required", async () => {
  const f = fixture([ok(null)]);
  assertEquals(await f.run({ action: "test_key", provider_code: "openai" }), {
    status: 404,
    body: { ok: false, code: "AI_CONNECTION_REQUIRED" },
  });
  assertEquals(f.fetchCount(), 0);
});

Deno.test("delete runs through the locked RPC under the verified owner and touches nothing else", async () => {
  const f = fixture([ok(true)]);
  assertEquals(
    (await f.run({ action: "delete_key", provider_code: "openai", user_id: "attacker" })).body,
    { ok: true },
  );
  assertEquals(f.calls.map((c) => c.name), ["delete_user_ai_provider_key"]);
  assertEquals(f.calls[0].args, [{ p_user_id: "verified-user", p_provider_code: "openai" }]);
  assertEquals(f.remaining(), 0);
});
Deno.test("waitlist duplicates use ignoreDuplicates and reject non-Codex providers", async () => {
  const f = fixture([ok(), ok()]);
  for (let i = 0; i < 2; i++) {
    assertEquals(
      (await f.run({ action: "join_waitlist", provider_code: "codex" })).body,
      { ok: true, data: { joined: true } },
    );
  }
  for (const call of f.calls.filter((c) => c.name === "upsert")) {
    assertEquals(call.args, [{
      user_id: "verified-user",
      provider_code: "codex",
    }, { onConflict: "user_id,provider_code", ignoreDuplicates: true }]);
  }
  assertEquals(
    (await f.run({ action: "join_waitlist", provider_code: "openai" })).status,
    400,
  );
});
Deno.test("auth refuses missing, invalid and service-role tokens before parsing", async () => {
  for (
    const [token, status] of [["", 401], ["service-role", 403], [
      "user-token",
      401,
    ]] as const
  ) {
    const f = fixture();
    f.deps.anonClient = () => ({
      auth: {
        getUser: () =>
          Promise.resolve({ data: { user: null }, error: new Error(key) }),
      },
    });
    let parsed = false;
    const result = await handleRequest(
      new Request("https://example.test", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }),
      f.deps,
      () => {
        parsed = true;
        return Promise.resolve({});
      },
    );
    assertEquals(result.status, status);
    assertEquals(parsed, false);
    assertEquals(f.calls, []);
  }
});
Deno.test("eleventh save is limited and the window expires", async () => {
  const f = fixture([], 401);
  for (let i = 0; i < 10; i++) {
    assertEquals(
      (await f.run({
        action: "save_key",
        provider_code: "openai",
        api_key: key,
      })).status,
      400,
    );
  }
  assertEquals(
    (await f.run({ action: "save_key", provider_code: "openai", api_key: key }))
      .body.code,
    "RATE_LIMITED",
  );
  assertEquals(f.fetchCount(), 10);
  f.deps.now = () => timestamp + 600_000;
  assertEquals(
    (await f.run({ action: "save_key", provider_code: "openai", api_key: key }))
      .status,
    400,
  );
});
Deno.test("list projects safe columns from the base table under the verified owner", async () => {
  const f = fixture([ok([stored()])]);
  const result = await f.run({ action: "list", user_id: "attacker" });
  assertEquals(result.status, 200);
  assertEquals(f.calls, [
    { name: "from", args: ["user_ai_provider_keys"] },
    {
      name: "select",
      args: [
        "id, provider_code, key_hint, status, last_verified_at, updated_at",
      ],
    },
    { name: "eq", args: ["user_id", "verified-user"] },
  ]);
  assert(!JSON.stringify(result).includes("secret"));
});
Deno.test("invalid inputs and unknown actions fail before any provider or database call", async () => {
  const f = fixture();
  for (
    const body of [
      { action: key },
      { action: "save_key", provider_code: "codex", api_key: key },
      ...["", "  ", "x".repeat(513)].map((api_key) => ({
        action: "save_key",
        provider_code: "openai",
        api_key,
      })),
    ]
  ) {
    assertEquals((await f.run(body)).status, 400);
  }
  assertEquals(f.fetchCount(), 0);
  assertEquals(f.calls, []);
  assert(!JSON.stringify(f.logs).includes(key));
  assertEquals(
    (await f.run({ action: "list" }, "user-token", "GET")).status,
    405,
  );
});

Deno.test("list_models returns the active catalog for the four providers through the service role", async () => {
  const f = fixture([
    ok([
      { id: "m1", model_id: "gpt-x", name: "GPT X", ai_providers: { provider_code: "openai" } },
      { id: "m2", model_id: "claude-sonnet-5", name: "Claude Sonnet 5", ai_providers: { provider_code: "claude" } },
    ]),
  ]);
  const result = await f.run({ action: "list_models" });
  assertEquals(result.status, 200);
  assertEquals(result.body.data, {
    models: [
      { id: "m1", model_id: "gpt-x", name: "GPT X", provider_code: "openai" },
      { id: "m2", model_id: "claude-sonnet-5", name: "Claude Sonnet 5", provider_code: "claude" },
    ],
  });
  assertEquals(f.calls.find((c) => c.name === "from")?.args, ["ai_models"]);
  assertEquals(
    f.calls.find((c) => c.name === "in")?.args,
    ["ai_providers.provider_code", PROVIDERS],
  );
  assertEquals(f.calls.find((c) => c.name === "eq")?.args, ["is_active", true]);
  // Image, TTS and video rows must never reach the routing picker.
  assertEquals(f.calls.find((c) => c.name === "contains")?.args, ["capabilities", ["chat"]]);
  assertEquals(f.fetchCount(), 0);
});
Deno.test("list_models surfaces a failed catalog read instead of an empty list", async () => {
  const f = fixture([failed()]);
  const result = await f.run({ action: "list_models" });
  assertEquals(result, { status: 500, body: { ok: false, code: "STORE_FAILED" } });
});
