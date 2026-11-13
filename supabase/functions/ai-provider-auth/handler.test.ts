import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { AiOAuthError } from "../_shared/aiOAuth/errors.ts";
import { handle, type HandlerDeps } from "./handler.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";

function baseDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    isAdmin: async () => true,
    oauthEnabled: async () => true,
    listModels: (oauthProvider: string) =>
      oauthProvider === "anthropic"
        ? ["claude-sonnet-4-5", "claude-opus-5"]
        : oauthProvider === "openrouter"
          ? ["anthropic/claude-sonnet-4.5"]
          : ["gpt-5.2-codex"],
    providerInfo: async (providerCode) => ({
      name: providerCode === "claude" ? "Anthropic API" : providerCode === "openrouter" ? "OpenRouter" : "OpenAI API",
      active: providerCode === "claude",
    }),
    providerHasApiKey: async () => true,
    statuses: async () => [
      {
        oauth_provider: "anthropic",
        provider_code: "claude",
        status: "connected",
        account_label: "me@example.com",
        expires_at: "2026-12-01T00:00:00.000Z",
      },
    ],
    start: async () => ({ authorizeUrl: "https://claude.ai/oauth/authorize?x=1" }),
    finish: async () => ({ accountLabel: "me@example.com" }),
    disconnect: async () => {},
    test: async () => ({ ok: true, latency_ms: 123 }),
    logRefusal: async () => {},
    ...overrides,
  };
}

async function callHandler(body: unknown, deps: HandlerDeps, userId: string = USER_ID) {
  const request = new Request("https://example.com/functions/v1/ai-provider-auth", {
    method: "POST",
    headers: { authorization: "Bearer jwt" },
    body: JSON.stringify(body),
  });
  const handlerBody = await request.json();
  return handle(handlerBody, { userId }, deps);
}

Deno.test("non-admin gets 403 and a refusal log row", async () => {
  const refusals: Array<{ action: string; reason: string; userId: string | null }> = [];
  const response = await callHandler({ action: "capabilities" }, baseDeps({
    isAdmin: async () => false,
    logRefusal: async (details) => {
      refusals.push(details);
    },
  }));
  assertEquals(response.status, 403);
  assertEquals(refusals.length, 1);
  assertEquals(refusals[0].action, "capabilities");
  assertEquals(refusals[0].reason, "not_admin");
});

Deno.test("invalid body gets 400", async () => {
  const cases: unknown[] = [
    {},
    { action: "unknown-action" },
    { action: "finish", oauth_provider: "anthropic" }, // pasted missing
    { action: "test", oauth_provider: "anthropic", model_id: "" }, // empty model id
    "not-an-object",
  ];
  for (const body of cases) {
    const response = await callHandler(body, baseDeps());
    assertEquals(response.status, 400, `body: ${JSON.stringify(body)}`);
  }
});

Deno.test("start with flag off returns 409 oauth_disabled", async () => {
  const refusals: Array<{ action: string; reason: string }> = [];
  const response = await callHandler(
    { action: "start", oauth_provider: "anthropic" },
    baseDeps({ oauthEnabled: async () => false, logRefusal: async (d) => { refusals.push(d); } }),
  );
  assertEquals(response.status, 409);
  const body = await response.json();
  assertEquals(body.error, "oauth_disabled");
  assertEquals(refusals[0]?.reason, "oauth_disabled");
});

Deno.test("start answers the authorize URL and the flow the browser needs", async () => {
  const cases: Array<[string, string]> = [
    ["openrouter", "pkce_callback"],
    ["anthropic", "pkce_paste"],
  ];
  for (const [oauthProvider, flow] of cases) {
    const response = await callHandler(
      { action: "start", oauth_provider: oauthProvider },
      baseDeps({ start: async () => ({ authorizeUrl: "https://provider.test/auth?x=1" }) }),
    );
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.authorize_url, "https://provider.test/auth?x=1");
    assertEquals(body.flow, flow);
  }
});

Deno.test("capabilities lists every provider with a client and never includes token fields", async () => {
  const response = await callHandler({ action: "capabilities" }, baseDeps());
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.enabled, true);
  const ids = body.providers.map((p: { oauth_provider: string }) => p.oauth_provider);
  assertEquals(ids, ["anthropic", "openai-codex", "openrouter"]);
  assert(!ids.includes("github-copilot"), "a provider without a client has no sign-in we could drive");
  const text = JSON.stringify(body);
  assert(!/refresh|access|sk-ant/.test(text), "no token-shaped field may appear");
  const anthropic = body.providers[0];
  assertEquals(anthropic.provider_code, "claude");
  assertEquals(anthropic.name, "Anthropic API");
  assertEquals(anthropic.active, true);
  assertEquals(anthropic.flow, "pkce_paste");
  const codex = body.providers.find((p: { oauth_provider: string }) => p.oauth_provider === "openai-codex");
  assertEquals(codex.active, false, "a provider the admin switched off is reported inactive");
  assertEquals(codex.flow, "pkce_paste");
  assertEquals(anthropic.status, "connected");
  assertEquals(anthropic.account_label, "me@example.com");
  assertEquals(anthropic.models, ["claude-sonnet-4-5", "claude-opus-5"]);
  const openai = body.providers[1];
  assertEquals(openai.provider_code, "openai");
  assertEquals(openai.status, "not_connected");
  const openrouter = body.providers[2];
  assertEquals(openrouter.provider_code, "openrouter");
  assertEquals(openrouter.name, "OpenRouter");
  assertEquals(openrouter.flow, "pkce_callback");
  assertEquals(openrouter.models, ["anthropic/claude-sonnet-4.5"]);
});

Deno.test("capabilities works while the flag is off", async () => {
  const response = await callHandler(
    { action: "capabilities" },
    baseDeps({ oauthEnabled: async () => false }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.enabled, false);
  assertEquals(body.providers.length, 3);
});

Deno.test("capabilities report whether the provider also carries an API key", async () => {
  const response = await callHandler({ action: "capabilities" }, baseDeps({
    providerHasApiKey: async (providerCode) => providerCode === "claude",
  }));
  assertEquals(response.status, 200);
  const body = await response.json();
  const anthropic = body.providers.find((p: { provider_code: string }) => p.provider_code === "claude");
  const openai = body.providers.find((p: { provider_code: string }) => p.provider_code === "openai");
  assertEquals(anthropic.has_api_key, true);
  assertEquals(openai.has_api_key, false);
});

Deno.test("a failed key read leaves the key status unknown", async () => {
  const response = await callHandler({ action: "capabilities" }, baseDeps({
    providerHasApiKey: async () => {
      throw new Error("provider_api_keys unreadable");
    },
  }));
  assertEquals(response.status, 200);
  const body = await response.json();
  for (const provider of body.providers) {
    assertEquals(provider.has_api_key, null, "an unreadable key table is not a missing key");
  }
});

Deno.test("a refused finish answers 400 with its code and logs only the code", async () => {
  const refusals: Array<{ action: string; reason: string; userId: string | null }> = [];
  const response = await callHandler(
    { action: "finish", oauth_provider: "anthropic", pasted: "http://localhost:53692/callback?code=x&state=y" },
    baseDeps({
      finish: async () => {
        throw new AiOAuthError("invalid_state", "login state is unknown, expired or already used");
      },
      logRefusal: async (details) => {
        refusals.push(details);
      },
    }),
  );
  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.error, "invalid_state");
  assertEquals(refusals, [{ action: "finish", reason: "invalid_state", userId: USER_ID }]);
});

Deno.test("finish returns the connected account label", async () => {
  let finishArgs: { provider: string; pasted: string; userId: string } | null = null;
  const response = await callHandler(
    { action: "finish", oauth_provider: "openai-codex", pasted: "code#state" },
    baseDeps({
      finish: async (provider, pasted, userId) => {
        finishArgs = { provider, pasted, userId };
        return { accountLabel: "dev@example.com" };
      },
    }),
  );
  assertEquals(finishArgs, { provider: "openai-codex", pasted: "code#state", userId: USER_ID });
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.status, "connected");
  assertEquals(body.account_label, "dev@example.com");
});

Deno.test("disconnect calls delete and works regardless of the flag", async () => {
  let deleted = "";
  const response = await callHandler(
    { action: "disconnect", oauth_provider: "anthropic" },
    baseDeps({
      oauthEnabled: async () => false,
      disconnect: async (provider) => {
        deleted = provider;
      },
    }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.status, "not_connected");
  assertEquals(deleted, "anthropic");
});

Deno.test("test returns ok and latency when the provider answers", async () => {
  const response = await callHandler(
    { action: "test", oauth_provider: "anthropic", model_id: "claude-sonnet-4-5" },
    baseDeps({ test: async () => ({ ok: true, latency_ms: 456 }) }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.ok, true);
  assertEquals(body.latency_ms, 456);
});
