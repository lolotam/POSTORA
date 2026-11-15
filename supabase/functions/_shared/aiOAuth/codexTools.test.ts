import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callPiOAuth, defaultPiCallDeps } from "./piCall.ts";
import { OAuthContinuation, toToolContext } from "./toolTranscript.ts";
import { callOAuthTier } from "./chainTier.ts";
import { defaultCredentialDeps } from "./credentials.ts";

const model = "gpt-5.1-codex-max";
const tool = { type: "function", function: { name: "search_knowledge", description: "Look up opening hours", parameters: {
  type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"],
} } };
const initial = { messages: [{ role: "system", content: "Postora inference only" }, { role: "user", content: "hours?" }], tools: [tool], tool_choice: "auto" };
function credential() {
  const account = crypto.randomUUID();
  return { account, token: [btoa("{}"), btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })), btoa(crypto.randomUUID())].join(".") };
}
function sse(options: { round?: number; text?: string; raw?: string; secondCall?: boolean; incomplete?: boolean; unclosed?: boolean; error?: boolean; empty?: boolean; malformedBody?: boolean; status?: string } = {}) {
  if (options.malformedBody) return Response.json({ choices: [{ message: { content: "not a Responses stream" } }] });
  const round = options.round ?? 1;
  const reasoning = { type: "reasoning", id: `rs_private_${round}`, encrypted_content: `opaque_private_${round}`, summary: [] };
  const call = { type: "function_call", id: `fc_private_${round}`, call_id: `call_private_${round}`, name: tool.function.name, arguments: options.raw ?? '{"query":"hours"}' };
  const calls = [call, ...(options.secondCall ? [{ ...call, id: `${call.id}_extra`, call_id: `${call.call_id}_extra` }] : [])];
  const message = { type: "message", id: `msg_private_${round}`, role: "assistant", content: [{ type: "output_text", text: options.text }], status: "completed" };
  const events: Array<Record<string, unknown>> = options.empty ? [] : [
    { type: "response.created", response: { id: `resp_private_${round}` } },
    { type: "response.output_item.added", item: { ...reasoning } }, { type: "response.output_item.done", item: reasoning },
    ...(options.text ? [
      { type: "response.output_item.added", item: { ...message, content: [] } },
      { type: "response.content_part.added", part: { type: "output_text", text: "" } },
      { type: "response.output_text.delta", delta: options.text }, { type: "response.output_item.done", item: message },
    ] : calls.flatMap(request => [
      { type: "response.output_item.added", item: { ...request, arguments: "" } },
      { type: "response.function_call_arguments.delta", delta: request.arguments },
      ...(!options.unclosed ? [{ type: "response.output_item.done", item: request }] : []),
    ])),
    ...(options.incomplete ? [] : [{ type: options.error ? "response.failed" : "response.completed", response: {
      id: `resp_private_${round}`, status: options.status ?? "completed", error: options.error ? { message: "private upstream body" } : undefined,
      usage: { input_tokens: 8, output_tokens: 5, total_tokens: 13, input_tokens_details: { cached_tokens: 2 } },
    } }]),
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

Deno.test("pinned Codex SSE preserves native continuation across multiple rounds, with neutral paired IDs", async () => {
  const original = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  let websocketAttempts = 0;
  globalThis.WebSocket = new Proxy(originalWebSocket, { construct() { websocketAttempts++; throw new Error("WebSocket forbidden in this fixture"); } });
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const auth = credential();
  const sidecar = new OAuthContinuation();
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return sse(requests.length === 3 ? { text: "Open until 5.", round: 3 } : { round: requests.length, secondCall: requests.length === 1 });
  };
  try {
    const messages: unknown[] = [...initial.messages];
    for (let round = 1; round <= 3; round++) {
      const response = await callPiOAuth(defaultPiCallDeps(), "openai-codex", model,
        round === 3 ? { messages } : { ...initial, messages }, auth.token, 2000, undefined, { toolsEnabled: true, continuation: sidecar });
      assertEquals(response.status, 200);
      const output = await response.json();
      assertEquals(output.usage, { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 });
      assertEquals(JSON.stringify(output).includes("private_"), false);
      assertEquals(JSON.stringify(output).includes("opaque_"), false);
      if (round < 3) {
        const assistant = output.choices[0].message;
        assertEquals(assistant.content, null);
        assertEquals(output.choices[0].finish_reason, "tool_calls");
        assertEquals(assistant.tool_calls.length, round === 1 ? 2 : 1);
        messages.push(assistant, ...assistant.tool_calls.map((call: { id: string }, index: number) => ({ role: "tool", tool_call_id: call.id, content: index ? "unknown" : "Open until 5", is_error: index > 0 })));
      } else assertEquals(output.choices[0].message.content, "Open until 5.");
    }
    for (const request of requests) {
      assertEquals(request.url, "https://chatgpt.com/backend-api/codex/responses");
      assertEquals(request.headers.get("authorization"), `Bearer ${auth.token}`);
      assertEquals(request.headers.get("chatgpt-account-id"), auth.account);
      assertEquals(request.headers.get("accept"), "text/event-stream");
      assertEquals(request.headers.has("session_id"), false);
      assertEquals(request.headers.has("x-client-request-id"), false);
      assertEquals(request.body.store, false);
      assertEquals(request.body.stream, true);
      assertEquals(request.body.prompt_cache_key, undefined);
    }
    assertEquals(requests[0].body.tools, [{ type: "function", ...tool.function, strict: null }]);
    const input = requests[2].body.input as Array<Record<string, unknown>>;
    assertEquals(input.filter(part => part.type === "reasoning").map(part => part.encrypted_content), ["opaque_private_1", "opaque_private_2"]);
    assertEquals(input.filter(part => part.type === "function_call").map(part => [part.id, part.call_id]), [["fc_private_1", "call_private_1"], ["fc_private_1_extra", "call_private_1_extra"], ["fc_private_2", "call_private_2"]]);
    assertEquals(input.filter(part => part.type === "function_call_output").map(part => [part.call_id, part.output]), [["call_private_1", "Open until 5"], ["call_private_1_extra", "unknown"], ["call_private_2", "Open until 5"]]);
    assertEquals(JSON.stringify(sidecar), "{}");
    assertEquals(websocketAttempts, 0);
  } finally { globalThis.fetch = original; globalThis.WebSocket = originalWebSocket; }
});

for (const [label, options] of [
  ["EOF after completed text item", { text: "partial", incomplete: true }],
  ["EOF after completed tool item", { incomplete: true }],
  ["unclosed arguments", { unclosed: true }],
  ["repaired partial JSON", { raw: '{"query":' }],
  ["empty stream", { empty: true }],
  ["malformed HTTP 200", { malformedBody: true }],
  ["provider error", { error: true }],
  ["truncated completion", { status: "incomplete" }],
] as const) Deno.test(`pinned Codex refuses ${label} before selection`, async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => sse(options);
  try {
    const response = await callPiOAuth(defaultPiCallDeps(), "openai-codex", model, initial, credential().token, 2000, undefined, { toolsEnabled: true });
    assertEquals(response.status, 422);
    assertEquals(await response.json(), { error: { code: "response_invalid" } });
  } finally { globalThis.fetch = original; }
});

Deno.test("Codex preserves root schema constraints that Claude must refuse", async () => {
  const original = globalThis.fetch;
  const parameters = { ...tool.function.parameters, additionalProperties: false, minProperties: 1, allOf: [{ properties: { query: { maxLength: 80 } } }] };
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assertEquals(body.tools[0].parameters, parameters);
    return sse({ text: "Done" });
  };
  try {
    const body = { ...initial, tools: [{ ...tool, function: { ...tool.function, parameters } }] };
    assertEquals((await callPiOAuth(defaultPiCallDeps(), "openai-codex", model, body, credential().token, 2000, undefined, { toolsEnabled: true })).status, 200);
    assertEquals((await callPiOAuth(defaultPiCallDeps(), "anthropic", "claude-sonnet-4-5", body, crypto.randomUUID(), 2000, undefined, { toolsEnabled: true })).status, 422);
    assertEquals(calls, 1);
  } finally { globalThis.fetch = original; }
});

for (const [label, change, reason] of [
  ["triage cap", { max_tokens: 200 }, "max_tokens_unsupported"],
  ["YouTube cap", { max_completion_tokens: 4096 }, "max_tokens_unsupported"],
  ["conflicting cap spellings", { max_tokens: "invalid", max_completion_tokens: 200 }, "max_tokens_unsupported"],
  ["forced choice", { tool_choice: "required" }, "tools_unsupported"],
  ["provider schema output", { response_format: { type: "json_schema" } }, "schema_unsupported"],
  ["final-only schema output", { tools: undefined, tool_choice: undefined, response_format: { type: "json_schema" } }, "schema_unsupported"],
  ["missing result", { messages: [...initial.messages, { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: tool.function.name, arguments: "{}" } }] }] }, "tool_history_unsupported"],
] as const) Deno.test(`Codex ${label} refuses before flags, credentials or inference`, async () => {
  let io = 0;
  const outcome = await callOAuthTier(undefined, { provider: "openai", model }, { ...initial, ...change }, 100, {
    requireTools: true,
    enabled: async () => { io++; return true; }, toolsEnabled: async () => { io++; return true; },
  });
  assertEquals(outcome, { error: `oauth_${reason}` });
  assertEquals(io, 0);
});

for (const [from, to] of [["anthropic", "openai-codex"], ["openai-codex", "anthropic"]] as const) {
  Deno.test(`canonical completed facts continue ${from} to ${to} without native state`, async () => {
    const continuation = new OAuthContinuation();
    const nativeId = from === "openai-codex" ? "call_private|fc_private" : "call_private";
    const response = await callPiOAuth({ getModel: () => ({}), complete: async () => ({
      role: "assistant", provider: from, model: "source", api: from === "anthropic" ? "anthropic-messages" : "openai-codex-responses",
      content: [{ type: "thinking", thinkingSignature: "private_signature" }, { type: "toolCall", id: nativeId, name: tool.function.name, arguments: { query: "hours" } }], stopReason: "toolUse",
    }) }, from, "source", initial, crypto.randomUUID(), 1000, undefined, { toolsEnabled: true, continuation });
    assertEquals(response.status, 200);
    const assistant = (await response.json()).choices[0].message;
    const body = { messages: [...initial.messages, assistant, { role: "tool", tool_call_id: assistant.tool_calls[0].id, content: "Open", is_error: true }] };
    const context = toToolContext(body, to, "target", continuation);
    assertEquals(JSON.stringify(context).includes("private_signature"), false);
    assertEquals(JSON.stringify(context).includes("fc_private"), false);
    assertEquals(JSON.stringify(context).includes("call_private"), false);
    const prior = context.messages.find(message => message.role === "assistant");
    assertEquals(prior?.api, to === "anthropic" ? "anthropic-messages" : "openai-codex-responses");
    assertEquals(context.messages.at(-1)?.isError, true);
    assert(context.messages.at(-1)?.toolCallId);
    assertThrows(() => toToolContext({ messages: body.messages.slice(0, -1) }, to, "target", continuation));
    const original = globalThis.fetch;
    let wire = "";
    globalThis.fetch = async (_url, init) => {
      wire = String(init?.body);
      if (to === "openai-codex") return sse({ text: "Open" });
      const events = [
        { type: "message_start", message: { id: "msg_final", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], usage: { input_tokens: 8, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Open" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, { type: "message_stop" },
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    };
    try {
      const token = to === "openai-codex" ? credential().token : ["sk", "ant", "oat01", crypto.randomUUID()].join("-");
      const targetModel = to === "openai-codex" ? model : "claude-sonnet-4-5";
      const final = await callPiOAuth(defaultPiCallDeps(), to, targetModel, body, token, 2000, undefined, { toolsEnabled: true, continuation });
      assertEquals(final.status, 200);
      assertEquals((await final.json()).choices[0].message.content, "Open");
      assertEquals(/private_signature|fc_private|call_private/.test(wire), false);
      const payload = JSON.parse(wire);
      const blocks: Array<Record<string, unknown>> = to === "openai-codex" ? payload.input : payload.messages.flatMap((message: { content: unknown[] }) => message.content);
      const call = blocks.find(block => block.type === (to === "openai-codex" ? "function_call" : "tool_use"));
      const result = blocks.find(block => block.type === (to === "openai-codex" ? "function_call_output" : "tool_result"));
      assert(call && result);
      assertEquals(to === "openai-codex" ? call.call_id : call.id, to === "openai-codex" ? result.call_id : result.tool_use_id);
    } finally { globalThis.fetch = original; }
  });
}

for (const [label, flags, expected] of [
  ["missing Codex flag", { feature_ai_provider_oauth: true, feature_ai_text_auth_lists: true, feature_ai_oauth_tools_claude: true }, "oauth_tools_unsupported"],
  ["master off", { feature_ai_provider_oauth: false, feature_ai_text_auth_lists: true, feature_ai_oauth_tools_codex: true }, "oauth_tools_unsupported"],
  ["list flag off", { feature_ai_provider_oauth: true, feature_ai_text_auth_lists: false, feature_ai_oauth_tools_codex: true }, "oauth_tools_unsupported"],
  ["Codex off", { feature_ai_provider_oauth: true, feature_ai_text_auth_lists: true, feature_ai_oauth_tools_codex: false }, "oauth_tools_unsupported"],
  ["Codex on independently", { feature_ai_provider_oauth: true, feature_ai_text_auth_lists: true, feature_ai_oauth_tools_codex: true, feature_ai_oauth_tools_claude: false }, null],
] as const) Deno.test(`Codex server flags: ${label}`, async () => {
  const original = globalThis.fetch;
  let credentialReads = 0;
  let inference = 0;
  globalThis.fetch = async url => {
    if (String(url).includes("system_settings")) return Response.json(Object.entries(flags).map(([key, value]) => ({ key, value })));
    credentialReads++;
    return Response.json({ access: crypto.randomUUID(), refresh: "", expires: Date.now() + 600_000, status: "connected" });
  };
  try {
    const admin = createClient("https://database.example.test", crypto.randomUUID());
    const outcome = await callOAuthTier(admin, { provider: "openai", model }, initial, 1000, {
      enabled: async () => true, providerActive: async () => true, credentials: defaultCredentialDeps(admin),
      pi: { getModel: defaultPiCallDeps().getModel, complete: async () => { inference++; return { content: [{ type: "text", text: "Open" }], stopReason: "stop" }; } },
    });
    assertEquals("error" in outcome ? outcome.error : null, expected);
    assertEquals(credentialReads, expected ? 0 : 1);
    assertEquals(inference, expected ? 0 : 1);
  } finally { globalThis.fetch = original; }
});

Deno.test("Codex abort and deadline cancel only their own SSE request", async () => {
  const original = globalThis.fetch;
  const aborted: boolean[] = [];
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    const index = calls++;
    aborted[index] = false;
    if (index === 2) return sse({ text: "Recovered" });
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"pending"}}\n\n'));
      init?.signal?.addEventListener("abort", () => { aborted[index] = true; controller.error(new DOMException("Aborted", "AbortError")); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
  };
  try {
    const caller = new AbortController();
    const first = callPiOAuth(defaultPiCallDeps(), "openai-codex", model, initial, credential().token, 1000, caller.signal, { toolsEnabled: true });
    const timer = setTimeout(() => caller.abort(), 20);
    try { assert((await first).status !== 200); } finally { clearTimeout(timer); }
    const started = Date.now();
    assertEquals((await callPiOAuth(defaultPiCallDeps(), "openai-codex", model, initial, credential().token, 20, undefined, { toolsEnabled: true })).status, 504);
    assert(Date.now() - started < 500);
    assertEquals((await callPiOAuth(defaultPiCallDeps(), "openai-codex", model, initial, credential().token, 1000, undefined, { toolsEnabled: true })).status, 200);
    assertEquals(aborted.slice(0, 2), [true, true]);
    assertEquals(calls, 3);
  } finally { globalThis.fetch = original; }
});

Deno.test("Codex continuation rejects a reused native call identity even with a new item ID", async () => {
  const continuation = new OAuthContinuation();
  let calls = 0;
  const deps = { getModel: () => ({}), complete: async () => ({
    content: [{ type: "toolCall", id: `same_call|fc_${++calls}`, name: tool.function.name, arguments: { query: "hours" } }], stopReason: "toolUse",
  }) };
  const first = await callPiOAuth(deps, "openai-codex", model, initial, crypto.randomUUID(), 1000, undefined, { toolsEnabled: true, continuation });
  assertEquals(first.status, 200);
  const message = (await first.json()).choices[0].message;
  const messages = [...initial.messages, message, { role: "tool", tool_call_id: message.tool_calls[0].id, content: "Open" }];
  assertEquals(JSON.stringify(toToolContext({ messages }, "openai-codex", "different-model", continuation)).includes("same_call"), false);
  const replay = await callPiOAuth(deps, "openai-codex", model, { ...initial, messages }, crypto.randomUUID(), 1000, undefined, { toolsEnabled: true, continuation });
  assertEquals(replay.status, 422);
  assertEquals(await replay.json(), { error: { code: "response_invalid" } });
});
