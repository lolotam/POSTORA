import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { AiOAuthError } from "../_shared/aiOAuth/errors.ts";
import { handle, type HandlerDeps } from "./handler.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";

function baseDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    isAdmin: async () => true,
    oauthEnabled: async () => true,
    listOAuthProviders: () => ["anthropic", "github-copilot", "openai-codex"],
    listModels: (oauthProvider: string) =>
      oauthProvider === "anthropic"
        ? ["claude-sonnet-4-5", "claude-opus-5"]
        : ["gpt-5.2-codex"],
    providerInfo: async (providerCode) => ({
      name: providerCode === "claude" ? "Anthropic API" : "OpenAI API",
      active: providerCode === "claude",
    }),
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

Deno.test("capabilities lists only anthropic and openai-codex and never includes token fields", async () => {
  const response = await callHandler({ action: "capabilities" }, baseDeps());
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.enabled, true);
  const ids = body.providers.map((p: { oauth_provider: string }) => p.oauth_provider);
  assertEquals(ids, ["anthropic", "openai-codex"]);
  assert(!ids.includes("github-copilot"));
  const text = JSON.stringify(body);
  assert(!/refresh|access|sk-ant/.test(text), "no token-shaped field may appear");
  const anthropic = body.providers[0];
  assertEquals(anthropic.provider_code, "claude");
  assertEquals(anthropic.name, "Anthropic API");
  assertEquals(anthropic.active, true);
  const codex = body.providers.find((p: { oauth_provider: string }) => p.oauth_provider === "openai-codex");
  assertEquals(codex.active, false, "a provider the admin switched off is reported inactive");
  assertEquals(anthropic.status, "connected");
  assertEquals(anthropic.account_label, "me@example.com");
  assertEquals(anthropic.models, ["claude-sonnet-4-5", "claude-opus-5"]);
  const openai = body.providers[1];
  assertEquals(openai.provider_code, "openai");
  assertEquals(openai.status, "not_connected");
});

Deno.test("capabilities works while the flag is off", async () => {
  const response = await callHandler(
    { action: "capabilities" },
    baseDeps({ oauthEnabled: async () => false }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.enabled, false);
  assertEquals(body.providers.length, 2);
});

Deno.test("finish maps AiOAuthError invalid_state to 400 with code", async () => {
  const response = await callHandler(
    { action: "finish", oauth_provider: "anthropic", pasted: "http://localhost:53692/callback?code=x&state=y" },
    baseDeps({
      finish: async () => {
        throw new AiOAuthError("invalid_state", "login state is unknown, expired or already used");
      },
    }),
  );
  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.error, "invalid_state");
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
