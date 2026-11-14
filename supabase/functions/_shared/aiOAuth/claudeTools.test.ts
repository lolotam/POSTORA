import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { callPiOAuth, defaultPiCallDeps, type PiCallDeps } from "./piCall.ts";
import { canonicalAssistant, OAuthContinuation, toToolContext } from "./toolTranscript.ts";
import { callOAuthTier } from "./chainTier.ts";

export const lookupTool = { type: "function", function: { name: "search_knowledge", description: "Search business knowledge", parameters: {
  type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"],
} } };

Deno.test("Claude transports a complete nullable-text tool request without executing it", async () => {
  let count = 0;
  const deps: PiCallDeps = {
    getModel: () => ({ api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet-4-5" }),
    complete: async (_model, context) => {
      count++;
      assertEquals((context as { tools: unknown[] }).tools, [{ name: lookupTool.function.name, description: lookupTool.function.description, parameters: lookupTool.function.parameters }]);
      return { content: [{ type: "toolCall", id: "call_a", name: "search_knowledge", arguments: { query: "hours" } }], stopReason: "toolUse" };
    },
  };
  const response = await callPiOAuth(deps, "anthropic", "claude-sonnet-4-5", {
    messages: [{ role: "user", content: "hours?" }], tools: [lookupTool], tool_choice: "auto",
  }, crypto.randomUUID(), 1000, undefined, { toolsEnabled: true });
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.choices[0].message.content, null);
  assertEquals(body.choices[0].message.tool_calls[0].function.arguments, '{"query":"hours"}');
  assertEquals(body.choices[0].finish_reason, "tool_calls");
  assertEquals(count, 1);
});

const initial = { messages: [{ role: "system", content: "Postora inference only" }, { role: "user", content: "hours?" }], tools: [lookupTool], tool_choice: "auto" };
const call = { id: "call_a", type: "function", function: { name: "search_knowledge", arguments: '{"query":"hours"}' } };
const history = [...initial.messages, { role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: "call_a", content: "Open until 5", is_error: true }];

for (const [label, change, expected] of [
  ["root additionalProperties", { tools: [{ ...lookupTool, function: { ...lookupTool.function, parameters: { ...lookupTool.function.parameters, additionalProperties: false } } }] }, "schema_unsupported"],
  ["forced choice", { tool_choice: "required" }, "tools_unsupported"],
  ["named choice", { tool_choice: { type: "function", function: { name: "search_knowledge" } } }, "tools_unsupported"],
  ["required option", { response_format: { type: "json_object" } }, "schema_unsupported"],
  ["missing result", { messages: history.slice(0, -1) }, "tool_history_unsupported"],
  ["mismatched result", { messages: [...history.slice(0, -1), { role: "tool", tool_call_id: "wrong", content: "x" }] }, "tool_history_unsupported"],
  ["duplicate result", { messages: [...history, history.at(-1)] }, "tool_history_unsupported"],
  ["out of order", { messages: [...history.slice(0, -1), { role: "user", content: "next" }, history.at(-1)] }, "tool_history_unsupported"],
  ["malformed arguments", { messages: [...initial.messages, { role: "assistant", content: null, tool_calls: [{ ...call, function: { ...call.function, arguments: "{" } }] }, history.at(-1)] }, "tool_history_unsupported"],
] as const) {
  Deno.test(`preflight refuses ${label} before refresh or inference`, async () => {
    let io = 0;
    const body = { ...initial, ...change };
    const outcome = await callOAuthTier(undefined, { provider: "claude", model: "claude-sonnet-4-5" }, body, 100, {
      enabled: async () => { io++; return true; }, toolsEnabled: async () => { io++; return true; },
    });
    assertEquals(outcome, { error: `oauth_${expected}` });
    assertEquals(io, 0);
  });
}

function sse(calls: Array<{ id: string; raw: string; name?: string }> = [], options: { text?: string; stop?: string; incomplete?: boolean; empty?: boolean } = {}): Response {
  const events: Record<string, unknown>[] = options.empty ? [] : [
    { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], usage: { input_tokens: 8, output_tokens: 0 } } },
  ];
  calls.forEach((tool, index) => events.push(
    { type: "content_block_start", index, content_block: { type: "tool_use", id: tool.id, name: tool.name ?? "search_knowledge", input: {} } },
    { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: tool.raw } },
    { type: "content_block_stop", index },
  ));
  if (options.text) events.push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: options.text } }, { type: "content_block_stop", index: 0 });
  if (!options.incomplete && !options.empty) events.push({ type: "message_delta", delta: { stop_reason: options.stop ?? (calls.length ? "tool_use" : "end_turn") }, usage: { output_tokens: 5 } }, { type: "message_stop" });
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

Deno.test("pinned Claude wire preserves OAuth identity, nested schemas, paired results and final history", async () => {
  const original = globalThis.fetch;
  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  const key = ["sk", "ant", "oat01", crypto.randomUUID()].join("-");
  const continuation = new OAuthContinuation();
  globalThis.fetch = async (_url, init) => {
    requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return requests.length === 1 ? sse([{ id: "call_a", raw: '{"query":"hours"}' }, { id: "call_b", raw: '{"query":"days"}' }]) : sse([], { text: "Open until 5." });
  };
  try {
    const first = await callPiOAuth(defaultPiCallDeps(), "anthropic", "claude-sonnet-4-5", initial, key, 2000, undefined, { toolsEnabled: true, continuation });
    assertEquals(first.status, 200);
    const body = await first.json();
    assertEquals(body.choices[0].message.content, null);
    assertEquals(body.choices[0].message.tool_calls.length, 2);
    assertEquals(body.usage, { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 });
    assertEquals(requests[0].headers.get("authorization"), `Bearer ${key}`);
    assertEquals(requests[0].headers.has("x-api-key"), false);
    assert(requests[0].headers.get("anthropic-beta")?.includes("oauth-2025-04-20"));
    assertEquals((requests[0].body.system as Array<{ text: string }>)[1].text, "Postora inference only");
    assertEquals(((requests[0].body.tools as Array<{ input_schema: unknown }>)[0]).input_schema, lookupTool.function.parameters);
    const final = await callPiOAuth(defaultPiCallDeps(), "anthropic", "claude-sonnet-4-5", {
      messages: [...initial.messages, body.choices[0].message,
        { role: "tool", tool_call_id: "call_a", content: "open 5", is_error: false },
        { role: "tool", tool_call_id: "call_b", content: "unknown", is_error: true }],
    }, key, 2000, undefined, { toolsEnabled: true, continuation });
    assertEquals(final.status, 200);
    assertEquals((await final.json()).choices[0].message.content, "Open until 5.");
    const messages = requests[1].body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const resultBlocks = messages.flatMap(m => m.content).filter(c => c.type === "tool_result");
    assertEquals(resultBlocks.map(r => [r.tool_use_id, r.is_error]), [["call_a", false], ["call_b", true]]);
    assertEquals(JSON.stringify(body).includes("thinkingSignature"), false);
  } finally { globalThis.fetch = original; }
});

for (const [label, fixture] of [
  ["malformed JSON repair", () => sse([{ id: "call_a", raw: '{"query":' }])],
  ["truncated stream", () => sse([{ id: "call_a", raw: '{"query":"hours"}' }], { incomplete: true })],
  ["truncated arguments", () => sse([{ id: "call_a", raw: '{"query":"hours"}' }], { stop: "max_tokens" })],
  ["empty stream", () => sse([], { empty: true })],
  ["duplicate ids", () => sse([{ id: "call_a", raw: '{"query":"hours"}' }, { id: "call_a", raw: '{"query":"days"}' }])],
  ["unoffered tool", () => sse([{ id: "call_a", name: "shell", raw: '{"query":"hours"}' }])],
  ["provider error", () => new Response('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"private provider body"}}\n\n', { headers: { "content-type": "text/event-stream" } })],
] as const) {
  Deno.test(`pinned wire refuses ${label} with no partial completion`, async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => fixture();
    try {
      const response = await callPiOAuth(defaultPiCallDeps(), "anthropic", "claude-sonnet-4-5", initial,
        ["sk", "ant", "oat01", crypto.randomUUID()].join("-"), 2000, undefined, { toolsEnabled: true });
      assertEquals(response.status, 422);
      assertEquals(await response.json(), { error: { code: "response_invalid" } });
    } finally { globalThis.fetch = original; }
  });
}

Deno.test("continuation signatures remain invocation-local and provider/model-bound", async () => {
  const sidecar = new OAuthContinuation();
  const signature = crypto.randomUUID();
  const deps: PiCallDeps = { getModel: () => ({}), complete: async () => ({
    role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "a", timestamp: 1,
    content: [{ type: "thinking", thinkingSignature: signature }, { type: "toolCall", id: "call_a", name: "search_knowledge", arguments: { query: "hours" } }], stopReason: "toolUse",
  }) };
  const response = await callPiOAuth(deps, "anthropic", "a", initial, crypto.randomUUID(), 1000, undefined, { toolsEnabled: true, continuation: sidecar });
  const output = await response.text();
  assertEquals(output.includes(signature), false);
  const message = JSON.parse(output).choices[0].message;
  const body = { messages: [...initial.messages, message, { role: "tool", tool_call_id: "call_a", content: "Open" }] };
  assert(JSON.stringify(toToolContext(body, "anthropic", "a", sidecar)).includes(signature));
  for (const [provider, model, continuation] of [["anthropic", "b", sidecar], ["another-provider", "a", sidecar], ["anthropic", "a", new OAuthContinuation()]] as const) {
    const context = toToolContext(body, provider, model, continuation);
    assertEquals(JSON.stringify(context).includes(signature), false);
    assertEquals(context.messages.at(-1)?.role, "toolResult");
  }
  assertEquals(JSON.stringify(sidecar), "{}");
});

Deno.test("API recovery annotations do not poison a canonical tool transcript", () => {
  const signature = crypto.randomUUID();
  const canonical = canonicalAssistant({ role: "assistant", content: null, tool_calls: [call], refusal: null, annotations: [], provider_metadata: { signature } });
  const context = toToolContext({ messages: [...initial.messages, canonical, { role: "tool", tool_call_id: "call_a", content: "Open" }] }, "anthropic", "a");
  assertEquals(context.messages.at(-1)?.role, "toolResult");
  assertEquals(JSON.stringify(context).includes(signature), false);
});

Deno.test("credential-shaped tool definitions/results are refused before inference", async () => {
  const deps: PiCallDeps = { getModel: () => { throw new Error("preflight must run first"); }, complete: async () => { throw new Error("must not infer"); } };
  const sensitive = JSON.stringify({ access_token: crypto.randomUUID() });
  for (const [body, code] of [
    [{ ...initial, tools: [{ ...lookupTool, function: { ...lookupTool.function, description: sensitive } }] }, "schema_unsupported"],
    [{ messages: [...history.slice(0, -1), { role: "tool", tool_call_id: "call_a", content: sensitive }] }, "tool_history_unsupported"],
  ] as const) {
    const response = await callPiOAuth(deps, "anthropic", "a", body, crypto.randomUUID(), 1000, undefined, { toolsEnabled: true });
    assertEquals(await response.json(), { error: { code } });
  }
});

Deno.test("an uncooperative inference cannot outlast its deadline or poison the next call", async () => {
  let calls = 0;
  const deps: PiCallDeps = { getModel: () => ({}), complete: async () => {
    calls++;
    if (calls === 1) return await new Promise(() => {});
    return { content: [{ type: "text", text: "Recovered" }], stopReason: "stop" };
  } };
  const started = Date.now();
  const first = await callPiOAuth(deps, "anthropic", "a", initial, crypto.randomUUID(), 20, undefined, { toolsEnabled: true });
  assertEquals(first.status, 504);
  assert(Date.now() - started < 500);
  const second = await callPiOAuth(deps, "anthropic", "a", initial, crypto.randomUUID(), 1000, undefined, { toolsEnabled: true });
  assertEquals(second.status, 200);
  assertEquals(calls, 2);
});
