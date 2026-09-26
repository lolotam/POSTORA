import { describe, expect, it } from "vitest";
import {
  estimateCost,
  fastPathShare,
  parseAgentDashboard,
  share,
  type ModelPrice,
} from "../agentDashboard";

const counts = {
  items: 8,
  answered: 3,
  escalated: 2,
  skipped: 3,
  errors: 0,
  other: 0,
  latency_p50_ms: 2500,
  latency_p90_ms: 3700,
  fast_path: 2,
  triaged: 4,
  prompt_tokens: 1000,
  completion_tokens: 140,
};

const document = {
  days: 7,
  since: "2026-09-19T10:00:00+00:00",
  platform: "whatsapp",
  totals: counts,
  accounts: [{ ...counts, platform: "whatsapp", social_account_id: "acct-1" }],
  skip_reasons: [{ reason: "human_assigned", count: 2 }],
  intents: [{ intent: "pricing", count: 2 }],
  models: [{ model: "openrouter/openai/gpt-4o-mini", prompt_tokens: 600, completion_tokens: 90 }],
};

describe("parseAgentDashboard", () => {
  it("maps the RPC document to camelCase", () => {
    const parsed = parseAgentDashboard(document);
    expect(parsed.totals).toMatchObject({ items: 8, answered: 3, latencyP50Ms: 2500, latencyP90Ms: 3700, promptTokens: 1000 });
    expect(parsed.accounts[0]).toMatchObject({ platform: "whatsapp", socialAccountId: "acct-1", answered: 3 });
    expect(parsed.skipReasons).toEqual([{ reason: "human_assigned", count: 2 }]);
    expect(parsed.intents).toEqual([{ intent: "pricing", count: 2 }]);
    expect(parsed.models).toEqual([{ model: "openrouter/openai/gpt-4o-mini", promptTokens: 600, completionTokens: 90 }]);
  });

  it("keeps null latency when there were no sent replies, and a null account id for pre-tracking rows", () => {
    const parsed = parseAgentDashboard({
      ...document,
      totals: { ...counts, latency_p50_ms: null, latency_p90_ms: null },
      accounts: [{ ...counts, platform: "facebook", social_account_id: null }],
    });
    expect(parsed.totals.latencyP50Ms).toBeNull();
    expect(parsed.accounts[0].socialAccountId).toBeNull();
  });

  it("accepts an empty window", () => {
    const parsed = parseAgentDashboard({
      ...document,
      totals: { ...counts, items: 0, answered: 0, escalated: 0, skipped: 0, fast_path: 0, triaged: 0 },
      accounts: [],
      skip_reasons: [],
      intents: [],
      models: [],
    });
    expect(parsed.accounts).toEqual([]);
    expect(parsed.totals.items).toBe(0);
  });

  it("rejects a document that is not the RPC's shape instead of rendering zeros", () => {
    expect(() => parseAgentDashboard(null)).toThrow();
    expect(() => parseAgentDashboard({ ...document, totals: { ...counts, items: "8" } })).toThrow(/items/);
    expect(() => parseAgentDashboard({ ...document, accounts: "none" })).toThrow(/accounts/);
  });
});

describe("share", () => {
  it("is null when there is nothing to divide by, never NaN or 0%", () => {
    expect(share(0, 0)).toBeNull();
    expect(share(3, 0)).toBeNull();
  });

  it("is the plain ratio otherwise", () => {
    expect(share(3, 8)).toBe(0.375);
    expect(share(1, 1)).toBe(1);
  });
});

describe("fastPathShare", () => {
  it("divides by the turns triage decided, not by every reply", () => {
    expect(fastPathShare({ fastPath: 2, triaged: 4 })).toBe(0.5);
  });

  it("is null when triage never ran", () => {
    expect(fastPathShare({ fastPath: 0, triaged: 0 })).toBeNull();
  });
});

describe("estimateCost", () => {
  const price = (model_id: string, input: number | null, output: number | null): ModelPrice => ({
    model_id,
    cost_per_1m_input_tokens: input,
    cost_per_1m_output_tokens: output,
  });

  it("prices a model whose catalogue id is the part after the provider prefix", () => {
    const result = estimateCost(
      [{ model: "openrouter/openai/gpt-4o-mini", promptTokens: 1_000_000, completionTokens: 500_000 }],
      [price("openai/gpt-4o-mini", 0.15, 0.6)],
    );
    expect(result.usd).toBeCloseTo(0.15 + 0.3, 10);
    expect(result.pricedShare).toBe(1);
  });

  it("also matches the full provider/model string", () => {
    const result = estimateCost(
      [{ model: "openai/gpt-4o", promptTokens: 2_000_000, completionTokens: 0 }],
      [price("openai/gpt-4o", 2.5, 10)],
    );
    expect(result.usd).toBeCloseTo(5, 10);
  });

  it("refuses to guess when two catalogue rows match with different prices", () => {
    const result = estimateCost(
      [{ model: "openrouter/gpt-4o", promptTokens: 100, completionTokens: 100 }],
      [price("gpt-4o", 2.5, 10), price("gpt-4o", 5, 15)],
    );
    expect(result.usd).toBeNull();
    expect(result.pricedShare).toBe(0);
  });

  it("treats duplicate rows with the same price as one price", () => {
    const result = estimateCost(
      [{ model: "openai/gpt-4o", promptTokens: 1_000_000, completionTokens: 0 }],
      [price("gpt-4o", 2.5, 10), price("gpt-4o", 2.5, 10)],
    );
    expect(result.usd).toBeCloseTo(2.5, 10);
  });

  it("ignores a catalogue row missing either price", () => {
    const result = estimateCost(
      [{ model: "openai/gpt-4o", promptTokens: 100, completionTokens: 100 }],
      [price("gpt-4o", 2.5, null)],
    );
    expect(result.usd).toBeNull();
  });

  it("reports how much of the token volume was priced when only some models are", () => {
    const result = estimateCost(
      [
        { model: "openai/gpt-4o", promptTokens: 750, completionTokens: 0 },
        { model: "zai/unknown-model", promptTokens: 250, completionTokens: 0 },
      ],
      [price("gpt-4o", 1, 1)],
    );
    expect(result.pricedShare).toBe(0.75);
    expect(result.usd).toBeCloseTo(0.00075, 10);
  });

  it("has no estimate and no share when nothing was used", () => {
    expect(estimateCost([], [price("gpt-4o", 1, 1)])).toEqual({ usd: null, pricedShare: null });
  });
});
