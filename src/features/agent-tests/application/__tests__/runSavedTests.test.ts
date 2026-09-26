import { describe, expect, it, vi } from "vitest";
import { EdgeApiError } from "@/lib/messagingApi";
import { runSavedTests, type RunSavedTestsDeps } from "../runSavedTests";
import { CASE_TIMEOUT_MS, type TestCase } from "../../domain/types";

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

function mixedRun() {
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
  const deps: RunSavedTestsDeps = {
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
  };
  return { deps, runCase, updates, deleted };
}

describe("runSavedTests", () => {
  it("runs cases in position order", async () => {
    const { deps, runCase } = mixedRun();
    await runSavedTests(deps);
    expect(runCase.mock.calls.map((call) => call[0].message)).toEqual(["one", "two", "three"]);
  });

  it("gives each case a key the sandbox accepts", async () => {
    const { deps, runCase } = mixedRun();
    await runSavedTests(deps);
    expect(runCase.mock.calls[0][0].testCaseKey).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it("keeps a failed case, a gateway failure, and a pass in one completed run", async () => {
    const { deps } = mixedRun();
    const finished = await runSavedTests(deps);
    expect(finished.status).toBe("completed");
    expect(finished.results.map((result) => result.verdict)).toEqual(["failed", "indeterminate", "passed"]);
    expect(finished.results[0].expected).toEqual({ connector: "none" });
    expect(finished.results[0].used_model).toBe("openai/gpt-4o");
    expect(finished.results[1].reasons).toEqual(["gateway error (HTTP 503)"]);
  });

  it("writes a running checkpoint before the run is completed", async () => {
    const { deps, updates } = mixedRun();
    await runSavedTests(deps);
    expect(updates.some((patch) => patch.status === "running" && patch.results.length === 1)).toBe(true);
    expect(updates.at(-1)?.status).toBe("completed");
  });

  it("deletes the exact sandbox threads for every case", async () => {
    const { deps, runCase, deleted } = mixedRun();
    await runSavedTests(deps);
    expect(deleted).toEqual([[
      `test_whatsapp_acct_${runCase.mock.calls[0][0].testCaseKey}`,
      `test_whatsapp_acct_${runCase.mock.calls[1][0].testCaseKey}`,
      `test_whatsapp_acct_${runCase.mock.calls[2][0].testCaseKey}`,
    ]]);
  });

  it("records an authentication failure as errored with its reason", async () => {
    const finished = await runSavedTests({
      cases: [testCase("one", 0, {})],
      platform: "whatsapp",
      accountId: "acct",
      createRun: async () => ({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      updateRun: async () => {},
      deleteThreads: async () => {},
      runCase: () => Promise.reject(new Error("Not authenticated")),
    });
    expect(finished.results[0].verdict).toBe("errored");
    expect(finished.results[0].reasons).toEqual(["Not authenticated"]);
  });

  it.each([
    ["a wrapped fetch failure", new EdgeApiError("Failed to fetch", null)],
    ["a raw fetch TypeError", new TypeError("Failed to fetch")],
  ])("records %s as indeterminate", async (_label, failure) => {
    const finished = await runSavedTests({
      cases: [testCase("one", 0, {})],
      platform: "whatsapp",
      accountId: "acct",
      createRun: async () => ({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      updateRun: async () => {},
      deleteThreads: async () => {},
      runCase: () => Promise.reject(failure),
    });
    expect(finished.results[0].verdict).toBe("indeterminate");
    expect(finished.results[0].reasons).toEqual(["network error"]);
  });

  it("records a case that hits the 70s limit as errored timed out", async () => {
    vi.useFakeTimers();
    try {
      const finished = runSavedTests({
        cases: [testCase("one", 0, { contains: ["price"] })],
        platform: "whatsapp",
        accountId: "acct",
        createRun: async () => ({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
        updateRun: async () => {},
        deleteThreads: async () => {},
        runCase: (input) => new Promise((_resolve, reject) => {
          input.signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
          });
        }),
      });
      await vi.advanceTimersByTimeAsync(CASE_TIMEOUT_MS);
      await expect(finished).resolves.toMatchObject({
        results: [{ verdict: "errored", reasons: ["timed out"] }],
      });
    } finally {
      vi.useRealTimers();
    }
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
