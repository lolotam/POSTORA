import { readOnlyConnector, ModelChainExhaustedError } from "./logic.ts";
import { WAITLIST_FOLLOW_UP } from "./procedureRuntime.ts";
import type { CustomTool, ToolResult } from "./tools.ts";

export type ActionSafety = { kind: "read" } | { kind: "mutation"; guarantee: "durable_upsert"; effectArguments: readonly string[] };
/** Positive allowlist. A connector's generic write flag is not an idempotency guarantee. */
export function authActionSafety(name: string, customTools: ReadonlyMap<string, CustomTool>): ActionSafety | null {
  if (["search_knowledge", "web_search", "list_connected_accounts", "search_posts", "get_posting_summary"].includes(name)) return { kind: "read" };
  if (name === "stock_waitlist_join") return { kind: "mutation", guarantee: "durable_upsert", effectArguments: ["product_id"] };
  const custom = customTools.get(name);
  return custom && readOnlyConnector(custom) ? { kind: "read" } : null;
}

function canonical(value: unknown, ignored: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map(v => canonical(v, ignored));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !ignored.has(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v, ignored)]));
  return value;
}
const NONCES = ["nonce", "request_id", "requestId", "request_key", "requestKey", "idempotency_key", "idempotencyKey", "client_request_id"];

/** Invocation-owned receipts. An uncertain action is terminal, never retried. */
export class AuthActionLedger {
  #receipts = new Map<string, { state: "unknown" } | { state: "complete"; result: ToolResult }>();
  constructor(private readonly invocation: string, private readonly log: (code: string) => void | Promise<void>) {}
  async execute(name: string, args: Record<string, unknown>, safety: ActionSafety | null, run: () => Promise<ToolResult>): Promise<ToolResult> {
    if (!safety) throw new ModelChainExhaustedError("oauth_tool_safety_unsupported");
    if (safety.kind === "read") return run();
    const effectArguments = Object.fromEntries(safety.effectArguments.filter(key => Object.hasOwn(args, key)).map(key => [key, args[key]]));
    // Match the existing executor's String(args.product_id ?? "") exactly:
    // changing JSON number/string representation must not mint a new action.
    if (name === "stock_waitlist_join") effectArguments.product_id = String(args.product_id ?? "");
    const identity = JSON.stringify([this.invocation, name, canonical(effectArguments, new Set(NONCES))]);
    const receipt = this.#receipts.get(identity);
    if (receipt?.state === "complete") { await this.log("oauth_duplicate_action_suppressed"); return structuredClone(receipt.result); }
    if (receipt) throw new ModelChainExhaustedError("oauth_action_outcome_unknown");
    this.#receipts.set(identity, { state: "unknown" });
    try {
      const result = await run();
      if (name === "stock_waitlist_join" && result.output === WAITLIST_FOLLOW_UP) throw new Error();
      this.#receipts.set(identity, { state: "complete", result: structuredClone(result) });
      return result;
    } catch {
      await this.log("oauth_action_outcome_unknown");
      throw new ModelChainExhaustedError("oauth_action_outcome_unknown");
    }
  }
}
