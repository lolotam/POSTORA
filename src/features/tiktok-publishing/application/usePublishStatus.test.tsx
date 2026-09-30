import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import { ReviewGatewayError, TikTokReviewGatewayProvider, type TikTokReviewGateway } from "./ports";
import { usePublishStatus } from "./usePublishStatus";
import type { PublishStatus } from "../domain/types";

function createFakeGateway(overrides: Partial<TikTokReviewGateway> = {}): TikTokReviewGateway {
  return {
    listAccounts: vi.fn(),
    creatorInfo: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    save: vi.fn(),
    reject: vi.fn(),
    archive: vi.fn(),
    restore: vi.fn(),
    reopen: vi.fn(),
    submit: vi.fn(),
    status: vi.fn().mockResolvedValue({
      state: "processing",
      updatedAt: "2026-09-30T12:00:00Z",
      reason: null,
      postUrl: null,
    }),
    resolveMediaPreview: vi.fn(),
    ...overrides,
  };
}

function createWrapper(gateway: TikTokReviewGateway) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <TikTokReviewGatewayProvider gateway={gateway}>
        {children}
      </TikTokReviewGatewayProvider>
    );
  };
}

describe("usePublishStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not poll when submissionId is null", async () => {
    const gateway = createFakeGateway();
    const { result } = renderHook(() => usePublishStatus(null), {
      wrapper: createWrapper(gateway),
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(gateway.status).not.toHaveBeenCalled();
    expect(result.current.status).toBeNull();
    expect(result.current.timedOut).toBe(false);
  });

  it("polls immediately on mount, then on the documented backoff: 3s, 5s, 10s, 20s, capped at 30s", async () => {
    const gateway = createFakeGateway();
    const { result } = renderHook(() => usePublishStatus("sub-123"), {
      wrapper: createWrapper(gateway),
    });
    await act(async () => {});

    // 1st poll happens immediately on mount
    expect(gateway.status).toHaveBeenCalledTimes(1);
    expect(gateway.status).toHaveBeenLastCalledWith("sub-123");
    expect(result.current.status?.state).toBe("processing");

    // 2nd poll after 3s (3000ms)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_999);
    });
    expect(gateway.status).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(gateway.status).toHaveBeenCalledTimes(2);

    // 3rd poll after +5s (5000ms)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(gateway.status).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(gateway.status).toHaveBeenCalledTimes(3);

    // 4th poll after +10s (10000ms)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_999);
    });
    expect(gateway.status).toHaveBeenCalledTimes(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(gateway.status).toHaveBeenCalledTimes(4);

    // 5th poll after +20s (20000ms)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(19_999);
    });
    expect(gateway.status).toHaveBeenCalledTimes(4);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(gateway.status).toHaveBeenCalledTimes(5);

    // 6th poll after +30s (30000ms)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999);
    });
    expect(gateway.status).toHaveBeenCalledTimes(5);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(gateway.status).toHaveBeenCalledTimes(6);

    // 7th poll remains capped at +30s (30000ms)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999);
    });
    expect(gateway.status).toHaveBeenCalledTimes(6);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(gateway.status).toHaveBeenCalledTimes(7);
  });

  it.each(["scheduled", "published", "failed", "needs_attention"] as const)(
    "stops polling when status becomes terminal: %s",
    async (terminalState) => {
      const terminalStatus: PublishStatus = {
        state: terminalState,
        updatedAt: "2026-09-30T12:05:00Z",
        reason: terminalState === "published" || terminalState === "scheduled" ? null : "Terminal condition occurred",
        postUrl: terminalState === "published" ? "https://tiktok.com/@user/video/1" : null,
      };

      const gateway = createFakeGateway({
        status: vi
          .fn()
          .mockResolvedValueOnce({
            state: "processing",
            updatedAt: "2026-09-30T12:00:00Z",
            reason: null,
            postUrl: null,
          })
          .mockResolvedValueOnce(terminalStatus),
      });

      const { result } = renderHook(() => usePublishStatus("sub-terminal"), {
        wrapper: createWrapper(gateway),
      });
      await act(async () => {});

      // 1st poll on mount -> processing
      expect(gateway.status).toHaveBeenCalledTimes(1);
      expect(result.current.status?.state).toBe("processing");

      // 2nd poll at +3s -> terminal
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(gateway.status).toHaveBeenCalledTimes(2);
      expect(result.current.status?.state).toBe(terminalState);

      // Advance by another 60s: no more calls should be made
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(gateway.status).toHaveBeenCalledTimes(2);
    },
  );

  test.each([401, 403, 404])(
    "stops polling when status() rejects with ReviewGatewayError status %i",
    async (httpStatus) => {
      const gateway = createFakeGateway({
        status: vi.fn().mockRejectedValue(
          new ReviewGatewayError("AUTH_ERROR", "Access denied", httpStatus),
        ),
      });

      const { result } = renderHook(() => usePublishStatus("sub-unrecoverable"), {
        wrapper: createWrapper(gateway),
      });
      await act(async () => {});

      expect(gateway.status).toHaveBeenCalledTimes(1);
      expect(result.current.error?.status).toBe(httpStatus);

      // Advance by 60s: no further calls are made
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(gateway.status).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps polling on backoff when status() rejects with an error whose status is 500", async () => {
    const gateway = createFakeGateway({
      status: vi.fn().mockRejectedValue(
        new ReviewGatewayError("INTERNAL", "Server error", 500),
      ),
    });

    const { result } = renderHook(() => usePublishStatus("sub-recoverable"), {
      wrapper: createWrapper(gateway),
    });
    await act(async () => {});

    expect(gateway.status).toHaveBeenCalledTimes(1);
    expect(result.current.error?.status).toBe(500);

    // 1st backoff is 3s: next attempt runs
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(gateway.status).toHaveBeenCalledTimes(2);

    // 2nd backoff is 5s: next attempt runs
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(gateway.status).toHaveBeenCalledTimes(3);
  });

  it("stops on unmount with no calls made after unmounting", async () => {
    const gateway = createFakeGateway();
    const { unmount } = renderHook(() => usePublishStatus("sub-unmount"), {
      wrapper: createWrapper(gateway),
    });
    await act(async () => {});

    // 1st poll on mount
    expect(gateway.status).toHaveBeenCalledTimes(1);

    // Unmount before 2nd poll
    unmount();

    // Advance timers: no further calls
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(gateway.status).toHaveBeenCalledTimes(1);
  });

  it("restarts cleanly when submissionId changes", async () => {
    const gateway = createFakeGateway();
    let id: string | null = "sub-first";
    let rerenderFn!: () => void;
    await act(async () => {
      const rendered = renderHook(() => usePublishStatus(id), {
        wrapper: createWrapper(gateway),
      });
      rerenderFn = rendered.rerender;
    });

    // 1st poll for sub-first on mount
    expect(gateway.status).toHaveBeenCalledTimes(1);
    expect(gateway.status).toHaveBeenLastCalledWith("sub-first");

    // Change submissionId to sub-second
    id = "sub-second";
    await act(async () => {
      rerenderFn();
    });

    // 1st poll for sub-second starts immediately
    expect(gateway.status).toHaveBeenCalledTimes(2);
    expect(gateway.status).toHaveBeenLastCalledWith("sub-second");

    // 2nd poll for sub-second after 3s
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(gateway.status).toHaveBeenCalledTimes(3);
    expect(gateway.status).toHaveBeenLastCalledWith("sub-second");
  });

  it("does not fire overlapping requests while one is in flight, and refresh during in-flight discards the stale result and runs a new poll", async () => {
    let resolveFirst!: (val: PublishStatus) => void;
    const firstPromise = new Promise<PublishStatus>((resolve) => {
      resolveFirst = resolve;
    });
    let resolveSecond!: (val: PublishStatus) => void;
    const secondPromise = new Promise<PublishStatus>((resolve) => {
      resolveSecond = resolve;
    });

    const gateway = createFakeGateway({
      status: vi
        .fn()
        .mockImplementationOnce(() => firstPromise)
        .mockImplementationOnce(() => secondPromise),
    });

    let resultRef!: { current: ReturnType<typeof usePublishStatus> };
    await act(async () => {
      const rendered = renderHook(() => usePublishStatus("sub-flight"), {
        wrapper: createWrapper(gateway),
      });
      resultRef = rendered.result;
    });

    // Initial poll fired immediately on mount
    expect(gateway.status).toHaveBeenCalledTimes(1);

    // Call refresh() while first request is still in flight
    await act(async () => {
      resultRef.current.refresh();
    });

    // Advance ~1s: in-flight guard prevents immediate poll and retries after 250ms, still 1 call
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(gateway.status).toHaveBeenCalledTimes(1);

    // Resolve the first (now cancelled/stale) request with stale data
    const staleStatus: PublishStatus = {
      state: "failed",
      updatedAt: "2026-09-30T12:00:00Z",
      reason: "Stale failure",
      postUrl: null,
    };
    await act(async () => {
      resolveFirst(staleStatus);
    });

    // Advance 250ms for the queued cycle-1 poll to run
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(gateway.status).toHaveBeenCalledTimes(2);

    // The stale result must NOT have overwritten status because cycle 0 was cancelled
    expect(resultRef.current.status).not.toEqual(staleStatus);

    // Resolve the second request with fresh data
    const freshStatus: PublishStatus = {
      state: "processing",
      updatedAt: "2026-09-30T12:01:00Z",
      reason: null,
      postUrl: null,
    };
    await act(async () => {
      resolveSecond(freshStatus);
    });

    expect(resultRef.current.status).toEqual(freshStatus);
  });

  it("sets timedOut to false just before and true at the exact moment of timeout (call count exactly 23 at 608s)", async () => {
    const gateway = createFakeGateway();
    const { result } = renderHook(() => usePublishStatus("sub-timeout"), {
      wrapper: createWrapper(gateway),
    });
    await act(async () => {});

    expect(result.current.timedOut).toBe(false);

    // Based on the backoff schedule (immediate + 3s + 5s + 10s + 20s + 18 * 30s = 578s),
    // the 23rd call occurs at 578s and the next is scheduled at 578s + 30s = 608s (608,000 ms).
    // Just before 608s (at 607,999 ms), timedOut is strictly false.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(607_999);
    });

    expect(result.current.timedOut).toBe(false);
    expect(gateway.status).toHaveBeenCalledTimes(23);

    // At exactly 608,000 ms (1 ms later), the timer fires, Date.now() - started >= MAX_POLL_MS, and timedOut becomes true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(result.current.timedOut).toBe(true);
    expect(gateway.status).toHaveBeenCalledTimes(23);

    // Advance further: no more calls made after timedOut
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(gateway.status).toHaveBeenCalledTimes(23);
  });

  it("refresh() clears timedOut and triggers an immediate call cycle", async () => {
    const gateway = createFakeGateway();
    const { result } = renderHook(() => usePublishStatus("sub-refresh"), {
      wrapper: createWrapper(gateway),
    });
    await act(async () => {});

    // Advance to timeout
    await act(async () => {
      await vi.advanceTimersByTimeAsync(608_000);
    });
    expect(result.current.timedOut).toBe(true);
    const callsBeforeRefresh = (gateway.status as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsBeforeRefresh).toBe(23);

    // Trigger refresh
    await act(async () => {
      result.current.refresh();
    });

    expect(result.current.timedOut).toBe(false);
    // Refresh triggers an immediate poll
    expect(gateway.status).toHaveBeenCalledTimes(callsBeforeRefresh + 1);

    // Next poll happens after 3s
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(gateway.status).toHaveBeenCalledTimes(callsBeforeRefresh + 2);
  });

  describe("scheduled status polling behavior with scheduledAt", () => {
    it("with scheduledAt in the future, rests (no polls) until scheduled instant, then resumes polling on backoff", async () => {
      const baseTime = new Date("2026-10-01T10:00:00Z").getTime();
      vi.setSystemTime(baseTime);

      const futureScheduledAt = new Date("2026-10-01T10:05:00Z").toISOString(); // 5 min in future (300_000ms)
      const scheduledStatus: PublishStatus = {
        state: "scheduled",
        updatedAt: "2026-10-01T10:00:00Z",
        reason: null,
        postUrl: null,
      };
      const gateway = createFakeGateway({
        status: vi.fn().mockResolvedValue(scheduledStatus),
      });

      renderHook(() => usePublishStatus("sub-scheduled-future", futureScheduledAt), {
        wrapper: createWrapper(gateway),
      });
      await act(async () => {});

      // 1st poll happens on mount -> scheduled
      expect(gateway.status).toHaveBeenCalledTimes(1);

      // Advance by 4 minutes (240_000ms) - still resting
      vi.setSystemTime(baseTime + 240_000);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(240_000);
      });
      // Zero polls during the resting period
      expect(gateway.status).toHaveBeenCalledTimes(1);

      // Advance to the exact scheduled instant (remaining 60_000ms)
      vi.setSystemTime(baseTime + 300_000);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      // Wakes up and polls!
      expect(gateway.status).toHaveBeenCalledTimes(2);

      // Now scheduledAt is reached, backoff starts with 3s (3_000ms)
      vi.setSystemTime(baseTime + 300_000 + 3_000);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(gateway.status).toHaveBeenCalledTimes(3);

      // Next backoff delay is 5s (5_000ms)
      vi.setSystemTime(baseTime + 300_000 + 3_000 + 5_000);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(gateway.status).toHaveBeenCalledTimes(4);
    });

    it("with scheduledAt in the past, 'scheduled' keeps polling on backoff", async () => {
      const baseTime = new Date("2026-10-01T10:05:00Z").getTime();
      vi.setSystemTime(baseTime);

      const pastScheduledAt = new Date("2026-10-01T10:00:00Z").toISOString(); // 5 min in past
      const scheduledStatus: PublishStatus = {
        state: "scheduled",
        updatedAt: "2026-10-01T10:00:00Z",
        reason: null,
        postUrl: null,
      };
      const gateway = createFakeGateway({
        status: vi.fn().mockResolvedValue(scheduledStatus),
      });

      renderHook(() => usePublishStatus("sub-scheduled-past", pastScheduledAt), {
        wrapper: createWrapper(gateway),
      });
      await act(async () => {});

      // 1st poll on mount
      expect(gateway.status).toHaveBeenCalledTimes(1);

      // 2nd poll after 3s (first backoff)
      vi.setSystemTime(baseTime + 3_000);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(gateway.status).toHaveBeenCalledTimes(2);

      // 3rd poll after +5s (second backoff)
      vi.setSystemTime(baseTime + 3_000 + 5_000);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(gateway.status).toHaveBeenCalledTimes(3);
    });

    it("without scheduledAt, 'scheduled' stops polling immediately (existing behaviour)", async () => {
      const scheduledStatus: PublishStatus = {
        state: "scheduled",
        updatedAt: "2026-10-01T10:00:00Z",
        reason: null,
        postUrl: null,
      };
      const gateway = createFakeGateway({
        status: vi.fn().mockResolvedValue(scheduledStatus),
      });

      renderHook(() => usePublishStatus("sub-scheduled-none"), {
        wrapper: createWrapper(gateway),
      });
      await act(async () => {});

      expect(gateway.status).toHaveBeenCalledTimes(1);

      // Advance by 60s: no more calls made
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(gateway.status).toHaveBeenCalledTimes(1);
    });
  });
});
