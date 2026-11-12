import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { AiOAuthError } from "./errors.ts";
import { OAUTH_CLIENTS, OAUTH_PROVIDER_CODE, appOrigin, oauthProviderForCode } from "./clients.ts";

const DEFAULT_APP_ORIGIN = "https://postora.cloud";

function jwtWithPayload(payload: Record<string, unknown>): string {
  const encode = (o: Record<string, unknown>) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

/** Sets PUBLIC_APP_ORIGIN for one test and puts the environment back. */
function withAppOrigin(value: string | undefined, run: () => void): void {
  const previous = Deno.env.get("PUBLIC_APP_ORIGIN");
  try {
    if (value === undefined) Deno.env.delete("PUBLIC_APP_ORIGIN");
    else Deno.env.set("PUBLIC_APP_ORIGIN", value);
    run();
  } finally {
    if (previous === undefined) Deno.env.delete("PUBLIC_APP_ORIGIN");
    else Deno.env.set("PUBLIC_APP_ORIGIN", previous);
  }
}

Deno.test("openrouter is a provider of its own, mapped to the openrouter provider row", () => {
  assertEquals(OAUTH_PROVIDER_CODE.openrouter, "openrouter");
  assertEquals(oauthProviderForCode("openrouter"), "openrouter");
  assertEquals(oauthProviderForCode("claude"), "anthropic");
  assertEquals(oauthProviderForCode("openai"), "openai-codex");
  assertEquals(oauthProviderForCode("nope"), null);
});

Deno.test("the openrouter client is a callback flow and the other two stay paste flows", () => {
  assertEquals(OAUTH_CLIENTS.openrouter.flow, "pkce_callback");
  assertEquals(OAUTH_CLIENTS.anthropic.flow, "pkce_paste");
  assertEquals(OAUTH_CLIENTS["openai-codex"].flow, "pkce_paste");
});

Deno.test("the openrouter authorize URL carries the S256 challenge and the state twice", () => {
  const url = new URL(OAUTH_CLIENTS.openrouter.authorizeUrl("challenge-1", "state-1"));

  assertEquals(url.host, "openrouter.ai");
  assertEquals(url.pathname, "/auth");
  assertEquals(url.searchParams.get("code_challenge"), "challenge-1");
  assertEquals(url.searchParams.get("code_challenge_method"), "S256");
  assertEquals(url.searchParams.get("state"), "state-1");

  // The state rides in the callback's own query string as well, so the attempt
  // is bound even when the provider does not echo the state back.
  const callback = new URL(url.searchParams.get("callback_url") ?? "");
  assertEquals(callback.pathname, "/admin/settings/ai/oauth/openrouter/callback");
  assertEquals(callback.searchParams.get("state"), "state-1");
});

Deno.test("the callback origin comes from PUBLIC_APP_ORIGIN and never from a request header", () => {
  withAppOrigin("https://app.example.test", () => {
    assertEquals(appOrigin(), "https://app.example.test");
    assertEquals(
      OAUTH_CLIENTS.openrouter.redirectUri(),
      "https://app.example.test/admin/settings/ai/oauth/openrouter/callback",
    );
  });
});

Deno.test("a localhost PUBLIC_APP_ORIGIN is allowed and anything malformed falls back", () => {
  withAppOrigin("http://127.0.0.1:5173", () => {
    assertEquals(appOrigin(), "http://127.0.0.1:5173");
  });

  const rejected = ["not a url", "http://example.test", "https://user:pass@example.test", "https://example.test/app"];
  for (const value of rejected) {
    withAppOrigin(value, () => {
      assertEquals(appOrigin(), DEFAULT_APP_ORIGIN, `origin: ${value}`);
    });
  }

  withAppOrigin(undefined, () => {
    assertEquals(appOrigin(), DEFAULT_APP_ORIGIN);
  });
});

Deno.test("the openrouter exchange posts the code and the verifier as JSON", () => {
  const request = OAUTH_CLIENTS.openrouter.exchangeRequest("code-1", "state-1", "verifier-1");

  assertEquals(request.url, "https://openrouter.ai/api/v1/auth/keys");
  assertEquals(request.init.method, "POST");
  assertEquals((request.init.headers as Record<string, string>)["content-type"], "application/json");
  assertEquals(JSON.parse(String(request.init.body)), {
    code: "code-1",
    code_verifier: "verifier-1",
    code_challenge_method: "S256",
  });
});

Deno.test("the openrouter key is stored as a permanent credential with no refresh token", () => {
  const { credentials, expiresAt, accountLabel } = OAUTH_CLIENTS.openrouter.credentialsFromToken(
    { key: "sk-or-v1-abc" },
    1_700_000_000_000,
  );

  assertEquals(credentials.access, "sk-or-v1-abc");
  assertEquals(credentials.refresh, "");
  assertEquals(credentials.expires, 8_640_000_000_000_000);
  assertEquals(expiresAt, "9999-12-31T00:00:00Z");
  assertEquals(accountLabel, null);
});

Deno.test("an openrouter exchange response without a key is refused", () => {
  const bodies: unknown[] = [{}, { key: "" }, { key: 42 }, null, "sk-or-v1-abc"];
  for (const body of bodies) {
    assertThrows(
      () => OAUTH_CLIENTS.openrouter.credentialsFromToken(body, 0),
      AiOAuthError,
      "exchange",
      `body: ${JSON.stringify(body)}`,
    );
  }
});

Deno.test("the anthropic token parsing is unchanged", () => {
  const { credentials, expiresAt, accountLabel } = OAUTH_CLIENTS.anthropic.credentialsFromToken(
    { access_token: "sk-ant-oat-1", refresh_token: "refresh-1", expires_in: 3600 },
    1_700_000_000_000,
  );

  assertEquals(credentials.access, "sk-ant-oat-1");
  assertEquals(credentials.refresh, "refresh-1");
  assertEquals(credentials.expires, 1_700_000_000_000 + 3600 * 1000 - 300_000);
  assertEquals(expiresAt, new Date(1_700_000_000_000 + 3600 * 1000 - 300_000).toISOString());
  assertEquals(accountLabel, null);
  assert(!("accountId" in credentials), "an Anthropic token names no account");
});

Deno.test("a token without the required fields is refused for anthropic too", () => {
  const bodies: unknown[] = [
    { access_token: "sk-ant-oat-1" },
    { access_token: "sk-ant-oat-1", refresh_token: "r" },
    { refresh_token: "r", expires_in: 3600 },
    { access_token: "", refresh_token: "r", expires_in: 3600 },
  ];
  for (const body of bodies) {
    assertThrows(
      () => OAUTH_CLIENTS.anthropic.credentialsFromToken(body, 0),
      AiOAuthError,
      "missing required fields",
      `body: ${JSON.stringify(body)}`,
    );
  }
});

Deno.test("the codex token parsing keeps the account id and the account label", () => {
  const access = jwtWithPayload({
    email: "dev@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acc_1" },
  });

  const { credentials, accountLabel } = OAUTH_CLIENTS["openai-codex"].credentialsFromToken(
    { access_token: access, refresh_token: "codex-refresh", expires_in: 3600 },
    1_700_000_000_000,
  );

  assertEquals(credentials.accountId, "acc_1");
  assertEquals(credentials.refresh, "codex-refresh");
  assertEquals(accountLabel, "dev@example.com");
});

Deno.test("a codex token without a ChatGPT account id is refused", () => {
  const access = jwtWithPayload({ email: "dev@example.com" });
  assertThrows(
    () =>
      OAUTH_CLIENTS["openai-codex"].credentialsFromToken(
        { access_token: access, refresh_token: "codex-refresh", expires_in: 3600 },
        0,
      ),
    AiOAuthError,
    "no ChatGPT account id",
  );
});
