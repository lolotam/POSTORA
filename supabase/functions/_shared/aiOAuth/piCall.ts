import { complete, stream, getModel } from "npm:@mariozechner/pi-ai@0.73.1";
import { redactProviderError } from "../ai-routing-errors.ts";
import { supportsOAuthToolTransport, type OAuthProviderId } from "./clients.ts";
import { needsToolTransport, OAuthContinuation, parseArguments, ToolContractError, toolDefinitions, toToolContext, validatedTranscript, type TranscriptMessage } from "./toolTranscript.ts";

/**
 * The slice of pi-ai's AssistantMessage callPiOAuth depends on. The full type
 * carries provider-internal fields (api, provider, model, cost) this adapter
 * never reads.
 */
export interface PiAssistant {
  content: Array<{ type: string; text?: string; id?: string; name?: string; arguments?: unknown }>;
  stopReason: string;
  errorMessage?: string;
  /** pi-ai reports cached prompt tokens apart from `input`. */
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; totalTokens: number };
}

export interface PiCallDeps {
  getModel: (provider: string, modelId: string) => unknown | undefined;
  complete: (
    model: unknown,
    context: unknown,
    options: { apiKey: string; signal: AbortSignal; temperature?: number; maxTokens?: number; maxRetries?: number },
  ) => Promise<PiAssistant>;
}

export function defaultPiCallDeps(): PiCallDeps {
  return {
    // Infrastructure seam (ARCHITECTURE §31): pi-ai types the provider key as a
    // narrow KnownProvider union; the deps seam keeps it a string so tests can
    // inject any registry. The mapped shapes are pinned by piCall.test.ts.
    getModel: (provider, modelId) => getModel(provider as never, modelId),
    complete: async (model, context, options) => {
      if ((model as { provider?: string }).provider !== "anthropic") return await complete(model as never, context as never, options) as unknown as PiAssistant;
      // Read native events, not repaired final arguments. pi-ai deliberately
      // repairs partial JSON; an executor must never act on that repair.
      const controller = new AbortController();
      const signal = AbortSignal.any([options.signal, controller.signal]);
      const events = stream(model as never, context as never, { ...options, signal, maxRetries: 0 });
      try {
      const argumentsByIndex = new Map<number, string>();
      let bytes = 0;
      let started = false;
      let final: PiAssistant | undefined;
      for await (const event of events) {
        options.signal.throwIfAborted();
        if (event.type === "start") started = true;
        if ("delta" in event) {
          bytes += new TextEncoder().encode(event.delta).length;
          if (bytes > 1_048_576) throw new ToolContractError("response_invalid");
        }
        if (event.type === "toolcall_delta") argumentsByIndex.set(event.contentIndex, (argumentsByIndex.get(event.contentIndex) ?? "") + event.delta);
        if (event.type === "toolcall_end") {
          const raw = argumentsByIndex.get(event.contentIndex);
          if (raw !== undefined) {
            let parsed: unknown;
            try { parsed = JSON.parse(raw); } catch { throw new ToolContractError("response_invalid"); }
            if (JSON.stringify(parsed) !== JSON.stringify(event.toolCall.arguments)) throw new ToolContractError("response_invalid");
          }
        }
        if (event.type === "error") throw new ToolContractError("response_invalid");
        if (event.type === "done") final = event.message as unknown as PiAssistant;
      }
      if (!started || !final) throw new ToolContractError("response_invalid");
      return final;
      } finally { controller.abort(); }
    },
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
  // OpenAI's prompt_tokens counts every prompt token, cached or not.
  const input = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
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

/** The request needs something this subscription tier cannot honour; the chain skips the tier. */
type UnsupportedReason = "tools_unsupported" | "max_tokens_unsupported" | "tool_history_unsupported" | "schema_unsupported" | "response_invalid";

function unsupported(reason: UnsupportedReason): Response {
  return new Response(JSON.stringify({ error: { code: reason } }), {
    status: 422,
    headers: { "content-type": "application/json" },
  });
}

/** The caller's output cap, under either name chatRequestForTier may have left it. */
function outputTokenLimit(openAiBody: Record<string, unknown>): number | undefined {
  const limit = openAiBody.max_tokens ?? openAiBody.max_completion_tokens;
  return typeof limit === "number" ? limit : undefined;
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
  outerSignal?: AbortSignal,
  options: { toolsEnabled?: boolean; continuation?: OAuthContinuation } = {},
): Promise<Response> {
  // Only the server-authorized Claude transport may carry tool work. Preflight
  // runs before model/provider I/O; callers cannot enable it through the body.
  const toolMode = needsToolTransport(openAiBody) || options.toolsEnabled === true;
  const refusal = preflightPiRequest(provider, openAiBody, options.toolsEnabled === true);
  if (refusal) return unsupported(refusal);
  // pi-ai 0.73.1's Codex request builder never serializes maxTokens, so a cap
  // the caller relies on would be silently ignored. Refuse instead.
  const maxTokens = outputTokenLimit(openAiBody);
  if (provider === "openai-codex" && maxTokens !== undefined) return unsupported("max_tokens_unsupported");

  const model = deps.getModel(provider, modelId);
  if (!model) return errorShape(`unknown model ${modelId} for ${provider}`, 424);

  try {
    const signal = outerSignal ? AbortSignal.any([outerSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    signal.throwIfAborted();
    const work = deps.complete(model, toolMode ? toToolContext(openAiBody, provider, modelId, options.continuation) : toPiContext(openAiBody), {
      apiKey,
      // The caller's budget and the request's own timeout: the tighter one wins.
      signal,
      temperature: typeof openAiBody.temperature === "number" ? openAiBody.temperature : undefined,
      maxTokens,
      maxRetries: 0,
    });
    const assistant = await raceSignal(work, signal);
    signal.throwIfAborted();

    if (toolMode) {
      const message = validatedAssistant(assistant, openAiBody);
      options.continuation?.remember(provider, modelId, message, assistant as unknown as Record<string, unknown>);
      const shaped = JSON.parse(openAiShape("", assistant.usage));
      shaped.choices = [{ message, finish_reason: assistant.stopReason === "toolUse" ? "tool_calls" : "stop" }];
      return Response.json(shaped);
    }

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
    if (cause instanceof ToolContractError) return unsupported(cause.code);
    const name = cause instanceof Error ? cause.name : "";
    const status = name === "TimeoutError" ? 504 : 502;
    const message = cause instanceof Error ? cause.message : "pi-ai request failed";
    return errorShape(redactProviderError(`${message} (status ${status})`, apiKey), status);
  }
}

export function preflightPiRequest(provider: OAuthProviderId, body: Record<string, unknown>, enabled: boolean): UnsupportedReason | null {
  if (provider === "openai-codex" && outputTokenLimit(body) !== undefined) return "max_tokens_unsupported";
  if (!needsToolTransport(body)) return null;
  if (!supportsOAuthToolTransport(provider) || !enabled) return "tools_unsupported";
  if (body.tool_choice !== undefined && body.tool_choice !== "auto") return "tools_unsupported";
  const supported = new Set(["model", "messages", "tools", "tool_choice", "temperature", "max_tokens", "max_completion_tokens"]);
  if (Object.keys(body).some(key => !supported.has(key))) return "schema_unsupported";
  try { toolDefinitions(body); validatedTranscript(body); }
  catch (cause) { return cause instanceof ToolContractError ? cause.code : "schema_unsupported"; }
  return null;
}

function validatedAssistant(assistant: PiAssistant, body: Record<string, unknown>): TranscriptMessage {
  if (!["stop", "toolUse"].includes(assistant.stopReason) || assistant.errorMessage || !Array.isArray(assistant.content)) throw new ToolContractError("response_invalid");
  if (assistant.usage && [assistant.usage.input, assistant.usage.output, assistant.usage.cacheRead, assistant.usage.cacheWrite, assistant.usage.totalTokens].filter(value => value !== undefined).some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new ToolContractError("response_invalid");
  const ids = new Set<string>();
  const history = validatedTranscript(body);
  const oldIds = new Set(history.flatMap(m => m.tool_calls?.map(c => c.id) ?? []));
  const allowed = new Set(toolDefinitions(body).map(t => t.function.name));
  const calls = [];
  let text = "";
  for (const part of assistant.content) {
    if (part.type === "text" && typeof part.text === "string") text += part.text;
    else if (part.type === "thinking") continue; // Native only, kept in the sidecar.
    else if (part.type === "toolCall" && typeof part.id === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(part.id) && typeof part.name === "string" && allowed.has(part.name) && !ids.has(part.id) && !oldIds.has(part.id)) {
      try {
        const args = JSON.stringify(part.arguments);
        if (!args || args.length > 32_768) throw new Error();
        parseArguments(args);
        calls.push({ id: part.id, type: "function" as const, function: { name: part.name, arguments: args } });
        ids.add(part.id);
      } catch { throw new ToolContractError("response_invalid"); }
    } else throw new ToolContractError("response_invalid");
  }
  if (calls.length > 16 || (assistant.stopReason === "toolUse") !== (calls.length > 0) || (!calls.length && !text.trim()) || text.length > 262_144) throw new ToolContractError("response_invalid");
  return { role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) };
}

export function raceSignal<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { Promise.resolve(work).catch(() => {}); reject(signal.reason); return; }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
