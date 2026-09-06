import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  callAnthropic,
  callAnthropicJson,
  fromAnthropicResponse,
  toAnthropicRequest,
} from "./anthropic-adapter.ts";

Deno.test("Anthropic extracts all system turns and drops deprecated sampling parameters", () => {
  const request = toAnthropicRequest({
    model: "claude-sonnet-5",
    temperature: 0.4,
    top_p: 0.8,
    tool_choice: "auto",
    messages: [{ role: "system", content: "one" }, {
      role: "system",
      content: "two",
    }, { role: "user", content: "hi" }],
  });
  assertEquals(request, {
    model: "claude-sonnet-5",
    max_tokens: 8192,
    system: "one\n\ntwo",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  });
  assertEquals(toAnthropicRequest({ max_tokens: 250 }).max_tokens, 250);
  assertThrows(
    () => toAnthropicRequest({ response_format: { type: "json_object" } }),
    Error,
    "response_format is not supported by the Anthropic adapter",
  );
});

Deno.test("agent multi-tool transcript preserves IDs, argument strings and tool result grouping", () => {
  const completion = fromAnthropicResponse({
    id: "msg_1",
    stop_reason: "tool_use",
    usage: { input_tokens: 12, output_tokens: 5 },
    content: [{ type: "text", text: "Looking up" }, {
      type: "tool_use",
      id: "toolu_A",
      name: "lookup",
      input: { q: "a" },
    }, { type: "tool_use", id: "toolu_B", name: "stock", input: { sku: 42 } }],
  });
  const assistant = completion.choices[0].message;
  assertEquals(
    assistant.tool_calls?.map((
      call,
    ) => [call.id, JSON.parse(call.function.arguments!)]),
    [["toolu_A", { q: "a" }], ["toolu_B", { sku: 42 }]],
  );
  const request = toAnthropicRequest({
    model: "claude-sonnet-5",
    temperature: 0.4,
    tools: [
      {
        type: "function",
        function: {
          name: "lookup",
          description: "Lookup",
          parameters: { type: "object" },
        },
      },
    ],
    tool_choice: "auto",
    messages: [
      { role: "system", content: "Agent" },
      { role: "user", content: "Find stock" },
      assistant,
      { role: "tool", tool_call_id: "toolu_A", content: "found" },
      { role: "tool", tool_call_id: "toolu_B", content: "available" },
    ],
  });
  assertEquals(request.tools, [{
    name: "lookup",
    description: "Lookup",
    input_schema: { type: "object" },
  }]);
  assertEquals(request.tool_choice, { type: "auto" });
  assertEquals(request.temperature, undefined);
  assertEquals(request.messages, [
    { role: "user", content: [{ type: "text", text: "Find stock" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "Looking up" }, {
        type: "tool_use",
        id: "toolu_A",
        name: "lookup",
        input: { q: "a" },
      }, {
        type: "tool_use",
        id: "toolu_B",
        name: "stock",
        input: { sku: 42 },
      }],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_A",
        content: "found",
      }, { type: "tool_result", tool_use_id: "toolu_B", content: "available" }],
    },
  ]);
});

Deno.test("adjacent user and assistant turns merge, images map, malformed tool arguments become empty", () => {
  const request = toAnthropicRequest({
    messages: [
      { role: "user", content: "hello" },
      {
        role: "user",
        content: [{ type: "text", text: "image" }, {
          type: "image_url",
          image_url: { url: "data:image/png;base64,YWJj" },
        }],
      },
      { role: "assistant", content: "checking" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          function: { name: "lookup", arguments: "bad json" },
        }],
      },
    ],
  });
  assertEquals(request.messages, [
    {
      role: "user",
      content: [{ type: "text", text: "hello" }, {
        type: "text",
        text: "image",
      }, {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "YWJj" },
      }],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "checking" }, {
        type: "tool_use",
        id: "call_1",
        name: "lookup",
        input: {},
      }],
    },
  ]);
});

Deno.test("text, tools, mixed responses and finish reasons use the frozen OpenAI shape", () => {
  for (
    const [stopReason, finishReason] of [["end_turn", "stop"], [
      "max_tokens",
      "length",
    ], ["tool_use", "tool_calls"]]
  ) {
    for (const mode of ["text", "tool", "mixed"]) {
      const content = [
        ...(mode !== "tool"
          ? [{ type: "text", text: "A" }, { type: "text", text: "B" }]
          : []),
        ...(mode !== "text"
          ? [{
            type: "tool_use",
            id: "verbatim:id",
            name: "lookup",
            input: { a: 1 },
          }]
          : []),
      ];
      const result = fromAnthropicResponse({
        id: "msg-id",
        stop_reason: stopReason,
        content,
        usage: { input_tokens: 10, output_tokens: 2 },
      });
      assertEquals(result, {
        id: "msg-id",
        choices: [{
          index: 0,
          finish_reason: finishReason,
          message: {
            role: "assistant",
            content: mode === "tool" ? "" : "AB",
            ...(mode !== "text"
              ? {
                tool_calls: [{
                  id: "verbatim:id",
                  type: "function",
                  function: { name: "lookup", arguments: '{"a":1}' },
                }],
              }
              : {}),
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      });
    }
  }
});

Deno.test("Anthropic preserves HTTP errors and redacts keys from JSON, Responses and thrown errors", async () => {
  const original = globalThis.fetch;
  const key = "test-secret-never-expose";
  try {
    for (const status of [401, 529]) {
      globalThis.fetch = async (url, init) => {
        assertEquals(url, "https://api.anthropic.com/v1/messages");
        const headers = new Headers(init?.headers);
        assertEquals(headers.get("x-api-key"), key);
        assertEquals(headers.get("anthropic-version"), "2023-06-01");
        return new Response(
          JSON.stringify({ error: { message: `Rejected ${key}` } }),
          { status },
        );
      };
      const result = await callAnthropicJson({}, key, 100);
      assertEquals(result.status, status);
      assertEquals(JSON.stringify(result.json).includes(key), false);
      const response = await callAnthropic({}, key, 100);
      assertEquals(response.status, status);
      assertEquals((await response.text()).includes(key), false);
    }
    globalThis.fetch = () => Promise.reject(new Error(`network failed ${key}`));
    const thrown = await assertRejects(
      () => callAnthropicJson({}, key, 100),
      Error,
    );
    assertEquals(thrown.message.includes(key), false);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("Anthropic deadline covers a hanging response body", async () => {
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
    await assertRejects(() => callAnthropicJson({}, "test-key", 10), Error);
    assertEquals(signal?.aborted, true);
  } finally {
    globalThis.fetch = original;
  }
});
