import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  type AiTier,
  callAiChain,
  callChatCompletion,
  callAiWithFallback,
  fetchWithTimeout,
  resolvePlatformApiKey,
} from "./ai-fallback.ts";
import type { AiRoutingAdmin } from "./ai-user-routing.ts";
import { clearProviderEndpointCache } from "./providerEndpoint.ts";

function platformAdmin(
  key: string | null = "platform-secret",
  error: unknown = null,
) {
  const providers: string[] = [];
  return {
    providers,
    admin: {
      from: () => ({
        select: () => ({
          eq: (_column: string, provider: string) => {
            providers.push(provider);
            return {
              maybeSingle: () =>
                Promise.resolve({
                  data: key === null ? null : { api_key: key },
                  error,
                }),
            };
          },
        }),
      }),
    } as unknown as AiRoutingAdmin,
  };
}
const userTier: AiTier = {
  provider: "openai",
  model: "user-model",
  credentialSource: "user",
  apiKey: "user-secret",
};
const platformTier: AiTier = {
  provider: "openai",
  model: "platform-model",
  credentialSource: "platform",
};

Deno.test("GPT-5 request parameters are adapted without mutating the Google fallback request", async () => {
  const original = globalThis.fetch;
  const sent: Record<string, unknown>[] = [];
  const request = {
    max_tokens: 4500,
    temperature: 0.1,
    response_format: { type: "json_object" },
  };
  try {
    globalThis.fetch = (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return Promise.resolve(
        new Response("{}", { status: sent.length === 1 ? 503 : 200 }),
      );
    };
    const result = await callAiChain(undefined, request, [
      { ...userTier, model: "gpt-5.5" },
      { ...userTier, provider: "google", model: "gemini-3-flash-preview" },
    ]);
    assertEquals(result.response.status, 200);
    assertEquals(sent[0], {
      model: "gpt-5.5",
      max_completion_tokens: 4500,
      response_format: { type: "json_object" },
    });
    assertEquals(sent[1], { ...request, model: "gemini-3-flash-preview" });
    assertEquals(request.max_tokens, 4500);
    assertEquals(request.temperature, 0.1);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("xAI platform models reach xAI with the configured xAI key", async () => {
  const original = globalThis.fetch;
  const fake = platformAdmin("xai-secret");
  try {
    globalThis.fetch = (url, init) => {
      assertEquals(url, "https://api.x.ai/v1/chat/completions");
      assertEquals(
        new Headers(init?.headers).get("authorization"),
        "Bearer xai-secret",
      );
      assertEquals(JSON.parse(String(init?.body)), {
        model: "grok-4.3",
        max_tokens: 4500,
        temperature: 0.1,
      });
      return Promise.resolve(new Response("{}"));
    };
    const result = await callAiChain(fake.admin, {
      max_tokens: 4500,
      temperature: 0.1,
    }, [{ ...platformTier, provider: "xai", model: "grok-4.3" }]);
    assertEquals(result.response.status, 200);
    assertEquals(fake.providers, ["xai"]);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("explicit completion limits and supported non-reasoning sampling survive OpenAI adaptation", async () => {
  const original = globalThis.fetch;
  let sent: Record<string, unknown> = {};
  try {
    globalThis.fetch = (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return Promise.resolve(new Response("{}"));
    };
    await callAiChain(undefined, {
      max_tokens: 4500,
      max_completion_tokens: 7000,
      temperature: 0.1,
      reasoning_effort: "none",
    }, [{ ...userTier, model: "gpt-5.2" }]);
    assertEquals(sent, {
      model: "gpt-5.2",
      max_completion_tokens: 7000,
      temperature: 0.1,
      reasoning_effort: "none",
    });
    await callAiChain(undefined, { max_tokens: 200, temperature: 0.2 }, [{
      ...userTier,
      model: "gpt-4.1-mini",
    }]);
    assertEquals(sent, {
      model: "gpt-4.1-mini",
      max_tokens: 200,
      temperature: 0.2,
    });
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("OpenAI reaches OpenAI; rejected user credentials never enter platform tiers", async () => {
  const original = globalThis.fetch;
  const fake = platformAdmin();
  const headers: string[] = [];
  try {
    globalThis.fetch = async (url, init) => {
      assertEquals(url, "https://api.openai.com/v1/chat/completions");
      headers.push(new Headers(init?.headers).get("authorization")!);
      return new Response(
        JSON.stringify(
          headers.length === 1
            ? { error: { message: "rejected user-secret" } }
            : { choices: [{ message: { content: "ok" } }] },
        ),
        { status: headers.length === 1 ? 401 : 200 },
      );
    };
    const result = await callAiChain(fake.admin, {}, [userTier, platformTier]);
    assertEquals(headers, ["Bearer user-secret", "Bearer platform-secret"]);
    assertEquals(fake.providers, ["openai"]);
    assertEquals(result.credentialSource, "platform");
    assertEquals(result.fallbackReason, "user_tier_failed:401");
    assertEquals(result.tiers.map((tier) => [tier.status, tier.error]), [[
      401,
      "AI_USER_KEY_INVALID",
    ], [200, undefined]]);
    assertEquals(JSON.stringify(result.tiers).includes("user-secret"), false);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("Claude uses the Anthropic adapter and returns normalised captions", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assertEquals(url, "https://api.anthropic.com/v1/messages");
      assertEquals(new Headers(init?.headers).get("x-api-key"), "user-secret");
      const body = JSON.parse(String(init?.body));
      assertEquals(body.system, "caption");
      assertEquals(body.temperature, undefined);
      return new Response(
        JSON.stringify({
          id: "msg",
          content: [{ type: "text", text: "caption" }],
          stop_reason: "end_turn",
        }),
      );
    };
    const result = await callAiChain(undefined, {
      messages: [{ role: "system", content: "caption" }],
      temperature: 0.4,
    }, [{ ...userTier, provider: "claude" }]);
    assertEquals(
      (await result.response.json()).choices[0].message.content,
      "caption",
    );
    assertEquals(result.credentialSource, "user");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("empty user keys reject the complete chain before any request or platform read", async () => {
  const original = globalThis.fetch;
  let fetched = false;
  const fake = platformAdmin();
  try {
    globalThis.fetch = () => {
      fetched = true;
      throw new Error("unexpected fetch");
    };
    for (const apiKey of ["", " ", undefined]) {
      await assertRejects(
        () =>
          callAiChain(fake.admin, {}, [
            platformTier,
            { ...userTier, apiKey } as AiTier,
          ]),
        Error,
        "User AI tier requires an API key",
      );
    }
    assertEquals(fetched, false);
    assertEquals(fake.providers, []);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("only three tiers run and repeated platform providers resolve their key once", async () => {
  const original = globalThis.fetch;
  const fake = platformAdmin();
  const models: string[] = [];
  try {
    globalThis.fetch = async (_url, init) => {
      models.push(JSON.parse(String(init?.body)).model);
      return new Response("unavailable", { status: 503 });
    };
    const result = await callAiChain(
      fake.admin,
      {},
      [1, 2, 3, 4].map((n) => ({ ...platformTier, model: `m${n}` })),
    );
    assertEquals(models, ["m1", "m2", "m3"]);
    assertEquals(fake.providers, ["openai"]);
    assertEquals(result.tiers[3].reason, "tier_cap");
    assertEquals(result.tiers[3].status, 0);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("response body is aborted under the same tier deadline", async () => {
  const original = globalThis.fetch;
  let signal: AbortSignal | undefined;
  try {
    globalThis.fetch = async (_url, init) => {
      signal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream({
          start(controller) {
            signal?.addEventListener(
              "abort",
              () => controller.error(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          },
        }),
      );
    };
    await assertRejects(
      () =>
        fetchWithTimeout("https://api.openai.com/v1/chat/completions", {}, 10),
      Error,
    );
    assertEquals(signal?.aborted, true);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("platform DB keys outrank env, missing rows use env, and read errors throw", async () => {
  const original = Deno.env.get;
  Deno.env.get = (name: string) => `env:${name}`;
  try {
    assertEquals(
      await resolvePlatformApiKey(
        platformAdmin("database-key").admin,
        "openai",
      ),
      "database-key",
    );
    for (
      const [provider, env] of [
        ["openai", "OPENAI_API_KEY"],
        ["claude", "ANTHROPIC_API_KEY"],
        ["gemini", "GOOGLE_AI_STUDIO_KEY"],
        ["google", "GOOGLE_AI_STUDIO_KEY"],
        ["openrouter", "OPENROUTER_API_KEY"],
      ]
    ) {
      assertEquals(
        await resolvePlatformApiKey(platformAdmin(null).admin, provider),
        `env:${env}`,
      );
      assertEquals(
        await resolvePlatformApiKey(undefined, provider),
        `env:${env}`,
      );
    }
    await assertRejects(
      () =>
        resolvePlatformApiKey(
          platformAdmin(null, { message: "read failed" }).admin,
          "openai",
        ),
      Error,
      "Platform AI key read failed",
    );
  } finally {
    Deno.env.get = original;
  }
});

Deno.test("legacy wrapper preserves the configured three-tier provider and model order", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = Deno.env.get;
  Deno.env.get = () => "platform-env";
  const calls: string[] = [];
  try {
    globalThis.fetch = async (url, init) => {
      calls.push(`${url}:${JSON.parse(String(init?.body)).model}`);
      return new Response("down", { status: 503 });
    };
    const result = await callAiWithFallback(
      {},
      "openrouter",
      "vendor/primary",
      "google",
      "google/gemini-fallback",
      "google",
      "gemini-floor",
    );
    assertEquals(result.tiers.map(({ provider, model }) => [provider, model]), [
      ["openrouter", "vendor/primary"],
      ["google", "google/gemini-fallback"],
      ["google", "gemini-floor"],
    ]);
    assertEquals(calls, [
      "https://openrouter.ai/api/v1/chat/completions:vendor/primary",
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions:gemini-fallback",
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions:gemini-floor",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.get = originalEnv;
  }
});

Deno.test("a user-only chain rejected with 401 keeps AI_USER_KEY_INVALID instead of a generic outage", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("{}", { status: 401 });
    const result = await callAiChain(undefined, {}, [
      {
        provider: "openai",
        model: "gpt-test",
        credentialSource: "user",
        apiKey: "user-key",
      },
    ]);
    assertEquals(result.response.status, 502);
    assertEquals(result.errorCode, "AI_USER_KEY_INVALID");
    assertEquals(await result.response.json(), {
      error: "AI_USER_KEY_INVALID",
    });
    // A platform tier in the chain means it was an outage, not a bad key.
    const mixed = await callAiChain(undefined, {}, [
      {
        provider: "openai",
        model: "gpt-test",
        credentialSource: "user",
        apiKey: "user-key",
      },
      {
        provider: "openai",
        model: "gpt-floor",
        credentialSource: "platform",
        apiKey: "platform-key",
      },
    ]);
    assertEquals(mixed.errorCode, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("a data-driven zai tier with no saved key and no env var is skipped, never sent the Google key", async () => {
  const originalFetch = globalThis.fetch;
  const originalGet = Deno.env.get;
  clearProviderEndpointCache();
  const fakeAdmin = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: table === "ai_providers"
                ? { api_endpoint: "https://api.z.ai/api/paas/v4", api_type: "openai", is_active: true, api_key_env_var: "ZAI_API_KEY" }
                : null,
              error: null,
            }),
        }),
      }),
    }),
  } as unknown as AiRoutingAdmin;
  let fetched = 0;
  try {
    Deno.env.get = (name: string) => name === "GOOGLE_AI_STUDIO_KEY" ? "google-secret" : undefined;
    globalThis.fetch = () => {
      fetched++;
      return Promise.reject(new Error("fetch must not run"));
    };
    const result = await callAiChain(fakeAdmin, {}, [
      { provider: "zai", model: "glm-5", credentialSource: "platform" },
    ]);
    assertEquals(result.tiers[0].error, "API key not configured");
    assertEquals(fetched, 0);
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.get = originalGet;
  }
});

Deno.test("a data-driven vercel tier reaches its ai_providers endpoint with the platform key", async () => {
  const original = globalThis.fetch;
  clearProviderEndpointCache();
  const fakeAdmin = {
    from: (table: string) => {
      if (table === "ai_providers") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: {
                    api_endpoint: "https://ai-gateway.vercel.sh/v1",
                    api_type: "openai",
                    is_active: true,
                  },
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table === "provider_api_keys") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: { api_key: "k" }, error: null }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as AiRoutingAdmin;
  let requestedUrl: RequestInfo | URL | undefined;
  try {
    globalThis.fetch = async (url, init) => {
      requestedUrl = url;
      assertEquals(
        new Headers(init?.headers).get("authorization"),
        "Bearer k",
      );
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      );
    };
    const result = await callAiChain(fakeAdmin, {}, [
      { provider: "vercel", model: "openai/gpt-5", credentialSource: "platform" },
    ]);
    assertEquals(
      requestedUrl,
      "https://ai-gateway.vercel.sh/v1/chat/completions",
    );
    assertEquals(result.providerUsed, "vercel");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("callChatCompletion sends one shaped request to one tier, with the platform key", async () => {
  const original = globalThis.fetch;
  const fake = platformAdmin("or-secret");
  try {
    globalThis.fetch = (url, init) => {
      assertEquals(url, "https://openrouter.ai/api/v1/chat/completions");
      assertEquals(new Headers(init?.headers).get("authorization"), "Bearer or-secret");
      assertEquals(JSON.parse(String(init?.body)).model, "mistralai/ministral-8b-2512");
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const response = await callChatCompletion(
      fake.admin as unknown as AiRoutingAdmin,
      { provider: "openrouter", model: "mistralai/ministral-8b-2512" },
      { messages: [], response_format: { type: "json_object" } },
      1000,
    );
    assertEquals(response.status, 200);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("callChatCompletion refuses Claude and a missing key without calling out", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = () => {
      throw new Error("must not be called");
    };
    const claude = await callChatCompletion(platformAdmin().admin as unknown as AiRoutingAdmin, { provider: "claude", model: "x" }, {}, 1000);
    assertEquals(claude.status, 400);
    const noKey = await callChatCompletion(platformAdmin(null).admin as unknown as AiRoutingAdmin, { provider: "openai", model: "gpt-5.4-nano" }, {}, 1000);
    assertEquals(noKey.status, 401);
  } finally {
    globalThis.fetch = original;
  }
});
