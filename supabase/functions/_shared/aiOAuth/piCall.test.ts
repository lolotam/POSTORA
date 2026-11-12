import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { callPiOAuth, defaultPiCallDeps, type PiCallDeps } from "./piCall.ts";

interface Captured {
  model: unknown;
  context: {
    systemPrompt?: string;
    messages: Array<Record<string, unknown>>;
  };
  options: { apiKey: string; signal: AbortSignal; temperature?: number; maxTokens?: number };
}

/** Stub deps that capture what callPiOAuth builds and returns a canned assistant. */
function captureDeps(assistantOverride?: Record<string, unknown>): { deps: PiCallDeps; captured: Captured } {
  const captured: Captured = {
    model: undefined,
    context: { messages: [] },
    options: { apiKey: "", signal: new AbortController().signal },
  };
  const deps: PiCallDeps = {
    getModel: (provider, modelId) => ({ provider, id: modelId }),
    complete: async (model, context, options) => {
      captured.model = model;
      captured.context = context as Captured["context"];
      captured.options = options;
      return {
        content: [{ type: "text", text: "hi" }],
        stopReason: "stop",
        usage: { input: 11, output: 7, totalTokens: 18 },
        ...assistantOverride,
      } as never;
    },
  };
  return { deps, captured };
}

const BODY = {
  messages: [
    { role: "system", content: "S" },
    { role: "user", content: "U1" },
    { role: "assistant", content: "A1" },
    { role: "user", content: "U2" },
  ],
  temperature: 0.4,
  max_tokens: 128,
};

Deno.test("maps system and chat turns into pi context", async () => {
  const { deps, captured } = captureDeps();

  await callPiOAuth(deps, "anthropic", "claude-sonnet-4-5", BODY, "key-1", 1000);

  assertEquals(captured.context.systemPrompt, "S");
  assertEquals(captured.context.messages.length, 3);

  const user1 = captured.context.messages[0];
  assertEquals(user1.role, "user");
  assertEquals(user1.content, "U1");
  assertEquals(typeof user1.timestamp, "number");

  const assistant = captured.context.messages[1];
  assertEquals(assistant.role, "assistant");
  assertEquals(assistant.content, [{ type: "text", text: "A1" }]);
  assertEquals(assistant.stopReason, "stop");
  assertEquals((assistant.usage as Record<string, number>).input, 0);
  assertEquals((assistant.usage as Record<string, number>).totalTokens, 0);

  const user2 = captured.context.messages[2];
  assertEquals(user2.role, "user");
  assertEquals(user2.content, "U2");

  assertEquals((captured.model as Record<string, string>).id, "claude-sonnet-4-5");
});

Deno.test("multiple system messages join with a blank line", async () => {
  const { deps, captured } = captureDeps();
  await callPiOAuth(
    deps,
    "anthropic",
    "claude-sonnet-4-5",
    {
      messages: [
        { role: "system", content: "first" },
        { role: "system", content: "second" },
        { role: "user", content: "go" },
      ],
    },
    "key-1",
    1000,
  );
  assertEquals(captured.context.systemPrompt, "first\n\nsecond");
  assertEquals(captured.context.messages.length, 1);
});

Deno.test("array-form OpenAI content parts join into text", async () => {
  const { deps, captured } = captureDeps();
  await callPiOAuth(
    deps,
    "anthropic",
    "claude-sonnet-4-5",
    {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "part one" }, { type: "text", text: " part two" }],
        },
      ],
    },
    "key-1",
    1000,
  );
  assertEquals(captured.context.messages[0].content, "part one part two");
});

Deno.test("returns OpenAI-shaped response", async () => {
  const { deps } = captureDeps();

  const response = await callPiOAuth(deps, "anthropic", "claude-sonnet-4-5", BODY, "key-1", 1000);
  assertEquals(response.status, 200);
  const json = await response.json();
  assertEquals(json.choices[0].message.role, "assistant");
  assertEquals(json.choices[0].message.content, "hi");
  assertEquals(json.usage.prompt_tokens, 11);
  assertEquals(json.usage.completion_tokens, 7);
  assertEquals(json.usage.total_tokens, 18);
});

Deno.test("body with tools returns 422 without calling complete", async () => {
  const { deps, captured } = captureDeps();
  let completeCalls = 0;
  const guardedDeps: PiCallDeps = {
    getModel: deps.getModel,
    complete: async (...args) => {
      completeCalls++;
      return deps.complete(...args);
    },
  };

  const response = await callPiOAuth(
    guardedDeps,
    "anthropic",
    "claude-sonnet-4-5",
    { ...BODY, tools: [{ type: "function", function: { name: "x" } }] },
    "key-1",
    1000,
  );

  assertEquals(response.status, 422);
  assertEquals(completeCalls, 0);
  assertEquals(captured.model, undefined);
});

Deno.test("unknown model returns 424 without calling complete", async () => {
  let completeCalls = 0;
  const deps: PiCallDeps = {
    getModel: () => undefined,
    complete: async () => {
      completeCalls++;
      throw new Error("must not be called");
    },
  };

  const response = await callPiOAuth(deps, "anthropic", "not-a-model", BODY, "key-1", 1000);
  assertEquals(response.status, 424);
  assertEquals(completeCalls, 0);
});

Deno.test("stopReason error returns 502 with redacted error text", async () => {
  const { deps } = captureDeps({ stopReason: "error", errorMessage: "provider exploded with key sk-ant-secret-1" });

  const response = await callPiOAuth(deps, "anthropic", "claude-sonnet-4-5", BODY, "sk-ant-secret-1", 1000);
  assertEquals(response.status, 502);
  const body = await response.text();
  assert(!body.includes("sk-ant-secret-1"), "the api key must never appear in the response body");
  assert(body.includes("[REDACTED]"));
});

Deno.test("thrown provider error returns 502 and never throws", async () => {
  const deps: PiCallDeps = {
    getModel: () => ({ id: "m" }),
    complete: async () => {
      throw new Error("network down with key sk-ant-secret-2");
    },
  };
  const response = await callPiOAuth(deps, "anthropic", "claude-sonnet-4-5", BODY, "sk-ant-secret-2", 1000);
  assertEquals(response.status, 502);
  const body = await response.text();
  assert(!body.includes("sk-ant-secret-2"));
});

Deno.test("timeout error returns 504", async () => {
  const deps: PiCallDeps = {
    getModel: () => ({ id: "m" }),
    complete: async (_model, _context, options) => {
      const timeout = new Error("The operation was aborted due to timeout") as Error & { name: string };
      timeout.name = "TimeoutError";
      void options.signal;
      throw timeout;
    },
  };
  const response = await callPiOAuth(deps, "anthropic", "claude-sonnet-4-5", BODY, "key-1", 5);
  assertEquals(response.status, 504);
});

Deno.test("passes temperature and max_tokens as temperature/maxTokens", async () => {
  const { deps, captured } = captureDeps();
  await callPiOAuth(deps, "openai-codex", "gpt-5.2-codex", BODY, "key-1", 1000);
  assertEquals(captured.options.temperature, 0.4);
  assertEquals(captured.options.maxTokens, 128);
  assertEquals(captured.options.apiKey, "key-1");
  assert(captured.options.signal instanceof AbortSignal);
});

Deno.test("defaultPiCallDeps resolves a real pi model", () => {
  const deps = defaultPiCallDeps();
  const model = deps.getModel("openai", "gpt-4o-mini") as Record<string, unknown> | undefined;
  assert(model !== undefined, "pi-ai getModel must resolve gpt-4o-mini");
  assertEquals(model.id, "gpt-4o-mini");
  assertEquals(deps.getModel("openai", "not-a-real-model"), undefined);
});
