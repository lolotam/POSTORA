import { describe, it, expect } from "vitest";
import { aggregateUsage, formatUsageLine, type UsageRow } from "../usageSummary";

const row = (overrides: Partial<UsageRow> = {}): UsageRow => ({
  tool_id: "tool-1",
  calls: 142,
  failures: 0,
  p50_latency_ms: 640,
  last_used_at: "2026-09-02T09:00:00Z",
  ...overrides,
});

describe("formatUsageLine", () => {
  it("says there were no calls when the window holds no row for the tool", () => {
    expect(formatUsageLine(undefined, 30)).toBe("No calls in 30 d");
  });

  it("says there were no calls when the row counted none", () => {
    expect(formatUsageLine(row({ calls: 0, p50_latency_ms: null }), 30)).toBe("No calls in 30 d");
  });

  it("reports the call count, the window and the median latency", () => {
    expect(formatUsageLine(row(), 30)).toBe("142 calls · 30 d · p50 640 ms");
  });

  it("omits the median when the row has none, and keeps the count singular for one call", () => {
    expect(formatUsageLine(row({ calls: 1, p50_latency_ms: null }), 7)).toBe("1 call · 7 d");
  });
});

describe("aggregateUsage", () => {
  it("has nothing to report for an empty set", () => {
    expect(aggregateUsage([])).toBeUndefined();
  });

  it("keeps a single row's median latency", () => {
    expect(aggregateUsage([row()])).toMatchObject({ calls: 142, p50_latency_ms: 640 });
  });

  it("sums calls and failures across rows and reports the latest use", () => {
    const merged = aggregateUsage([
      row({ tool_id: "a", calls: 10, failures: 1, last_used_at: "2026-09-01T00:00:00Z" }),
      row({ tool_id: "b", calls: 5, failures: 2, last_used_at: "2026-09-03T00:00:00Z" }),
    ]);
    expect(merged).toMatchObject({ calls: 15, failures: 3, last_used_at: "2026-09-03T00:00:00Z" });
  });

  it("refuses to invent a median across rows, because a median of medians is not a median", () => {
    const merged = aggregateUsage([row({ tool_id: "a" }), row({ tool_id: "b", p50_latency_ms: 20 })]);
    expect(merged?.p50_latency_ms).toBeNull();
  });
});
