import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const h = vi.hoisted(() => ({ invoke: vi.fn(), removeChannel: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => {
  const channel = { on: () => channel, subscribe: () => channel };
  return { supabase: { channel: () => channel, removeChannel: h.removeChannel, functions: { invoke: h.invoke } } };
});
import { useAiGenerationJob } from "@/hooks/useAiGenerationJob";

describe("useAiGenerationJob", () => {
  beforeEach(() => { vi.useFakeTimers(); h.invoke.mockReset(); h.removeChannel.mockReset(); });
  afterEach(() => vi.useRealTimers());

  it("stays idle without a job id", async () => {
    const { result } = renderHook(() => useAiGenerationJob(null));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(result.current.status).toBe("idle");
    expect(h.invoke).not.toHaveBeenCalled();
  });
  it("reports running with isPolling", () => {
    const { result } = renderHook(() => useAiGenerationJob("j1"));
    expect(result.current).toMatchObject({ status: "running", isPolling: true });
  });
  it("ends with the video URL VideoGenerator reads and cleans up on unmount", async () => {
    h.invoke.mockResolvedValue({ data: { success: true, status: "succeeded", videoUrl: "https://v/x.mp4" }, error: null });
    const { result, unmount } = renderHook(() => useAiGenerationJob("j1"));
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(result.current).toMatchObject({ status: "succeeded", isPolling: false, videoUrl: "https://v/x.mp4" });
    unmount();
    expect(h.removeChannel).toHaveBeenCalled();
  });
});
