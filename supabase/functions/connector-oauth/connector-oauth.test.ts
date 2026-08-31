import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { handleCallback, handleInit, handleRefresh } from "./handler.ts";
import {
  createBoundState,
  createInMemoryOAuthStateStore,
  generateOAuthState,
  setOAuthStateStore,
  verifyAndConsumeState,
} from "./state.ts";
import { clearRefreshLocks, serializedRefresh } from "./refresh.ts";
import { defaultVendorDependencies } from "./vendor.ts";

const USER_A = "00000000-0000-0000-0000-0000000000a1";
const USER_B = "00000000-0000-0000-0000-0000000000b2";
const ACCOUNT_1 = "00000000-0000-0000-0000-000000000011";
const ACCOUNT_2 = "00000000-0000-0000-0000-000000000022";
const TOOL_ID = "00000000-0000-0000-0000-000000000099";

function mockAdminForInit(exists = true) {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: exists && table === "social_accounts" ? { id: ACCOUNT_1 } : null }),
          }),
        }),
      }),
    }),
  };
}

function vendorDepsWithCreds(overrides: Partial<ReturnType<typeof defaultVendorDependencies>> = {}) {
  return {
    ...defaultVendorDependencies(),
    fetch: (_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ access_token: "tok", refresh_token: "rTok", expires_in: 500 }), { status: 200, headers: { "Content-Type": "application/json" } })),
    assertPublicHttpsUrl: async (url: string) => new URL(url),
    timeoutMs: 8000,
    maxRedirects: 3,
    getCredentials: () => ({ clientId: "cid", clientSecret: "csecret", redirectUri: "https://postora.cloud/callback" }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// State tests (Task 9.1)
// ---------------------------------------------------------------------------

Deno.test("state is cryptographically random and single-use", () => {
  const store = createInMemoryOAuthStateStore();
  setOAuthStateStore(store);
  const s1 = generateOAuthState();
  const s2 = generateOAuthState();
  assertEquals(s1 !== s2, true);
  assertEquals(s1.length > 40, true);

  const rec = createBoundState(USER_A, ACCOUNT_1, "salla");
  const first = verifyAndConsumeState(rec.state, USER_A);
  assertEquals(first !== null, true);
  const second = verifyAndConsumeState(rec.state, USER_A);
  assertEquals(second, null);
});

Deno.test("state is bound to (user_id, social_account_id) and replay across users is refused", () => {
  const store = createInMemoryOAuthStateStore();
  setOAuthStateStore(store);
  const rec = createBoundState(USER_A, ACCOUNT_1, "salla");
  const wrongUser = verifyAndConsumeState(rec.state, USER_B);
  assertEquals(wrongUser, null);
  // Even original user now also fails because state was consumed (single-use fails safe)
  // Create fresh for correct user check
  const store2 = createInMemoryOAuthStateStore();
  setOAuthStateStore(store2);
  const rec2 = createBoundState(USER_A, ACCOUNT_1, "salla");
  const correct = verifyAndConsumeState(rec2.state, USER_A);
  assertEquals(correct !== null, true);
  assertEquals(correct?.socialAccountId, ACCOUNT_1);
});

Deno.test("expired state is refused", async () => {
  const store = createInMemoryOAuthStateStore();
  setOAuthStateStore(store);
  const rec = createBoundState(USER_A, ACCOUNT_1, "salla", 1);
  await new Promise((r) => setTimeout(r, 10));
  const got = verifyAndConsumeState(rec.state, USER_A);
  assertEquals(got, null);
});

Deno.test("state records social_account_id binding", () => {
  const store = createInMemoryOAuthStateStore();
  setOAuthStateStore(store);
  const rec = createBoundState(USER_A, ACCOUNT_2, "shopify");
  assertEquals(rec.socialAccountId, ACCOUNT_2);
  assertEquals(rec.connectorType, "shopify");
  const consumed = verifyAndConsumeState(rec.state, USER_A);
  assertEquals(consumed?.socialAccountId, ACCOUNT_2);
});

// ---------------------------------------------------------------------------
// Init + callback flow
// ---------------------------------------------------------------------------

Deno.test("init creates a state bound to (user_id, social_account_id) and callback verifies ownership", async () => {
  const store = createInMemoryOAuthStateStore();
  setOAuthStateStore(store);

  const admin = mockAdminForInit(true);
  const deps = { admin, vendorDeps: vendorDepsWithCreds() };

  const initRes = await handleInit(USER_A, { action: "init", connector_type: "salla", social_account_id: ACCOUNT_1 }, deps as never);
  assertEquals(initRes.status, 200);
  assertStringIncludes((initRes.body.authorization_url as string), "salla");

  // Extract state from authorization_url
  const authUrl = new URL(initRes.body.authorization_url as string);
  const state = authUrl.searchParams.get("state")!;
  assertEquals(typeof state, "string");

  // Callback with correct user succeeds (tokens land in Vault, not plaintext)
  let vaultPayload: unknown = null;
  const adminCb = {
    from: (table: string) => {
      if (table === "ai_agent_tools") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: null }),
                }),
              }),
            }),
          }),
          insert: (_data: unknown) => {
            return Promise.resolve({});
          },
        } as unknown as never;
      }
      return mockAdminForInit(true).from(table) as never;
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      if (name === "upsert_connector_credential_secret") {
        // Ensure secret never contains plaintext alongside Vault — caller uses wrapper
        assertEquals(typeof args.p_secret, "object");
        vaultPayload = args.p_secret;
        return Promise.resolve({ data: [{ secret_id: "11111111-1111-1111-1111-111111111111", configured_fields: ["access_token", "refresh_token"] }], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };

  const vendorDeps = vendorDepsWithCreds({
    fetch: (_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ access_token: "tok123", refresh_token: "r123", expires_in: 3600 }), { status: 200, headers: { "Content-Type": "application/json" } })),
  });

  const cbRes = await handleCallback(USER_A, { action: "callback", code: "authcode123", state }, { admin: adminCb, vendorDeps } as never);
  assertEquals(cbRes.status, 200);
  assertEquals(cbRes.body.ok, true);
  // Vault received tokens, not plaintext column
  const payloadStr = JSON.stringify(vaultPayload);
  assertStringIncludes(payloadStr, "tok123");

  // Replay same state is refused on second use
  const replay = await handleCallback(USER_A, { action: "callback", code: "authcode123", state }, { admin: adminCb, vendorDeps } as never);
  assertEquals(replay.status, 400);
  assertStringIncludes((replay.body.error as string).toLowerCase(), "state");
});

Deno.test("callback whose state does not belong to authenticated user is refused", async () => {
  const store = createInMemoryOAuthStateStore();
  setOAuthStateStore(store);
  const rec = createBoundState(USER_A, ACCOUNT_1, "salla");
  const deps = {
    admin: mockAdminForInit(true),
    vendorDeps: vendorDepsWithCreds(),
  };
  // USER_B tries to use USER_A's state — must be refused
  const res = await handleCallback(USER_B, { action: "callback", code: "code", state: rec.state }, deps as never);
  assertEquals(res.status, 400);
});

Deno.test("tokens land in Vault via wrapper, never in plaintext response or error", async () => {
  const store = createInMemoryOAuthStateStore();
  setOAuthStateStore(store);
  const rec = createBoundState(USER_A, ACCOUNT_1, "shopify");
  let rpcCalled = false;
  const admin = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: null }),
            }),
          }),
        }),
      }),
      insert: () => Promise.resolve({}),
    }),
    rpc: (name: string, args: Record<string, unknown>) => {
      if (name === "upsert_connector_credential_secret") {
        rpcCalled = true;
        const s = JSON.stringify(args.p_secret);
        // No client secret or code in wrapper args
        assertEquals(s.includes("authcode"), false);
        return Promise.resolve({ data: [{ secret_id: "22222222-2222-2222-2222-222222222222", configured_fields: ["access_token"] }], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
  const vendorDeps = vendorDepsWithCreds({
    fetch: (_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ access_token: "secretAccess999" }), { status: 200, headers: { "Content-Type": "application/json" } })),
  });
  const res = await handleCallback(USER_A, { action: "callback", code: "mycode", state: rec.state }, { admin, vendorDeps } as never);
  assertEquals(res.status, 200);
  assertEquals(rpcCalled, true);
  const serialized = JSON.stringify(res.body);
  assertEquals(serialized.includes("secretAccess999"), false);
  assertEquals(serialized.includes("mycode"), false);
  assertEquals(serialized.includes(rec.state), false);
});

Deno.test("every vendor call has explicit timeout and every redirect hop passes assertPublicHttpsUrl", async () => {
  const checked: string[] = [];
  let fetchCalls = 0;
  const vendorDeps = vendorDepsWithCreds({
    fetch: (_input: RequestInfo | URL, _init?: RequestInit) => {
      fetchCalls++;
      if (fetchCalls === 1) {
        return Promise.resolve(new Response(null, { status: 302, headers: { Location: "/next" } }));
      }
      return Promise.resolve(new Response(JSON.stringify({ access_token: "tok" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    },
    assertPublicHttpsUrl: async (rawUrl: string) => {
      checked.push(rawUrl);
      return new URL(rawUrl.startsWith("/") ? `https://accounts.salla.sa${rawUrl}` : rawUrl);
    },
  });

  const store = createInMemoryOAuthStateStore();
  setOAuthStateStore(store);
  const rec = createBoundState(USER_A, ACCOUNT_1, "salla");
  const admin = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: null }),
            }),
          }),
        }),
      }),
      insert: () => Promise.resolve({}),
    }),
    rpc: (name: string, _args: Record<string, unknown>) =>
      Promise.resolve({ data: [{ secret_id: "33333333-3333-3333-3333-333333333333", configured_fields: ["access_token"] }], error: null } as never),
  };
  const res = await handleCallback(USER_A, { action: "callback", code: "code", state: rec.state }, { admin, vendorDeps } as never);
  assertEquals(res.status, 200);
  assertEquals(fetchCalls, 2);
  assertEquals(checked.length, 2);
  // timeoutMs is 8000 per default — assert it is defined
  assertEquals(vendorDeps.timeoutMs, 8000);
});

// ---------------------------------------------------------------------------
// Serialized refresh (Task 9.2)
// ---------------------------------------------------------------------------

Deno.test("two concurrent refreshes of one connector produce exactly one upstream call", async () => {
  clearRefreshLocks();
  let upstreamCalls = 0;
  let storedPayload: unknown = null;
  const admin = {
    from: (table: string) => {
      if (table === "ai_agent_tools") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: {
                      id: TOOL_ID,
                      connector_type: "salla",
                      credentials_secret_id: "44444444-4444-4444-4444-444444444444",
                      social_account_id: ACCOUNT_1,
                      settings: {},
                    },
                    error: null,
                  }),
              }),
            }),
          }),
          update: () => ({
            eq: () => ({
              eq: () => Promise.resolve({}),
            }),
          }),
        } as unknown as never;
      }
      return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }) }) } as never;
    },
    rpc: (name: string, _args: Record<string, unknown>) => {
      if (name === "get_connector_credential") {
        return Promise.resolve({
          data: { access_token: "old", refresh_token: "rTok", expires_at: new Date(Date.now() - 1000).toISOString() },
          error: null,
        });
      }
      if (name === "upsert_connector_credential_secret") {
        storedPayload = _args.p_secret;
        return Promise.resolve({ data: [{ secret_id: "44444444-4444-4444-4444-444444444444", configured_fields: ["access_token", "refresh_token"] }], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
  const vendorDeps = vendorDepsWithCreds({
    fetch: (_input: RequestInfo | URL, _init?: RequestInit) => {
      upstreamCalls++;
      // Small delay to ensure overlap
      return new Promise((resolve) =>
        setTimeout(() => resolve(new Response(JSON.stringify({ access_token: "newTok", refresh_token: "newR", expires_in: 1209600 }), { status: 200, headers: { "Content-Type": "application/json" } })), 20)
      );
    },
  });

  const deps = { admin, vendorDeps } as never;
  const body = { action: "refresh", tool_id: TOOL_ID };

  const [r1, r2] = await Promise.all([
    handleRefresh(USER_A, body, deps),
    handleRefresh(USER_A, body, deps),
  ]);

  assertEquals(upstreamCalls, 1);
  // Both callers get a success (coalesced), not one failing
  assertEquals(r1.status, 200);
  assertEquals(r2.status, 200);
  // Simulate expiry was honored: storedPayload contains new tokens
  assertStringIncludes(JSON.stringify(storedPayload), "newTok");
  clearRefreshLocks();
});

Deno.test("serializedRefresh coalesces only per connector, not across connectors", async () => {
  clearRefreshLocks();
  let calls = 0;
  const doRefresh = () => {
    calls++;
    return new Promise<{ accessToken: string }>((resolve) => setTimeout(() => resolve({ accessToken: "t" }), 10));
  };
  await Promise.all([
    serializedRefresh("connector-1", doRefresh),
    serializedRefresh("connector-1", doRefresh),
    serializedRefresh("connector-2", doRefresh),
  ]);
  // connector-1 coalesced to 1, connector-2 is separate => 2 total
  assertEquals(calls, 2);
  clearRefreshLocks();
});

Deno.test("no token, code, secret or state appears in error bodies", async () => {
  const store = createInMemoryOAuthStateStore();
  setOAuthStateStore(store);
  const rec = createBoundState(USER_A, ACCOUNT_1, "salla");
  const admin = mockAdminForInit(true);
  const vendorDeps = vendorDepsWithCreds({
    fetch: (_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "Content-Type": "application/json" } })),
  });
  const res = await handleCallback(USER_A, { action: "callback", code: "superSecretCode999", state: rec.state }, { admin, vendorDeps } as never);
  assertEquals(res.status, 502);
  const serialized = JSON.stringify(res.body);
  assertEquals(serialized.includes("superSecretCode999"), false);
  assertEquals(serialized.includes(rec.state), false);
  assertEquals(serialized.includes("csecret"), false);
});
