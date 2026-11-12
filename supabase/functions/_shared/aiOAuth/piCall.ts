import { complete, getModel } from "npm:@mariozechner/pi-ai@0.73.1";
import { redactProviderError } from "../ai-routing-errors.ts";
import type { OAuthProviderId } from "./clients.ts";

/**
 * The slice of pi-ai's AssistantMessage callPiOAuth depends on. The full type
 * carries provider-internal fields (api, provider, model, cost) this adapter
 * never reads.
 */
export interface PiAssistant {
  content: Array<{ type: string; text?: string }>;
  stopReason: string;
  errorMessage?: string;
  usage?: { input: number; output: number; totalTokens: number };
}

export interface PiCallDeps {
  getModel: (provider: string, modelId: string) => unknown | undefined;
  complete: (
    model: unknown,
    context: unknown,
    options: { apiKey: string; signal: AbortSignal; temperature?: number; maxTokens?: number },
  ) => Promise<PiAssistant>;
}

export function defaultPiCallDeps(): PiCallDeps {
  return {
    // Infrastructure seam (ARCHITECTURE §31): pi-ai types the provider key as a
    // narrow KnownProvider union; the deps seam keeps it a string so tests can
    // inject any registry. The mapped shapes are pinned by piCall.test.ts.
    getModel: (provider, modelId) => getModel(provider as never, modelId),
    complete: async (model, context, options) =>
      (await complete(model as never, context as never, options)) as unknown as PiAssistant,
  };
}

interface OpenAiMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}

function flattenContent(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
}

/** Zero-cost usage for synthesized history turns; pi's Usage requires every field. */
function zeroUsage(): Record<string, number> {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costInput: 0,
    costOutput: 0,
  };
}

/** Converts the OpenAI-shaped chat body into a pi-ai Context. */
function toPiContext(openAiBody: Record<string, unknown>): {
  systemPrompt?: string;
  messages: Array<Record<string, unknown>>;
} {
  const rawMessages = Array.isArray(openAiBody.messages) ? openAiBody.messages as OpenAiMessage[] : [];
  const systemParts: string[] = [];
  const messages: Array<Record<string, unknown>> = [];
  for (const raw of rawMessages) {
    const text = flattenContent(raw.content);
    if (raw.role === "system") {
      systemParts.push(text);
      continue;
    }
    if (raw.role === "assistant") {
      messages.push({
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason: "stop",
        usage: zeroUsage(),
        timestamp: Date.now(),
      });
      continue;
    }
    messages.push({ role: "user", content: text, timestamp: Date.now() });
  }
  return { systemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined, messages };
}

function openAiShape(text: string, usage: PiAssistant["usage"]): string {
  const input = usage?.input ?? 0;
  const output = usage?.output ?? 0;
  return JSON.stringify({
    choices: [{ message: { role: "assistant", content: text } }],
    usage: {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: usage?.totalTokens ?? input + output,
    },
  });
}

function errorShape(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Runs one OAuth-tier chat request through pi-ai and returns an OpenAI-shaped
 * Response, mirroring how callAnthropic keeps the shape at every call site.
 * Never throws: every failure mode becomes a Response, and every message is
 * redacted against the api key.
 */
export async function callPiOAuth(
  deps: PiCallDeps,
  provider: OAuthProviderId,
  modelId: string,
  openAiBody: Record<string, unknown>,
  apiKey: string,
  timeoutMs: number,
): Promise<Response> {
  // Tool calling is out of scope for subscription tiers (spec §4): refuse
  // without a network call so the chain falls over to the next tier.
  if (openAiBody.tools !== undefined) {
    return new Response(null, { status: 422 });
  }

  const model = deps.getModel(provider, modelId);
  if (!model) return errorShape(`unknown model ${modelId} for ${provider}`, 424);

  try {
    const assistant = await deps.complete(model, toPiContext(openAiBody), {
      apiKey,
      signal: AbortSignal.timeout(timeoutMs),
      temperature: typeof openAiBody.temperature === "number" ? openAiBody.temperature : undefined,
      maxTokens: typeof openAiBody.max_tokens === "number" ? openAiBody.max_tokens : undefined,
    });

    if (assistant.stopReason === "error" || assistant.errorMessage) {
      const message = assistant.errorMessage ?? `pi-ai completed with stopReason ${assistant.stopReason}`;
      return errorShape(redactProviderError(message, apiKey), 502);
    }

    const text = assistant.content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("");
    return new Response(openAiShape(text, assistant.usage), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (cause) {
    const name = cause instanceof Error ? cause.name : "";
    const status = name === "TimeoutError" ? 504 : 502;
    const message = cause instanceof Error ? cause.message : "pi-ai request failed";
    return errorShape(redactProviderError(`${message} (status ${status})`, apiKey), status);
  }
}
