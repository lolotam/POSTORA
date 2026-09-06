import { redactProviderError } from "./ai-routing-errors.ts";

type JsonRecord = Record<string, unknown>;
export const DEFAULT_MAX_TOKENS = 8192;
function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function contentBlocks(content: unknown): JsonRecord[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  return content.flatMap((part): JsonRecord[] => {
    const block = record(part);
    if (block.type === "text") return [{ type: "text", text: block.text }];
    if (block.type === "image_url") {
      const url = record(block.image_url).url;
      const match = typeof url === "string" &&
        /^data:([^;]+);base64,(.+)$/s.exec(url);
      if (match) {
        return [{
          type: "image",
          source: { type: "base64", media_type: match[1], data: match[2] },
        }];
      }
      throw new Error("Anthropic images require a base64 data URL");
    }
    return [];
  });
}

function toolUse(call: unknown): JsonRecord {
  const tool = record(call);
  const fn = record(tool.function);
  let input: unknown = {};
  try {
    input = JSON.parse(String(fn.arguments ?? "{}"));
  } catch {
    /* Invalid arguments follow the agent's empty-object convention. */
  }
  return { type: "tool_use", id: tool.id, name: fn.name, input };
}

export function toAnthropicRequest(openAiBody: JsonRecord): JsonRecord {
  if ("response_format" in openAiBody) {
    throw new Error(
      "response_format is not supported by the Anthropic adapter",
    );
  }
  const system: string[] = [];
  const messages: { role: string; content: JsonRecord[] }[] = [];
  for (
    const entry of Array.isArray(openAiBody.messages) ? openAiBody.messages : []
  ) {
    const message = record(entry);
    if (message.role === "system") {
      system.push(
        contentBlocks(message.content).map((block) => block.text ?? "").join(
          "",
        ),
      );
      continue;
    }
    const role = message.role === "assistant" ? "assistant" : "user";
    const content = message.role === "tool"
      ? [{
        type: "tool_result",
        tool_use_id: message.tool_call_id,
        content: message.content ?? "",
      }]
      : contentBlocks(message.content);
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      content.push(...message.tool_calls.map(toolUse));
    }
    const previous = messages[messages.length - 1];
    if (previous?.role === role) previous.content.push(...content);
    else messages.push({ role, content });
  }
  // Anthropic requires max_tokens; OpenAI-shaped callers here never send one.
  // 1024 truncated brand intelligence (10 captions + 10 image prompts + 10
  // video outlines) with a 200 and stop_reason max_tokens, which the chain
  // reads as success. 8192 fits every current caller and is well under the
  // seeded models' output ceilings (64K on Haiku 4.5, 128K on Sonnet/Opus 5).
  const request: JsonRecord = {
    model: openAiBody.model,
    max_tokens: openAiBody.max_tokens ?? DEFAULT_MAX_TOKENS,
    messages,
  };
  if (system.length) request.system = system.join("\n\n");
  if (Array.isArray(openAiBody.tools) && openAiBody.tools.length) {
    request.tools = openAiBody.tools.map((tool) => {
      const fn = record(record(tool).function);
      return {
        name: fn.name,
        description: fn.description,
        input_schema: fn.parameters,
      };
    });
    if (openAiBody.tool_choice === "auto") {
      request.tool_choice = { type: "auto" };
    }
  }
  return request;
}

export function fromAnthropicResponse(json: unknown) {
  const response = record(json);
  const blocks = (Array.isArray(response.content) ? response.content : []).map(
    record,
  );
  const toolCalls = blocks.filter((block) => block.type === "tool_use").map((
    block,
  ) => ({
    id: block.id,
    type: "function",
    function: { name: block.name, arguments: JSON.stringify(block.input) },
  }));
  const usage = record(response.usage);
  const promptTokens = Number(usage.input_tokens ?? 0);
  const completionTokens = Number(usage.output_tokens ?? 0);
  return {
    id: response.id,
    choices: [{
      index: 0,
      finish_reason: response.stop_reason === "tool_use"
        ? "tool_calls"
        : response.stop_reason === "max_tokens"
        ? "length"
        : "stop",
      message: {
        role: "assistant",
        content: blocks.filter((block) => block.type === "text").map((block) =>
          block.text
        ).join(""),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

export async function callAnthropicJson(
  openAiBody: JsonRecord,
  apiKey: string,
  timeoutMs: number,
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Anthropic request timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      deadline,
      (async () => {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          signal: controller.signal,
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify(toAnthropicRequest(openAiBody)),
        });
        const body = await response.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          if (response.ok) throw new Error("Invalid Anthropic response");
        }
        const message = record(record(parsed).error).message;
        return {
          status: response.status,
          json: response.ok ? fromAnthropicResponse(parsed) : {
            error: {
              message: redactProviderError(
                typeof message === "string"
                  ? message
                  : "Anthropic request failed",
                apiKey,
              ),
            },
          },
        };
      })(),
    ]);
  } catch (error) {
    throw new Error(
      redactProviderError(
        error instanceof Error ? error.message : "Anthropic request failed",
        apiKey,
      ),
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function callAnthropic(
  openAiBody: JsonRecord,
  apiKey: string,
  timeoutMs: number,
): Promise<Response> {
  const { status, json } = await callAnthropicJson(
    openAiBody,
    apiKey,
    timeoutMs,
  );
  return new Response(JSON.stringify(json), {
    status,
    headers: { "content-type": "application/json" },
  });
}
