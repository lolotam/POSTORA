import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { AiOAuthError } from "./errors.ts";
import {
  defaultCredentialDeps,
  getFreshOAuthCredential,
  isReauthRefreshError,
  type CredentialDeps,
} from "./credentials.ts";
import { isAiProviderOAuthEnabled } from "./flag.ts";

interface MemRow {
  credentials: Record<string, unknown> | null;
  status: string;
  lockUntil: number | null;
  /** The current lease token; cleared by completion, failure and login saves. */
  leaseToken: string | null;
  /** The system_settings row the flag test reads, if any. */
  settingsRow?: unknown;
}

interface FakeResult {
  admin: {
    rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: null }>;
    from(table: string): unknown;
  };
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  row: MemRow;
}

/** In-memory rpc backing store so a second caller sees what the winner saved. */
function fakeAdmin(initial: Partial<MemRow> = {}, now: () => number = () => 0): FakeResult {
  const row: MemRow = { credentials: null, status: "connected", lockUntil: null, leaseToken: null, ...initial };
  let leases = 0;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const admin = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      const nowMs = now();
      switch (name) {
        case "get_ai_oauth_credentials": {
          if (row.credentials === null) return Promise.resolve({ data: null, error: null });
          return Promise.resolve({
            data: { ...row.credentials, status: row.status },
            error: null,
          });
        }
        case "claim_ai_oauth_refresh": {
          if (row.credentials !== null && (row.lockUntil === null || row.lockUntil < nowMs)) {
            row.lockUntil = nowMs + Number(args.p_lease_seconds) * 1000;
            row.leaseToken = `lease-${++leases}`;
            return Promise.resolve({ data: row.leaseToken, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        }
        case "complete_ai_oauth_refresh": {
          if (row.credentials === null || row.leaseToken !== args.p_lease_token) {
            return Promise.resolve({ data: false, error: null });
          }
          row.credentials = { ...(args.p_credentials as Record<string, unknown>) };
          row.status = "connected";
          row.lockUntil = null;
          row.leaseToken = null;
          return Promise.resolve({ data: true, error: null });
        }
        case "fail_ai_oauth_refresh": {
          if (row.leaseToken !== args.p_lease_token) return Promise.resolve({ data: false, error: null });
          row.lockUntil = null;
          row.leaseToken = null;
          if (args.p_reauth === true) row.status = "reauth_required";
          return Promise.resolve({ data: true, error: null });
        }
        default:
          return Promise.resolve({ data: null, error: null });
      }
    },
    from(table: string) {
      assertEquals(table, "system_settings");
      return {
        select() {
          return {
            eq(_column: string, _key: string) {
              return this;
            },
            maybeSingle: async () => ({ data: row.settingsRow ?? null, error: null }),
          };
        },
      };
    },
  };
  return { admin: admin as FakeResult["admin"], calls, row };
}

function testDeps(
  fake: FakeResult,
  overrides: Partial<Pick<CredentialDeps, "refresh" | "getApiKey" | "sleep">> = {},
): CredentialDeps {
  return {
    admin: fake.admin as never,
    refresh:
      overrides.refresh ??
      (async (_provider, refreshToken) => ({
        access: `fresh-access-for-${refreshToken}`,
        refresh: "rotated-refresh",
        expires: 10_000,
      })),
    getApiKey: overrides.getApiKey ?? ((_provider, creds) => `api-key-from-${creds.access}`),
    now: () => 5_000,
    sleep: overrides.sleep ?? (async () => {}),
  };
}

Deno.test("fresh credential returns api key without refresh", async () => {
  const fake = fakeAdmin({
    credentials: { access: "a", refresh: "r", expires: 605_000 }, // expires - 60s > now(5000)
  });
  let refreshCalls = 0;
  const deps = testDeps(fake, {
    refresh: async () => {
      refreshCalls++;
      throw new Error("must not refresh");
    },
  });

  const { apiKey } = await getFreshOAuthCredential(deps, "anthropic");
  assertEquals(apiKey, "api-key-from-a");
  assertEquals(refreshCalls, 0);
  assertEquals(fake.calls.filter((c) => c.name === "claim_ai_oauth_refresh").length, 0);
});

Deno.test("an openrouter credential is returned as is, with no refresh call", async () => {
  const fake = fakeAdmin({
    // OpenRouter's key is permanent: no refresh token, no expiry in sight.
    credentials: { access: "sk-or-v1-secret", refresh: "", expires: 8_640_000_000_000_000 },
  });
  let refreshCalls = 0;
  const deps: CredentialDeps = {
    ...defaultCredentialDeps(fake.admin as never),
    now: () => 5_000,
    sleep: async () => {},
    refresh: async () => {
      refreshCalls++;
      throw new Error("must not refresh");
    },
  };

  const { apiKey } = await getFreshOAuthCredential(deps, "openrouter");

  assertEquals(apiKey, "sk-or-v1-secret", "the stored key is the api key");
  assertEquals(refreshCalls, 0);
  assertEquals(fake.calls.filter((c) => c.name === "claim_ai_oauth_refresh").length, 0);
});

Deno.test("openrouter has no refresh path, so a refresh is refused instead of guessed", async () => {
  const deps = defaultCredentialDeps(fakeAdmin().admin as never);
  const error = await assertRejects(() => deps.refresh("openrouter", "any-token"), AiOAuthError);
  assertEquals(error.code, "oauth_unsupported_provider");
});

Deno.test("expired credential with lease won refreshes once and saves rotated refresh token", async () => {
  const fake = fakeAdmin({
    credentials: { access: "a", refresh: "old-refresh", expires: 5_000 }, // not fresh
  });
  const deps = testDeps(fake);

  const { apiKey } = await getFreshOAuthCredential(deps, "anthropic");

  assertEquals(apiKey, "api-key-from-fresh-access-for-old-refresh");
  assertEquals(fake.row.credentials?.refresh, "rotated-refresh");
  assertEquals(fake.row.lockUntil, null, "completion clears the lease");
  assertEquals(fake.row.leaseToken, null);
});

Deno.test("expired credential with lease lost waits and returns the token saved by the winner", async () => {
  const fake = fakeAdmin({
    credentials: { access: "a", refresh: "old-refresh", expires: 5_000 },
    lockUntil: 5_400, // winner holds the lease past now(5000)
  });
  const sleeps: Array<number> = [];
  let reads = 0;
  const deps = testDeps(fake, {
    refresh: async () => {
      throw new Error("the lease loser must not refresh");
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      reads++;
      if (reads >= 2) {
        // The winner completed its refresh while we waited.
        fake.row.credentials = { access: "winner-access", refresh: "winner-refresh", expires: 900_000 };
        fake.row.lockUntil = null;
      }
    },
  });

  const { apiKey } = await getFreshOAuthCredential(deps, "openai-codex");

  assertEquals(apiKey, "api-key-from-winner-access");
  assertEquals(sleeps.length, 2, "one wait per re-read before the winner's save appeared");
  assertEquals(
    fake.calls.filter((c) => c.name === "complete_ai_oauth_refresh").length,
    0,
  );
});

Deno.test("lease never released throws refresh_failed after 4 re-reads", async () => {
  const fake = fakeAdmin({
    credentials: { access: "a", refresh: "old-refresh", expires: 5_000 },
    lockUntil: 999_999, // never expires within the test's clock
  });
  const sleeps: Array<number> = [];
  const deps = testDeps(fake, { sleep: async (ms) => void sleeps.push(ms) });

  const error = await assertRejects(
    () => getFreshOAuthCredential(deps, "anthropic"),
    AiOAuthError,
  );
  assertEquals(error.code, "refresh_failed");
  assertEquals(sleeps.length, 4);
  assertEquals(sleeps, [750, 750, 750, 750]);
});

Deno.test("lease won after another worker rotated the token returns the saved token without refreshing", async () => {
  const fake = fakeAdmin({
    credentials: { access: "a", refresh: "spent-refresh", expires: 5_000 },
  });
  const rpc = fake.admin.rpc.bind(fake.admin);
  fake.admin.rpc = (name, args) => {
    if (name === "claim_ai_oauth_refresh") {
      // The previous lease holder saved its rotation between our read and our lease.
      fake.row.credentials = { access: "rotated-access", refresh: "next-refresh", expires: 900_000 };
    }
    return rpc(name, args);
  };
  const deps = testDeps(fake, {
    refresh: async () => {
      throw new Error("must not spend the already-rotated refresh token");
    },
  });

  const { apiKey } = await getFreshOAuthCredential(deps, "anthropic");

  assertEquals(apiKey, "api-key-from-rotated-access");
  assertEquals(fake.row.credentials?.refresh, "next-refresh");
});

Deno.test("refresh failure stores a fixed message, never the token endpoint body", async () => {
  const fake = fakeAdmin({
    credentials: { access: "a", refresh: "r", expires: 5_000 },
  });
  const deps = testDeps(fake, {
    refresh: async () => {
      throw new Error('status 503: {"echo":"sk-ant-ort01-secret"}');
    },
  });

  const error = await assertRejects(() => getFreshOAuthCredential(deps, "anthropic"), AiOAuthError);
  assertEquals(error.code, "refresh_failed");
  const fail = fake.calls.find((c) => c.name === "fail_ai_oauth_refresh");
  assert(fail !== undefined);
  assert(!String(fail.args.p_error).includes("sk-ant"), "stored error must not quote the response body");
  assert(!error.message.includes("sk-ant"), "thrown error must not quote the response body");
  assertEquals(fail.args.p_reauth, false);
});

Deno.test("refresh 400 marks reauth_required and throws reauth_required", async () => {
  const fake = fakeAdmin({
    credentials: { access: "a", refresh: "revoked", expires: 5_000 },
  });
  const deps = testDeps(fake, {
    refresh: async () => {
      throw new Error('HTTP request failed. status=400; url=https://x/token; body={"error":"invalid_grant"}');
    },
  });

  const error = await assertRejects(() => getFreshOAuthCredential(deps, "anthropic"), AiOAuthError);
  assertEquals(error.code, "reauth_required");
  const fail = fake.calls.find((c) => c.name === "fail_ai_oauth_refresh");
  assert(fail !== undefined);
  assertEquals(fail.args.p_reauth, true);
  assertEquals(fake.row.status, "reauth_required");
});

Deno.test("a 503 whose body quotes status=400 stays retryable and the next call refreshes", async () => {
  const fake = fakeAdmin({ credentials: { access: "a", refresh: "r", expires: 5_000 } });
  let attempts = 0;
  const deps = testDeps(fake, {
    refresh: async () => {
      if (++attempts === 1) {
        throw new Error(
          "Anthropic token refresh request failed. url=https://x/token; details=Error: HTTP request failed. status=503; url=https://x/token; body=retry: status=400; invalid_grant",
        );
      }
      return { access: "second-access", refresh: "rotated", expires: 900_000 };
    },
  });

  const first = await assertRejects(() => getFreshOAuthCredential(deps, "anthropic"), AiOAuthError);
  assertEquals(first.code, "refresh_failed");
  assertEquals(fake.row.status, "connected");

  assertEquals(await getFreshOAuthCredential(deps, "anthropic"), { apiKey: "api-key-from-second-access" });
});

Deno.test("a revoked refresh whose lease was replaced meanwhile is not reported as reauth_required", async () => {
  const fake = fakeAdmin({ credentials: { access: "a", refresh: "revoked", expires: 5_000 } });
  const deps = testDeps(fake, {
    refresh: async () => {
      fake.row.leaseToken = null; // admin reconnected while the provider answered
      throw new Error('HTTP request failed. status=400; url=https://x/token; body={"error":"invalid_grant"}');
    },
  });

  const error = await assertRejects(() => getFreshOAuthCredential(deps, "anthropic"), AiOAuthError);
  assertEquals(error.code, "refresh_failed");
  assertEquals(fake.row.status, "connected");
});

Deno.test("a revoked refresh whose failure cannot be recorded is not reported as reauth_required", async () => {
  const fake = fakeAdmin({ credentials: { access: "a", refresh: "revoked", expires: 5_000 } });
  const storeRpc = fake.admin.rpc.bind(fake.admin);
  const admin = {
    ...fake.admin,
    rpc: (name: string, args: Record<string, unknown>) =>
      name === "fail_ai_oauth_refresh"
        ? Promise.resolve({ data: null, error: { message: "connection reset" } })
        : storeRpc(name, args),
  };
  const deps = {
    ...testDeps(fake, {
      refresh: async () => {
        throw new Error('HTTP request failed. status=400; url=https://x/token; body={"error":"invalid_grant"}');
      },
    }),
    admin: admin as never,
  };

  const error = await assertRejects(() => getFreshOAuthCredential(deps, "anthropic"), AiOAuthError);
  assertEquals(error.code, "refresh_failed");
  assertEquals(fake.row.status, "connected");
});

Deno.test("a disconnect during the refresh is not undone by the refresh completing", async () => {
  const fake = fakeAdmin({ credentials: { access: "a", refresh: "r", expires: 5_000 } });
  const deps = testDeps(fake, {
    refresh: async () => {
      fake.row.credentials = null; // admin pressed Disconnect while the provider answered
      fake.row.leaseToken = null;
      return { access: "late-access", refresh: "late-refresh", expires: 900_000 };
    },
  });

  const error = await assertRejects(() => getFreshOAuthCredential(deps, "anthropic"), AiOAuthError);

  assertEquals(error.code, "refresh_failed");
  assertEquals(fake.row.credentials, null, "the deleted connection must stay deleted");
});

Deno.test("a reconnect during the refresh keeps the new login's credentials", async () => {
  const fake = fakeAdmin({ credentials: { access: "a", refresh: "r", expires: 5_000 } });
  const deps = testDeps(fake, {
    refresh: async () => {
      // A fresh login saved new credentials, which voids the lease.
      fake.row.credentials = { access: "login-access", refresh: "login-refresh", expires: 900_000 };
      fake.row.leaseToken = null;
      fake.row.lockUntil = null;
      return { access: "late-access", refresh: "late-refresh", expires: 900_000 };
    },
  });

  await assertRejects(() => getFreshOAuthCredential(deps, "anthropic"), AiOAuthError);

  assertEquals(fake.row.credentials?.refresh, "login-refresh");
  assertEquals(fake.row.status, "connected", "a stale refresh must not mark the new login failed");
});

Deno.test("missing row throws not_connected", async () => {
  const fake = fakeAdmin();
  const deps = testDeps(fake, {
    refresh: async () => {
      throw new Error("must not refresh");
    },
  });
  const error = await assertRejects(() => getFreshOAuthCredential(deps, "anthropic"), AiOAuthError);
  assertEquals(error.code, "not_connected");
});

Deno.test("status reauth_required throws reauth_required without refresh", async () => {
  const fake = fakeAdmin({
    credentials: { access: "a", refresh: "r", expires: 900_000 },
    status: "reauth_required",
  });
  const deps = testDeps(fake, {
    refresh: async () => {
      throw new Error("must not refresh");
    },
  });
  const error = await assertRejects(() => getFreshOAuthCredential(deps, "anthropic"), AiOAuthError);
  assertEquals(error.code, "reauth_required");
});

Deno.test("isReauthRefreshError asks for a re-login only on a 400/401 invalid_grant", () => {
  const cases: Array<[string, boolean]> = [
    ['HTTP request failed. status=400; url=https://x/token; body={"error":"invalid_grant"}', true],
    ['OpenAI Codex token refresh failed (401): {"error":"invalid_grant"}', true],
    ["OpenAI Codex token refresh failed (400): invalid_grant", true],
    ["HTTP request failed. status=401; url=https://x/token; body=", false],
    ['HTTP request failed. status=400; url=https://x/token; body={"error":"invalid_request"}', false],
    ['HTTP request failed. status=401; url=https://x/token; body={"error":"invalid_client"}', false],
    ["OpenAI Codex token refresh failed (401): Unauthorized", false],
    ['HTTP request failed. status=503; url=https://x/token; body={"error":"invalid_grant"}', false],
    [
      'Anthropic token refresh request failed. url=https://x/token; details=Error: HTTP request failed. status=400; url=https://x/token; body={"error":"invalid_grant"}; stack=Error',
      true,
    ],
    [
      'Anthropic token refresh request failed. url=https://x/token; details=Error: HTTP request failed. status=503; url=https://x/token; body=upstream said status=400; invalid_grant',
      false,
    ],
    ['OpenAI Codex token refresh failed (503): status=400; {"error":"invalid_grant"}', false],
    ['OpenAI Codex token refresh error: token refresh failed (401): invalid_grant', false],
    [
      'HTTP request failed. status=400; url=https://x/token; body={"error":"invalid_request","error_description":"not invalid_grant"}',
      false,
    ],
    ['OpenAI Codex token refresh failed (401): {"error":"invalid_client","hint":"invalid_grant"}', false],
    ['HTTP request failed. status=400; url=https://x/token; body={"details":{"error":"invalid_grant"}}', false],
    ['OpenAI Codex token refresh failed (400): {"details":{"error":"invalid_grant"},"error":"invalid_request"}', false],
    ['HTTP request failed. status=503; url=https://x/token; body={"retry_after":400}', false],
    ["OpenAI Codex token refresh failed (503): retry in 401 ms", false],
    ["OpenAI Codex token refresh error: network timeout", false],
    ["HTTP request failed. status=4003; url=https://x/token; body=", false],
  ];
  for (const [message, expected] of cases) {
    assertEquals(isReauthRefreshError(message), expected, `message: ${message}`);
  }
});

Deno.test("isAiProviderOAuthEnabled is true only for jsonb true", async () => {
  const cases: Array<[unknown, boolean]> = [
    [true, true],
    ["true", false],
    [false, false],
  ];
  for (const [value, expected] of cases) {
    const fake = fakeAdmin();
    fake.row.settingsRow = { value };
    assertEquals(await isAiProviderOAuthEnabled(fake.admin as never), expected, `value: ${value}`);
  }
  const missing = fakeAdmin(); // settingsRow left null
  assertEquals(await isAiProviderOAuthEnabled(missing.admin as never), false);
});

Deno.test("defaultCredentialDeps wires pi-ai and exposes the full dep surface", async () => {
  const deps = defaultCredentialDeps({} as never);
  assertEquals(typeof deps.now(), "number");
  assertEquals(typeof deps.refresh, "function");
  assertEquals(typeof deps.getApiKey, "function");
  await deps.sleep(0);
});
