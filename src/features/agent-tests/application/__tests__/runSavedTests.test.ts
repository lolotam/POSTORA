import { describe, expect, it, vi } from "vitest";
import { EdgeApiError } from "@/lib/messagingApi";
import { runSavedTests } from "../runSavedTests";
import type { TestCase } from "../../domain/types";

function testCase(id: string, position: number, expected: TestCase["expected"]): TestCase {
  return {
    id,
    userId: "user-1",
    socialAccountId: "acct",
    platform: "whatsapp",
    message: id,
    expected,
    position,
    expectationValid: true,
  };
}

describe("runSavedTests", () => {
  it("runs every case in order and keeps going after a failure and a gateway error", async () => {
    const runCase = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        reply: "called the store",
        intent_status: "classified",
        intent: { choice: "pricing", confidence: 0.9 },
        tool_calls: [{ name: "woo_store" }],
        escalated: false,
        used_model: "openai/gpt-4o",
      })
      .mockRejectedValueOnce(new EdgeApiError("gateway", 503))
      .mockResolvedValueOnce({
        ok: true,
        reply: "a person will take this",
        escalated: true,
        intent_status: "off",
        tool_calls: [],
        used_model: "openai/gpt-4o",
      });
    const updates: Array<{ status: string; results: Array<{ verdict: string; expected: TestCase["expected"] }> }> = [];
    const deleted: string[][] = [];

    const finished = await runSavedTests({
      cases: [
        testCase("one", 0, { connector: "none" }),
        testCase("two", 1, {}),
        testCase("three", 2, { escalates: true }),
      ],
      platform: "whatsapp",
      accountId: "acct",
      createRun: async () => ({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      updateRun: async (_id, patch) => {
        updates.push(patch);
      },
      deleteThreads: async (ids) => {
        deleted.push(ids);
      },
      runCase,
    });

    expect(runCase.mock.calls.map((call) => call[0].message)).toEqual(["one", "two", "three"]);
    expect(runCase.mock.calls[0][0].testCaseKey).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(finished.status).toBe("completed");
    expect(finished.results.map((result) => result.verdict)).toEqual(["failed", "indeterminate", "passed"]);
    expect(finished.results[0].expected).toEqual({ connector: "none" });
    expect(finished.results[0].used_model).toBe("openai/gpt-4o");
    expect(updates.at(-1)?.status).toBe("completed");
    expect(updates.some((patch) => patch.status === "running" && patch.results.length === 1)).toBe(true);
    expect(deleted).toEqual([[
      `test_whatsapp_acct_${runCase.mock.calls[0][0].testCaseKey}`,
      `test_whatsapp_acct_${runCase.mock.calls[1][0].testCaseKey}`,
      `test_whatsapp_acct_${runCase.mock.calls[2][0].testCaseKey}`,
    ]]);
    expect(deleted[0].every((id) => !id.endsWith("%"))).toBe(true);
  });

  it("does not report the run completed when the final checkpoint fails", async () => {
    const finished = await runSavedTests({
      cases: [testCase("one", 0, { contains: ["price"] })],
      platform: "whatsapp",
      accountId: "acct",
      createRun: async () => ({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      updateRun: async (_id, patch) => {
        if (patch.status !== "running") throw new Error("final write failed");
      },
      deleteThreads: async () => {},
      runCase: async () => ({
        ok: true,
        reply: "the price is 5",
        intent_status: "off",
        tool_calls: [],
        escalated: false,
      }),
    });

    expect(finished.status).not.toBe("completed");
    expect(finished.savedOk).toBe(false);
    expect(finished.results).toHaveLength(1);
  });
});
