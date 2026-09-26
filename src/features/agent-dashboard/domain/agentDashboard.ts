/**
 * The AI Agent dashboard's domain: the shape of the `ai_agent_dashboard` RPC document,
 * its validation, and the arithmetic done in the browser.
 *
 * De-duplication, grouping, median and p90 are done in SQL (migration
 * 20260926100000_ai_agent_dashboard.sql, proven by supabase/tests/ai_agent_dashboard.sql):
 * percentiles cannot be merged after the fact, so the browser never recomputes them.
 * What is left here is division with honest empty cases and the cost estimate.
 */

export interface OutcomeCounts {
  /** Work items: rows sharing an idempotency_key count once. Sandbox runs excluded. */
  items: number;
  /** Sent, and no escalate_to_human call. Not "resolved": nobody confirmed the answer helped. */
  answered: number;
  escalated: number;
  skipped: number;
  errors: number;
  /** Any status the dashboard does not know, so nothing disappears silently. */
  other: number;
  /** Over sent replies only; null when there were none. */
  latencyP50Ms: number | null;
  latencyP90Ms: number | null;
  fastPath: number;
  triaged: number;
  /** Per attempt, not per work item: every attempt that reached a model was billed. */
  promptTokens: number;
  completionTokens: number;
}

export interface AccountOutcomeCounts extends OutcomeCounts {
  platform: string | null;
  /** Null for rows logged before the dashboard columns existed. */
  socialAccountId: string | null;
}

export interface ModelUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
}

export interface AgentDashboard {
  days: number;
  since: string;
  totals: OutcomeCounts;
  accounts: AccountOutcomeCounts[];
  skipReasons: Array<{ reason: string; count: number }>;
  intents: Array<{ intent: string; count: number }>;
  models: ModelUsage[];
}

/** One row of the public `ai_models` catalogue. Prices are USD per million tokens. */
export interface ModelPrice {
  model_id: string;
  cost_per_1m_input_tokens: number | null;
  cost_per_1m_output_tokens: number | null;
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(source: Obj, key: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`ai_agent_dashboard: "${key}" is not a number`);
  }
  return value;
}

function numOrNull(source: Obj, key: string): number | null {
  return source[key] === null || source[key] === undefined ? null : num(source, key);
}

function str(source: Obj, key: string): string {
  const value = source[key];
  if (typeof value !== "string") throw new Error(`ai_agent_dashboard: "${key}" is not a string`);
  return value;
}

function strOrNull(source: Obj, key: string): string | null {
  return source[key] === null || source[key] === undefined ? null : str(source, key);
}

function list(source: Obj, key: string): Obj[] {
  const value = source[key];
  if (!Array.isArray(value) || !value.every(isObj)) {
    throw new Error(`ai_agent_dashboard: "${key}" is not a list of objects`);
  }
  return value;
}

function parseCounts(source: unknown): OutcomeCounts {
  if (!isObj(source)) throw new Error("ai_agent_dashboard: counts are not an object");
  return {
    items: num(source, "items"),
    answered: num(source, "answered"),
    escalated: num(source, "escalated"),
    skipped: num(source, "skipped"),
    errors: num(source, "errors"),
    other: num(source, "other"),
    latencyP50Ms: numOrNull(source, "latency_p50_ms"),
    latencyP90Ms: numOrNull(source, "latency_p90_ms"),
    fastPath: num(source, "fast_path"),
    triaged: num(source, "triaged"),
    promptTokens: num(source, "prompt_tokens"),
    completionTokens: num(source, "completion_tokens"),
  };
}

/** Validates the RPC's jsonb. A wrong shape throws: rendering it as zeros would lie. */
export function parseAgentDashboard(raw: unknown): AgentDashboard {
  if (!isObj(raw)) throw new Error("ai_agent_dashboard: response is not an object");
  return {
    days: num(raw, "days"),
    since: str(raw, "since"),
    totals: parseCounts(raw.totals),
    accounts: list(raw, "accounts").map((row) => ({
      ...parseCounts(row),
      platform: strOrNull(row, "platform"),
      socialAccountId: strOrNull(row, "social_account_id"),
    })),
    skipReasons: list(raw, "skip_reasons").map((row) => ({ reason: str(row, "reason"), count: num(row, "count") })),
    intents: list(raw, "intents").map((row) => ({ intent: str(row, "intent"), count: num(row, "count") })),
    models: list(raw, "models").map((row) => ({
      model: str(row, "model"),
      promptTokens: num(row, "prompt_tokens"),
      completionTokens: num(row, "completion_tokens"),
    })),
  };
}

/** part / whole, or null when there is nothing to divide by (shown as "—", not 0%). */
export function share(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** Fast-path turns over the turns triage actually decided. */
export function fastPathShare(counts: Pick<OutcomeCounts, "fastPath" | "triaged">): number | null {
  return share(counts.fastPath, counts.triaged);
}

/** The catalogue price for a logged `provider/model`, or null when absent or ambiguous. */
function priceFor(model: string, prices: ModelPrice[]): { input: number; output: number } | null {
  const slash = model.indexOf("/");
  const bare = slash > 0 ? model.slice(slash + 1) : model;
  const distinct = new Map<string, { input: number; output: number }>();
  for (const row of prices) {
    if (row.model_id !== model && row.model_id !== bare) continue;
    if (row.cost_per_1m_input_tokens === null || row.cost_per_1m_output_tokens === null) continue;
    const input = Number(row.cost_per_1m_input_tokens);
    const output = Number(row.cost_per_1m_output_tokens);
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) continue;
    distinct.set(`${input}:${output}`, { input, output });
  }
  // Two catalogue rows (e.g. two providers) with different prices: refuse to guess.
  return distinct.size === 1 ? [...distinct.values()][0] : null;
}

export interface CostEstimate {
  /** USD for the priced share of tokens only; null when nothing could be priced. */
  usd: number | null;
  /** Fraction of all logged tokens that had a catalogue price; null when no tokens. */
  pricedShare: number | null;
}

/**
 * An estimate from the admin-maintained `ai_models` catalogue, never an invented price.
 * Only models with an unambiguous catalogue entry are priced; the rest are reported
 * through `pricedShare` rather than silently assumed free.
 */
export function estimateCost(models: ModelUsage[], prices: ModelPrice[]): CostEstimate {
  let usd = 0;
  let pricedTokens = 0;
  let totalTokens = 0;
  for (const usage of models) {
    const tokens = usage.promptTokens + usage.completionTokens;
    totalTokens += tokens;
    const price = priceFor(usage.model, prices);
    if (!price) continue;
    pricedTokens += tokens;
    usd += (usage.promptTokens * price.input + usage.completionTokens * price.output) / 1_000_000;
  }
  return {
    usd: pricedTokens > 0 ? usd : null,
    pricedShare: share(pricedTokens, totalTokens),
  };
}
