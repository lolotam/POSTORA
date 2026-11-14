import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { callOAuthTier, isOAuthTierModel } from "./chainTier.ts";
import { defaultCredentialDeps, type CredentialDeps } from "./credentials.ts";
import { defaultPiCallDeps, type PiCallDeps } from "./piCall.ts";

const MODEL_ID = "anthropic/claude-sonnet-4.5";

/** An admin client that only answers the credential read. */
function fakeAdmin(credentials: Record<string, unknown>) {
  return {
    rpc(name: string) {
      if (name === "get_ai_oauth_credentials") {
        const response = Promise.resolve({ data: { ...credentials, status: "connected" }, error: null });
        return Object.assign(response, { abortSignal: () => response });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from() {
      throw new Error("a tier must not read a table");
    },
  };
}

/** The OpenRouter credential: a permanent key, no refresh token. */
function openRouterCredentialDeps(): CredentialDeps {
  return {
    ...defaultCredentialDeps(
      fakeAdmin({ access: "sk-or-v1-key", refresh: "", expires: 8_640_000_000_000_000 }) as never,
    ),
    now: () => 5_000,
    sleep: async () => {},
  };
}

interface Captured {
  provider: string;
  modelId: string;
  apiKey: string;
}

function capturePi(): { pi: PiCallDeps; captured: Captured } {
  const captured: Captured = { provider: "", modelId: "", apiKey: "" };
  const pi: PiCallDeps = {
    getModel: (provider, modelId) => {
      captured.provider = provider;
      captured.modelId = modelId;
      return { provider, id: modelId };
    },
    complete: async (_model, _context, options) => {
      captured.apiKey = options.apiKey;
      return {
        content: [{ type: "text", text: "ok" }],
        stopReason: "stop",
        usage: { input: 1, output: 1, totalTokens: 2 },
      };
    },
  };
  return { pi, captured };
}

Deno.test("an openrouter tier calls pi-ai's openrouter provider with the stored key", async () => {
  const { pi, captured } = capturePi();

  const outcome = await callOAuthTier(
    undefined,
    { provider: "openrouter", model: MODEL_ID },
    { messages: [{ role: "user", content: "hi" }] },
    5_000,
    {
      credentials: openRouterCredentialDeps(),
      pi,
      enabled: async () => true,
      providerActive: async () => true,
    },
  );

  assert("response" in outcome, `the tier must answer, got ${JSON.stringify(outcome)}`);
  assertEquals(captured.provider, "openrouter");
  assertEquals(captured.modelId, MODEL_ID);
  // The stored OpenRouter key IS the api key pi-ai sends.
  assertEquals(captured.apiKey, "sk-or-v1-key");
});

Deno.test("pi-ai knows the openrouter models a tier may name", () => {
  assertEquals(isOAuthTierModel("openrouter", MODEL_ID), true);
  assertEquals(isOAuthTierModel("openrouter", "not-a-model"), false);
  assert(defaultPiCallDeps().getModel("openrouter", MODEL_ID) !== undefined);
});

Deno.test("a provider without a client is refused before anything else happens", async () => {
  const outcome = await callOAuthTier(
    undefined,
    { provider: "zai", model: "glm-4.6" },
    { messages: [{ role: "user", content: "hi" }] },
    5_000,
    { enabled: async () => true, providerActive: async () => true },
  );

  assertEquals(outcome, { error: "oauth_unsupported_provider" });
});
