import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { AiOAuthError } from "./errors.ts";
import { OAUTH_PROVIDER_CODE, type OAuthProviderId } from "./clients.ts";
import {
  finishLogin,
  parseAuthorizationInput,
  startLogin,
  type LoginDeps,
} from "./loginFlow.ts";

/** Minimal admin-client fake for the oauth_states boundary. */
function fakeAdmin(stateRows: Array<Record<string, unknown>> = []) {
  const inserts: Array<Record<string, unknown>> = [];
  const consumed: Array<Record<string, unknown>> = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rows = stateRows;
  const admin = {
    from(table: string) {
      assertEquals(table, "oauth_states");
      return {
        insert(values: Record<string, unknown>) {
          inserts.push(values);
          return { error: null };
        },
        delete() {
          const builder = {
            eq() {
              return builder;
            },
            gt() {
              return builder;
            },
            select(_cols: string) {
              return {
                maybeSingle: async () => {
                  const row = rows.shift() ?? null;
                  if (row) consumed.push(row);
                  return { data: row, error: null };
                },
              };
            },
          };
          return builder;
        },
      };
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      return { error: null };
    },
  };
  return { admin, inserts, consumed, rpcCalls };
}

function neverFetch(): typeof fetch {
  return (_input, _init) => {
    throw new Error("fetch must not be called");
  };
}

function tokenFetch(body: unknown, calls: Array<{ url: string; init: RequestInit }> = []): typeof fetch {
  return async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

async function base64UrlSha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function jwtWithPayload(payload: Record<string, unknown>): string {
  const encode = (o: Record<string, unknown>) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

Deno.test("startLogin anthropic builds claude.ai authorize URL with S256 challenge and state equal to verifier", async () => {
  const { admin, inserts } = fakeAdmin();
  const deps: LoginDeps = { admin: admin as never, fetch: neverFetch(), now: () => 1_700_000_000_000 };

  const { authorizeUrl } = await startLogin(deps, "anthropic", "user-1");
  const url = new URL(authorizeUrl);

  assertEquals(url.host, "claude.ai");
  assertEquals(url.pathname, "/oauth/authorize");
  assertEquals(url.searchParams.get("code"), "true");
  assertEquals(url.searchParams.get("client_id"), atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl"));
  assertEquals(url.searchParams.get("response_type"), "code");
  assertEquals(url.searchParams.get("redirect_uri"), "http://localhost:53692/callback");
  assertEquals(url.searchParams.get("code_challenge_method"), "S256");

  assertEquals(inserts.length, 1);
  const row = inserts[0];
  assertEquals(row.scope_kind, "platform");
  assertEquals(row.provider_code, "anthropic");
  assertEquals(row.redirect_uri, "http://localhost:53692/callback");
  // The state is the PKCE verifier for anthropic, and the challenge is its SHA-256.
  assertEquals(url.searchParams.get("state"), row.code_verifier);
  assertEquals(
    url.searchParams.get("code_challenge"),
    await base64UrlSha256(String(row.code_verifier)),
  );
  assertEquals(row.user_id, "user-1");
});

Deno.test("startLogin openai-codex adds originator and codex flags", async () => {
  const { admin, inserts } = fakeAdmin();
  const deps: LoginDeps = { admin: admin as never, fetch: neverFetch(), now: () => 1_700_000_000_000 };

  const { authorizeUrl } = await startLogin(deps, "openai-codex", "user-1");
  const url = new URL(authorizeUrl);

  assertEquals(url.host, "auth.openai.com");
  assertEquals(url.pathname, "/oauth/authorize");
  assertEquals(url.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
  assertEquals(url.searchParams.get("originator"), "pi");
  assertEquals(url.searchParams.get("codex_cli_simplified_flow"), "true");
  assertEquals(url.searchParams.get("id_token_add_organizations"), "true");
  assertEquals(url.searchParams.get("scope"), "openid profile email offline_access");

  // The codex state is random (not the verifier), but it is what the row stores.
  const state = url.searchParams.get("state");
  assert(state !== null);
  assert(/^[0-9a-f]{32}$/.test(state), "codex state must be 16 random bytes as hex");
  assertEquals(inserts[0].state, state);
  assertEquals(inserts[0].provider_code, "openai-codex");
  assert(String(inserts[0].code_verifier).length >= 43);
});

Deno.test("parseAuthorizationInput accepts url, code#state, querystring and bare code", () => {
  const cases: Array<[string, { code?: string; state?: string }]> = [
    ["http://localhost:53692/callback?code=cd1&state=st1", { code: "cd1", state: "st1" }],
    ["cd2#st2", { code: "cd2", state: "st2" }],
    ["code=cd3&state=st3", { code: "cd3", state: "st3" }],
    ["cd4", { code: "cd4" }],
  ];
  for (const [input, expected] of cases) {
    assertEquals(parseAuthorizationInput(input), expected, `input: ${input}`);
  }
});

Deno.test("finishLogin rejects unknown or expired state without calling fetch", async () => {
  const { admin } = fakeAdmin(); // no stored row survives
  const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
  const deps: LoginDeps = {
    admin: admin as never,
    fetch: tokenFetch({}, fetchCalls),
    now: () => 1_700_000_000_000,
  };

  const error = await assertRejects(
    () => finishLogin(deps, "anthropic", "http://localhost:53692/callback?code=c&state=missing", "user-1"),
    AiOAuthError,
  );
  assertEquals(error.code, "invalid_state");
  assertEquals(fetchCalls.length, 0);
});

Deno.test("finishLogin anthropic posts JSON body and saves credentials through rpc", async () => {
  const storedState = "platform-state-1";
  const { admin, consumed, rpcCalls } = fakeAdmin([
    { state: storedState, provider_code: "anthropic", scope_kind: "platform", code_verifier: "verifier-1" },
  ]);
  const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
  const deps: LoginDeps = {
    admin: admin as never,
    fetch: tokenFetch({ access_token: "sk-ant-oat-test", refresh_token: "refresh-new", expires_in: 3600 }, fetchCalls),
    now: () => 1_700_000_000_000,
  };

  const result = await finishLogin(
    deps,
    "anthropic",
    `http://localhost:53692/callback?code=auth-code&state=${storedState}`,
    "user-1",
  );

  assertEquals(consumed.length, 1, "the state row must be consumed exactly once");
  assertEquals(fetchCalls.length, 1);
  assertEquals(fetchCalls[0].url, "https://platform.claude.com/v1/oauth/token");
  assert(fetchCalls[0].init.signal instanceof AbortSignal, "the exchange must carry a timeout signal");
  assertEquals((fetchCalls[0].init.headers as Record<string, string>)["content-type"], "application/json");
  const body = JSON.parse(String(fetchCalls[0].init.body));
  assertEquals(body.grant_type, "authorization_code");
  assertEquals(body.code, "auth-code");
  assertEquals(body.state, storedState);
  assertEquals(body.code_verifier, "verifier-1");

  const save = rpcCalls.find((c) => c.name === "save_ai_oauth_credentials");
  assert(save !== undefined, "save_ai_oauth_credentials must be called");
  assertEquals(save.args.p_provider_code, OAUTH_PROVIDER_CODE.anthropic);
  const credentials = save.args.p_credentials as Record<string, unknown>;
  assertEquals(credentials.refresh, "refresh-new");
  assertEquals(credentials.expires, 1_700_000_000_000 + 3600 * 1000 - 300_000);
  assertEquals(save.args.p_expires_at, new Date(1_700_000_000_000 + 3600 * 1000 - 300_000).toISOString());
  assertEquals(save.args.p_oauth_provider, "anthropic");
  assertEquals(save.args.p_user, "user-1");
  assertEquals(result.accountLabel, null);
});

Deno.test("finishLogin openai-codex posts form body and stores accountId from JWT claim", async () => {
  const storedState = "codex-state-1";
  const { admin, rpcCalls } = fakeAdmin([
    { state: storedState, provider_code: "openai-codex", scope_kind: "platform", code_verifier: "verifier-2" },
  ]);
  const access = jwtWithPayload({
    email: "dev@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acc_1" },
  });
  const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
  const deps: LoginDeps = {
    admin: admin as never,
    fetch: tokenFetch({ access_token: access, refresh_token: "codex-refresh", expires_in: 3600 }, fetchCalls),
    now: () => 1_700_000_000_000,
  };

  const result = await finishLogin(
    deps,
    "openai-codex",
    `http://localhost:1455/auth/callback?code=auth-code&state=${storedState}`,
    "user-1",
  );

  assertEquals(fetchCalls.length, 1);
  assertEquals(fetchCalls[0].url, "https://auth.openai.com/oauth/token");
  assertEquals(
    (fetchCalls[0].init.headers as Record<string, string>)["content-type"],
    "application/x-www-form-urlencoded",
  );
  const form = new URLSearchParams(String(fetchCalls[0].init.body));
  assertEquals(form.get("grant_type"), "authorization_code");
  assertEquals(form.get("code"), "auth-code");
  assertEquals(form.get("code_verifier"), "verifier-2");
  assertEquals(form.get("redirect_uri"), "http://localhost:1455/auth/callback");

  const save = rpcCalls.find((c) => c.name === "save_ai_oauth_credentials");
  assert(save !== undefined);
  const credentials = save.args.p_credentials as Record<string, unknown>;
  assertEquals(credentials.accountId, "acc_1");
  assertEquals(result.accountLabel, "dev@example.com");
});

Deno.test("finishLogin reports a timed-out exchange as exchange_failed and saves nothing", async () => {
  const storedState = "timeout-state-1";
  const { admin, rpcCalls } = fakeAdmin([
    { state: storedState, provider_code: "anthropic", scope_kind: "platform", code_verifier: "verifier-3" },
  ]);
  const deps: LoginDeps = {
    admin: admin as never,
    fetch: () => Promise.reject(new DOMException("signal timed out", "TimeoutError")),
    now: () => 1_700_000_000_000,
  };

  const error = await assertRejects(
    () => finishLogin(deps, "anthropic", `http://localhost:53692/callback?code=c&state=${storedState}`, "user-1"),
    AiOAuthError,
  );

  assertEquals(error.code, "exchange_failed");
  assertEquals(error.message, "token exchange timed out");
  assertEquals(rpcCalls.filter((c) => c.name === "save_ai_oauth_credentials").length, 0);
});
