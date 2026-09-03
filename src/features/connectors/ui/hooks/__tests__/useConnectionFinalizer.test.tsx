import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import {
  CONNECTION_POLL_DEADLINE_MS,
  CONNECTION_POLL_MS,
  useConnectionFinalizer,
} from "../useConnectionFinalizer";

function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { wrapper, invalidate };
}

describe("useConnectionFinalizer", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it("is idle without a connection and never calls the edge function", () => {
    const finalize = vi.fn();
    const { wrapper } = harness();
    const { result } = renderHook(() => useConnectionFinalizer({ connectionId: null, finalize }), { wrapper });
    expect(result.current.status).toBe("idle");
    expect(finalize).not.toHaveBeenCalled();
  });

  it("polls until the server says active, then refreshes connections and social accounts once", async () => {
    const finalize = vi.fn()
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({ status: "active" });
    const onActive = vi.fn();
    const { wrapper, invalidate } = harness();
    const { result } = renderHook(
      () => useConnectionFinalizer({ connectionId: "conn-1", socialProfileId: "profile-1", finalize, onActive }),
      { wrapper },
    );
    await waitFor(() => expect(finalize).toHaveBeenCalledTimes(1));
    expect(result.current.status).toBe("waiting");
    expect(finalize).toHaveBeenLastCalledWith("conn-1", "profile-1");

    await vi.advanceTimersByTimeAsync(CONNECTION_POLL_MS);
    await waitFor(() => expect(result.current.status).toBe("active"));
    expect(onActive).toHaveBeenCalledOnce();
    const invalidated = invalidate.mock.calls.map(([options]) => (options?.queryKey as unknown[])[0]);
    expect(invalidated).toEqual(expect.arrayContaining(["connectors", "social_accounts", "social_profiles"]));

    await vi.advanceTimersByTimeAsync(CONNECTION_POLL_MS * 2);
    expect(finalize).toHaveBeenCalledTimes(2);
  });

  it("surfaces the server's failure code and stops", async () => {
    const finalize = vi.fn().mockResolvedValue({ status: "failed", failure_code: "no_channel" });
    const onFailed = vi.fn();
    const { wrapper } = harness();
    const { result } = renderHook(() => useConnectionFinalizer({ connectionId: "conn-1", finalize, onFailed }), { wrapper });
    await waitFor(() => expect(result.current).toEqual({ status: "failed", failureCode: "no_channel" }));
    expect(onFailed).toHaveBeenCalledWith("no_channel");
    await vi.advanceTimersByTimeAsync(CONNECTION_POLL_MS * 2);
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("rides out transient request errors but gives up after five in a row", async () => {
    const finalize = vi.fn().mockRejectedValue(new Error("network"));
    const onFailed = vi.fn();
    const { wrapper } = harness();
    const { result } = renderHook(() => useConnectionFinalizer({ connectionId: "conn-1", finalize, onFailed }), { wrapper });
    await waitFor(() => expect(finalize).toHaveBeenCalledTimes(1));
    for (let attempt = 1; attempt < 5; attempt++) {
      expect(result.current.status).toBe("waiting");
      await vi.advanceTimersByTimeAsync(CONNECTION_POLL_MS);
    }
    await waitFor(() => expect(result.current.failureCode).toBe("request_failed"));
    expect(onFailed).toHaveBeenCalledWith("request_failed");
  });

  it("times out at the signed state's TTL instead of polling forever", async () => {
    const finalize = vi.fn().mockResolvedValue({ status: "pending" });
    const onFailed = vi.fn();
    const { wrapper } = harness();
    const { result } = renderHook(() => useConnectionFinalizer({ connectionId: "conn-1", finalize, onFailed }), { wrapper });
    await waitFor(() => expect(finalize).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(CONNECTION_POLL_DEADLINE_MS + CONNECTION_POLL_MS);
    await waitFor(() => expect(result.current.failureCode).toBe("timeout"));
    expect(onFailed).toHaveBeenCalledWith("timeout");
  });

  it("stops polling when the connection is withdrawn", async () => {
    const finalize = vi.fn().mockResolvedValue({ status: "pending" });
    const { wrapper } = harness();
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useConnectionFinalizer({ connectionId: id, finalize }),
      { wrapper, initialProps: { id: "conn-1" as string | null } },
    );
    await waitFor(() => expect(finalize).toHaveBeenCalledTimes(1));
    rerender({ id: null });
    expect(result.current.status).toBe("idle");
    await vi.advanceTimersByTimeAsync(CONNECTION_POLL_MS * 3);
    expect(finalize).toHaveBeenCalledTimes(1);
  });
});
