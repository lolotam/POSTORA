import { describe, expect, it } from "vitest";
import {
  compareRuns,
  displayRunStatus,
  evaluateTestCase,
  normaliseForMatch,
  testCaseKey,
  testThreadId,
} from "../evaluateTestCase";
import { STALE_RUN_MS, testCaseInputSchema, testExpectationSchema } from "../types";

const reply = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  reply: "The price is 5 د.ك",
  escalated: false,
  tool_calls: [] as Array<{ name: string }>,
  intent_status: "classified" as const,
  intent: { choice: "pricing", confidence: 0.9 },
  ...overrides,
});

describe("evaluateTestCase", () => {
  it("passes and fails each check", () => {
    expect(evaluateTestCase({ intent: "pricing" }, reply()).verdict).toBe("passed");
    expect(evaluateTestCase({ intent: "greeting" }, reply()).reasons).toEqual(["expected intent greeting, got pricing"]);
    expect(evaluateTestCase({ connector: "woo_store" }, reply({ tool_calls: [{ name: "woo_store" }] })).verdict).toBe("passed");
    expect(evaluateTestCase({ connector: "woo_store" }, reply()).reasons).toEqual(["expected connector woo_store to be called"]);
    expect(evaluateTestCase({ contains: ["د.ك"] }, reply()).verdict).toBe("passed");
    expect(evaluateTestCase({ contains: ["missing"] }, reply()).reasons).toEqual(['reply does not contain "missing"']);
    expect(evaluateTestCase({ avoids: ["refund"] }, reply()).verdict).toBe("passed");
    expect(evaluateTestCase({ avoids: ["price"] }, reply()).reasons).toEqual(['reply contains "price"']);
    expect(evaluateTestCase({ escalates: true }, reply({ escalated: true })).verdict).toBe("passed");
    expect(evaluateTestCase({ escalates: true }, reply()).reasons).toEqual(["expected a handoff"]);
  });

  it("folds Arabic alef variants and taa marbuta", () => {
    expect(normaliseForMatch("  أسعار ")).toBe(normaliseForMatch("اسعار"));
    expect(normaliseForMatch("مكتبة")).toBe(normaliseForMatch("مكتبه"));
    expect(evaluateTestCase({ contains: ["اسعار"] }, reply({ reply: "أسعار اليوم" })).verdict).toBe("passed");
    expect(evaluateTestCase({ contains: ["مكتبه"] }, reply({ reply: "المكتبة مفتوحة" })).verdict).toBe("passed");
  });

  it("treats connector none as no custom connector, ignoring built-in tools", () => {
    expect(evaluateTestCase({ connector: "none" }, reply({ tool_calls: [{ name: "escalate_to_human" }] })).verdict).toBe("passed");
    expect(evaluateTestCase({ connector: "none" }, reply({ tool_calls: [{ name: "woo_store" }] })).reasons).toEqual([
      "expected no connector to be called",
    ]);
  });

  it("errors an intent check when triage is off or unsure", () => {
    expect(evaluateTestCase({ intent: "pricing" }, reply({ intent: null, intent_status: "off" }))).toEqual({
      verdict: "errored",
      reasons: ["triage is off"],
    });
    expect(evaluateTestCase({ intent: "pricing" }, reply({ intent: null, intent_status: "uncertain" })).reasons).toEqual([
      "triage did not classify (is Reply triage on?)",
    ]);
  });

  it("does not call an empty expectation a pass", () => {
    expect(evaluateTestCase({}, reply()).verdict).toBe("no_assertions");
  });

  it("errors a skipped or non-reply body before checking assertions", () => {
    expect(evaluateTestCase({}, { ok: true, skipped: "agent_not_configured" }).verdict).toBe("errored");
    expect(evaluateTestCase({ contains: ["x"] }, { ok: false, error: "nope" }).reasons).toEqual([
      "the agent did not return a reply",
    ]);
  });
});

describe("test expectation schema", () => {
  it("accepts an empty expectation and rejects limits and unknown keys", () => {
    expect(testExpectationSchema.safeParse({}).success).toBe(true);
    expect(testCaseInputSchema.safeParse({ message: "hi", expected: { intent: "lead" } }).success).toBe(true);
    expect(testCaseInputSchema.safeParse({ message: "", expected: {} }).success).toBe(false);
    expect(testCaseInputSchema.safeParse({ message: "x".repeat(2001), expected: {} }).success).toBe(false);
    expect(testExpectationSchema.safeParse({ connector: "c".repeat(101) }).success).toBe(false);
    expect(testExpectationSchema.safeParse({ contains: Array.from({ length: 11 }, () => "a") }).success).toBe(false);
    expect(testExpectationSchema.safeParse({ contains: [""] }).success).toBe(false);
    expect(testExpectationSchema.safeParse({ contains: ["x".repeat(201)] }).success).toBe(false);
    expect(testExpectationSchema.safeParse({ intent: "price" }).success).toBe(false);
    expect(testExpectationSchema.safeParse({ extra: true }).success).toBe(false);
  });
});

describe("run snapshots", () => {
  it("compares completed runs by case id and ages a stale running run", () => {
    expect(compareRuns(
      [{ case_id: "a", verdict: "passed" }, { case_id: "b", verdict: "failed" }],
      [{ case_id: "a", verdict: "failed" }, { case_id: "b", verdict: "passed" }, { case_id: "c", verdict: "failed" }],
    )).toEqual({ newlyFailing: ["a"], newlyPassing: ["b"] });
    const started = "2026-09-26T00:00:00.000Z";
    expect(displayRunStatus("running", started, Date.parse(started) + STALE_RUN_MS + 1, STALE_RUN_MS)).toBe("interrupted");
    expect(displayRunStatus("completed", started, Date.parse(started) + STALE_RUN_MS + 1, STALE_RUN_MS)).toBe("completed");
  });

  it("builds an exact thread id from a truncated run key", () => {
    const key = testCaseKey("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 0);
    expect(key.length).toBeLessThanOrEqual(64);
    expect(key).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(testThreadId("whatsapp", "acct-1", key)).toBe(`test_whatsapp_acct-1_${key}`);
  });
});
