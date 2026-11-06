import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ onUpdate: null as null | ((p: unknown) => void), invoke: vi.fn(), removeChannel: vi.fn(), topics: [] as string[] }));
vi.mock("@/integrations/supabase/client", () => {
  const channel = { on: (_e: string, _f: unknown, cb: (p: unknown) => void) => { h.onUpdate = cb; return channel; }, subscribe: () => channel };
  return { supabase: { channel: (topic: string) => { h.topics.push(topic); return channel; }, removeChannel: h.removeChannel, functions: { invoke: h.invoke } } };
});
import { watchAiGenerationJob, awaitAiGenerationJob, resolveAiImageResponse, IMAGE_JOB_MAX_WAIT_MS } from "@/lib/aiGenerationJobWatcher";

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { context: { status } });
const running = { data: { success: true, status: "running", pollAfterSeconds: 3 }, error: null };

describe("aiGenerationJobWatcher", () => {
  beforeEach(() => { vi.useFakeTimers(); h.invoke.mockReset(); h.removeChannel.mockReset(); h.topics.length = 0; });
  afterEach(() => vi.useRealTimers());

  it("polls immediately when Realtime reports a terminal status", async () => {
    h.invoke.mockResolvedValue({ data: { success: true, status: "succeeded", imageUrl: "data:image/png;base64,AA" }, error: null });
    const seen: string[] = [];
    watchAiGenerationJob("j1", (s) => seen.push(s.status), IMAGE_JOB_MAX_WAIT_MS);
    h.onUpdate!({ new: { status: "succeeded" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toBe("succeeded");
    expect(h.removeChannel).toHaveBeenCalled();
  });

  it("B6: a Realtime event during a pending read never runs two reads at once", async () => {
    let active = 0; let maxActive = 0; let release!: (v: unknown) => void;
    h.invoke.mockImplementation(() => {
      active++; maxActive = Math.max(maxActive, active);
      const p = h.invoke.mock.calls.length === 1 ? new Promise((r) => { release = r; }) : Promise.resolve(running);
      return p.finally(() => { active--; });
    });
    watchAiGenerationJob("j1", () => {}, IMAGE_JOB_MAX_WAIT_MS);
    await vi.advanceTimersByTimeAsync(5_000);           // first read starts and hangs
    h.onUpdate!({ new: { status: "succeeded" } });       // event while it is in flight
    release(running);                                    // the stale read says running
    await vi.advanceTimersByTimeAsync(0);                // immediate re-poll (read 2) answers running
    await vi.advanceTimersByTimeAsync(3_000);            // exactly one scheduled read (read 3)
    expect(maxActive).toBe(1);
    expect(h.invoke).toHaveBeenCalledTimes(3);
  });

  it("a failed read is never terminal: it backs off and keeps polling", async () => {
    h.invoke
      .mockResolvedValueOnce({ data: null, error: httpError(500) })
      .mockResolvedValueOnce({ data: null, error: httpError(503) })
      .mockResolvedValueOnce({ data: { success: true, status: "succeeded", imageUrl: "https://h/i.png" }, error: null });
    const done = awaitAiGenerationJob("j1");
    await vi.advanceTimersByTimeAsync(5_000 + 5_000 + 10_000);
    await expect(done).resolves.toMatchObject({ status: "succeeded", imageUrl: "https://h/i.png" });
  });

  it("404 ends the watch as failed", async () => {
    h.invoke.mockResolvedValue({ data: null, error: httpError(404) });
    const done = awaitAiGenerationJob("j1");
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(done).resolves.toMatchObject({ status: "failed", errorCode: "job_not_found" });
  });

  it("B7: a read that never settles still ends the wait and removes the channel", async () => {
    h.invoke.mockImplementation(() => new Promise(() => {}));
    const done = awaitAiGenerationJob("j1");
    await vi.advanceTimersByTimeAsync(5_000 + 20_000 + 5_000);
    expect(h.invoke.mock.calls[0][1].signal.aborted).toBe(true);
    expect(h.invoke.mock.calls.length).toBeGreaterThan(1);  // the read timed out and was retried
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    await expect(done).resolves.toMatchObject({ status: "timeout" });
    expect(h.removeChannel).toHaveBeenCalled();
  });

  it("MEDIUM-3: still shows a late server result after the old ten-minute deadline", async () => {
    h.invoke.mockResolvedValue(running);
    const seen: string[] = [];
    watchAiGenerationJob("late-job", (snapshot) => seen.push(snapshot.status), IMAGE_JOB_MAX_WAIT_MS);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(seen.at(-1)).toBe("running");
    expect(h.removeChannel).not.toHaveBeenCalled();
    h.invoke.mockResolvedValue({ data: { status: "succeeded", imageUrl: "https://hf.invalid/late.png" }, error: null });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(seen.at(-1)).toBe("succeeded");
    expect(h.removeChannel).toHaveBeenCalledTimes(1);
  });

  it("two watchers on the same job subscribe to distinct Realtime topics", () => {
    h.invoke.mockResolvedValue(running);
    watchAiGenerationJob("same-job", () => {}, IMAGE_JOB_MAX_WAIT_MS);
    watchAiGenerationJob("same-job", () => {}, IMAGE_JOB_MAX_WAIT_MS);
    expect(h.topics).toHaveLength(2);
    expect(h.topics[0]).not.toBe(h.topics[1]);
    expect(h.topics.every((t) => t.includes("same-job"))).toBe(true);
  });

  it("resolveAiImageResponse passes a sync answer through and maps a failed job", async () => {
    await expect(resolveAiImageResponse({ imageUrl: "data:x" })).resolves.toEqual({ imageUrl: "data:x" });
    h.invoke.mockResolvedValue({ data: { success: true, status: "failed", error: "Daily AI generation limit reached", errorCode: "ai_quota_exhausted" }, error: null });
    const r = resolveAiImageResponse({ success: true, jobId: "j1", status: "queued" });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(r).resolves.toEqual({ success: false, error_code: "ai_quota_exhausted", message: "Daily AI generation limit reached" });
  });
});
