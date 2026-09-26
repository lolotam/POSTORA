import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxReply, TestCase } from "../../domain/types";
import { useRunAllTests } from "../useAgentTestSets";

const api = vi.hoisted(() => ({
  deleteRunThreads: vi.fn(),
  deleteTestCase: vi.fn(),
  insertRun: vi.fn(),
  insertTestCase: vi.fn(),
  listTestCases: vi.fn(),
  listTestRuns: vi.fn(),
  runTestCase: vi.fn(),
  updateRun: vi.fn(),
  updateTestCase: vi.fn(),
}));

vi.mock("../../infrastructure/testCasesApi", () => api);
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

function testCase(id: string): TestCase {
  return {
    id,
    userId: "user-1",
    socialAccountId: "acct-a",
    platform: "whatsapp",
    message: id,
    expected: {},
    position: 0,
    expectationValid: true,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const reply: SandboxReply = { ok: true, reply: "ok", escalated: false, tool_calls: [], intent_status: "off" };

describe("useRunAllTests", () => {
  beforeEach(() => {
    api.insertRun.mockReset();
    api.updateRun.mockReset();
    api.deleteRunThreads.mockReset();
    api.runTestCase.mockReset();
    api.insertRun.mockResolvedValueOnce({ id: "run-a" }).mockResolvedValueOnce({ id: "run-b" });
    api.updateRun.mockResolvedValue(undefined);
    api.deleteRunThreads.mockResolvedValue(undefined);
  });

  it("drops an obsolete account's results and leaves the new account's progress alone", async () => {
    const accountA = deferred<SandboxReply>();
    const accountB = deferred<SandboxReply>();
    api.runTestCase.mockImplementationOnce(() => accountA.promise).mockImplementation(() => accountB.promise);

    const { result, rerender } = renderHook(
      ({ accountId }: { accountId: string }) => useRunAllTests(accountId, "whatsapp"),
      { initialProps: { accountId: "acct-a" }, wrapper },
    );

    act(() => {
      void result.current.run([testCase("from-a")]);
    });
    await waitFor(() => expect(api.runTestCase).toHaveBeenCalledTimes(1));

    rerender({ accountId: "acct-b" });
    act(() => {
      void result.current.run([testCase("from-b"), testCase("from-b-2")]);
    });
    await waitFor(() => expect(result.current.progress).toEqual({ current: 1, total: 2 }));

    await act(async () => {
      accountA.resolve(reply);
    });

    expect(result.current.live).toBeNull();
    expect(result.current.progress).toEqual({ current: 1, total: 2 });
  });
});
