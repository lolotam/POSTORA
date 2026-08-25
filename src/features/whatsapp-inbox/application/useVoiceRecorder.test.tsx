import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_DURATION_SECONDS } from "../domain/voiceNotePolicy";
import { useVoiceRecorder } from "./useVoiceRecorder";

class FakeMediaRecorder {
  static isTypeSupported(type: string): boolean {
    return type.startsWith("audio/webm");
  }

  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  state: "inactive" | "recording" = "inactive";
  mimeType: string;

  constructor(_stream: MediaStream, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? "";
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob([new Uint8Array(64)], { type: this.mimeType || "audio/webm" }),
    });
    this.onstop?.();
  }
}

class FakeAudioContext {
  state: AudioContextState = "running";
  close = vi.fn(async () => {
    this.state = "closed";
  });
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }));
  createAnalyser = vi.fn(() => ({
    fftSize: 256,
    frequencyBinCount: 8,
    getByteTimeDomainData: (buffer: Uint8Array) => {
      buffer.fill(128);
    },
    connect: vi.fn(),
  }));
}

function installBrowserMocks(options?: {
  getUserMedia?: () => Promise<MediaStream>;
  mediaRecorder?: unknown;
}): { trackStop: ReturnType<typeof vi.fn>; stream: MediaStream; context: FakeAudioContext } {
  const trackStop = vi.fn();
  const stream = {
    getTracks: () => [{ stop: trackStop, kind: "audio", readyState: "live" }],
  } as unknown as MediaStream;

  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    writable: true,
    value: {
      getUserMedia: options?.getUserMedia
        ?? vi.fn(async () => stream),
    },
  });

  vi.stubGlobal("MediaRecorder", options?.mediaRecorder === undefined ? FakeMediaRecorder : options.mediaRecorder);
  const context = new FakeAudioContext();
  vi.stubGlobal("AudioContext", function AudioContext() {
    return context;
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    return window.setTimeout(() => callback(0), 16) as unknown as number;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    window.clearTimeout(id);
  });

  return { trackStop, stream, context };
}

describe("useVoiceRecorder", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installBrowserMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("start then stop yields a blob", async () => {
    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe("recording");
    expect(result.current.mimeType).toBe("audio/webm;codecs=opus");

    act(() => {
      result.current.stop();
    });
    expect(result.current.state).toBe("preview");
    expect(result.current.blob).toBeInstanceOf(Blob);
    expect(result.current.blob?.size).toBeGreaterThan(0);
  });

  // Regression, 2026-08-25: a leaked MediaStream track leaves the browser's
  // recording indicator lit, which users reasonably read as spyware.
  it("cancel() stops every track and closes the AudioContext", async () => {
    const { trackStop, context } = installBrowserMocks();
    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => {
      await result.current.start();
    });
    act(() => {
      result.current.cancel();
    });
    expect(trackStop).toHaveBeenCalled();
    expect(context.close).toHaveBeenCalled();
    expect(result.current.state).toBe("idle");
    expect(result.current.blob).toBeNull();
  });

  it("unmount stops every track and closes the AudioContext", async () => {
    const { trackStop, context } = installBrowserMocks();
    const { result, unmount } = renderHook(() => useVoiceRecorder());
    await act(async () => {
      await result.current.start();
    });
    unmount();
    expect(trackStop).toHaveBeenCalled();
    expect(context.close).toHaveBeenCalled();
  });

  it("maps NotAllowedError to denied", async () => {
    installBrowserMocks({
      getUserMedia: async () => {
        const error = new Error("Permission denied");
        error.name = "NotAllowedError";
        throw error;
      },
    });
    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe("denied");
    expect(result.current.blob).toBeNull();
  });

  it("maps a missing MediaRecorder to unsupported", async () => {
    vi.stubGlobal("MediaRecorder", undefined);
    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe("unsupported");
  });

  it("auto-stops at the duration cap", async () => {
    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe("recording");
    act(() => {
      vi.advanceTimersByTime(MAX_DURATION_SECONDS * 1000);
    });
    expect(result.current.state).toBe("preview");
    expect(result.current.blob).toBeInstanceOf(Blob);
    expect(result.current.elapsedMs).toBeGreaterThanOrEqual(MAX_DURATION_SECONDS * 1000);
  });

  it("closes the AudioContext on reset after a finished take", async () => {
    const { context, trackStop } = installBrowserMocks();
    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => {
      await result.current.start();
    });
    act(() => {
      result.current.stop();
    });
    expect(trackStop).toHaveBeenCalled();
    expect(context.close).toHaveBeenCalled();
    act(() => {
      result.current.reset();
    });
    expect(result.current.state).toBe("idle");
    expect(result.current.blob).toBeNull();
  });
});
