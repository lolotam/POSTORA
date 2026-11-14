import { z } from "npm:zod@3.23.8";

export type ToolRefusal = "tools_unsupported" | "tool_history_unsupported" | "schema_unsupported" | "response_invalid";
export class ToolContractError extends Error {
  constructor(readonly code: ToolRefusal) { super(code); }
}
const jsonObject = z.record(z.unknown());
const callSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/), type: z.literal("function"),
  function: z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), arguments: z.string().max(32_768) }).strict() }).strict();
const messageSchema = z.object({ role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string().max(262_144), z.array(z.object({ type: z.literal("text"), text: z.string() }).strict()), z.null()]),
  tool_calls: z.array(callSchema).max(16).optional(), tool_call_id: z.string().optional(), is_error: z.boolean().optional(),
}).strict();
const definitionSchema = z.object({ type: z.literal("function"), function: z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), description: z.string().max(16_384),
  // Anthropic 0.73.1 projects exactly these root fields. Other root constraints
  // must be refused, rather than silently narrowed by its converter.
  parameters: z.object({ type: z.literal("object"), properties: jsonObject, required: z.array(z.string()).optional() }).strict(),
}).strict() }).strict();
export type FunctionTool = z.infer<typeof definitionSchema>;
export type ToolCall = z.infer<typeof callSchema>;
export type TranscriptMessage = z.infer<typeof messageSchema>;

/** OpenAI-compatible APIs add optional refusal/annotation/provider fields.
 * Only canonical assistant facts enter a cross-provider transcript. */
export function canonicalAssistant(raw: unknown): TranscriptMessage & { role: "assistant"; content: string | null } {
  const parsed = messageSchema.pick({ role: true, content: true, tool_calls: true }).extend({
    role: z.literal("assistant"), content: z.string().max(262_144).nullable(),
  }).strip().safeParse(raw);
  if (!parsed.success) throw new ToolContractError("response_invalid");
  return parsed.data;
}

export function hasToolHistory(body: Record<string, unknown>): boolean {
  return Array.isArray(body.messages) && body.messages.some(m => m && typeof m === "object" &&
    ((m as Record<string, unknown>).role === "tool" || (m as Record<string, unknown>).tool_calls !== undefined));
}
export function needsToolTransport(body: Record<string, unknown>): boolean {
  return body.tools !== undefined || body.tool_choice !== undefined || hasToolHistory(body);
}
export function parseArguments(text: string): Record<string, unknown> {
  try { return jsonObject.parse(JSON.parse(text)); }
  catch { throw new ToolContractError("tool_history_unsupported"); }
}
export function toolDefinitions(body: Record<string, unknown>): FunctionTool[] {
  if (JSON.stringify(body.tools ?? []).length > 262_144 || containsInferenceSecret(body.tools)) throw new ToolContractError("schema_unsupported");
  const result = z.array(definitionSchema).max(64).safeParse(body.tools ?? []);
  if (!result.success) throw new ToolContractError("schema_unsupported");
  const names = result.data.map(t => t.function.name);
  if (new Set(names).size !== names.length) throw new ToolContractError("schema_unsupported");
  for (const tool of result.data) {
    const schema = tool.function.parameters;
    if (schema.required?.some(key => !Object.hasOwn(schema.properties, key))) throw new ToolContractError("schema_unsupported");
  }
  return result.data;
}
export function validatedTranscript(body: Record<string, unknown>): TranscriptMessage[] {
  if (JSON.stringify(body.messages ?? []).length > 1_048_576) throw new ToolContractError("tool_history_unsupported");
  const result = z.array(messageSchema).min(1).max(256).safeParse(body.messages);
  if (!result.success) throw new ToolContractError("tool_history_unsupported");
  const ids = new Set<string>();
  const pending = new Map<string, string>();
  for (const message of result.data) {
    if (message.role === "tool") {
      if (containsInferenceSecret(message.content)) throw new ToolContractError("tool_history_unsupported");
      if (message.tool_calls || !message.tool_call_id || !pending.has(message.tool_call_id) || typeof message.content !== "string") throw new ToolContractError("tool_history_unsupported");
      pending.delete(message.tool_call_id);
      continue;
    }
    if (pending.size || message.tool_call_id || (message.tool_calls && message.role !== "assistant") || (message.content === null && !message.tool_calls?.length)) throw new ToolContractError("tool_history_unsupported");
    for (const call of message.tool_calls ?? []) {
      if (ids.has(call.id)) throw new ToolContractError("tool_history_unsupported");
      parseArguments(call.function.arguments);
      ids.add(call.id); pending.set(call.id, call.function.name);
    }
  }
  if (pending.size) throw new ToolContractError("tool_history_unsupported");
  return result.data;
}

/** Connector adapters already redact known credentials. This additional seam
 * refuses credential-shaped content rather than sending it to inference. */
export function containsInferenceSecret(value: unknown): boolean {
  if (typeof value === "string") return /(?:Bearer\s+\S+|\bsk-(?:ant-|proj-|or-)[A-Za-z0-9_-]+|(?:access_token|refresh_token|api_key|authorization|password|secret)\s*["']?\s*[:=]\s*["']?[^\s"',}]+)/i.test(value);
  if (Array.isArray(value)) return value.some(containsInferenceSecret);
  if (value && typeof value === "object") return Object.entries(value).some(([key, child]) =>
    /^(?:access_token|refresh_token|api_key|authorization|password|secret)$/i.test(key) || containsInferenceSecret(child));
  return false;
}

/** A server-only invocation object. Native provider blocks never enter the neutral transcript. */
export class OAuthContinuation {
  #turns = new Map<string, { provider: string; model: string; native: Record<string, unknown> }>();
  remember(provider: string, model: string, canonical: TranscriptMessage, native: Record<string, unknown>): void {
    this.#turns.set(JSON.stringify(canonical), { provider, model, native: structuredClone(native) });
  }
  lookup(provider: string, model: string, canonical: TranscriptMessage): Record<string, unknown> | undefined {
    const turn = this.#turns.get(JSON.stringify(canonical));
    return turn?.provider === provider && turn.model === model ? structuredClone(turn.native) : undefined;
  }
}
const text = (content: TranscriptMessage["content"]) => typeof content === "string" ? content : (content ?? []).map(p => p.text).join("");
const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

export function toToolContext(body: Record<string, unknown>, provider: string, model: string, continuation?: OAuthContinuation) {
  const transcript = validatedTranscript(body);
  const names = new Map<string, string>();
  const messages: Array<Record<string, unknown>> = [];
  for (const message of transcript) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      messages.push({ role: "toolResult", toolCallId: message.tool_call_id, toolName: names.get(message.tool_call_id!),
        content: [{ type: "text", text: text(message.content) }], isError: message.is_error ?? false, timestamp: Date.now() });
    } else if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) names.set(call.id, call.function.name);
      messages.push(continuation?.lookup(provider, model, message) ?? {
        role: "assistant", api: "anthropic-messages", provider, model, timestamp: Date.now(), usage: zeroUsage(),
        content: [...(text(message.content) ? [{ type: "text", text: text(message.content) }] : []),
          ...(message.tool_calls ?? []).map(call => ({ type: "toolCall", id: call.id, name: call.function.name, arguments: parseArguments(call.function.arguments) }))],
        stopReason: message.tool_calls?.length ? "toolUse" : "stop",
      });
    } else messages.push({ role: "user", content: text(message.content), timestamp: Date.now() });
  }
  const tools = toolDefinitions(body).map(t => ({ ...t.function }));
  return { systemPrompt: transcript.filter(m => m.role === "system").map(m => text(m.content)).join("\n\n") || undefined,
    messages, ...(tools.length ? { tools } : {}) };
}
