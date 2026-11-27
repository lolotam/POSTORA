import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTranscription } from "../useTranscription";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: {
      invoke: invokeMock,
    },
  },
}));

beforeEach(() => {
  invokeMock.mockReset();
});

describe("useTranscription", () => {
  it("stores and returns valid timed segments from transcribe-media", async () => {
    const segments = [
      { start: 0, end: 12.5, text: "Welcome to the video" },
      { start: 12.5, end: 42, text: "Walking through the new workflow" },
    ];
    invokeMock.mockResolvedValue({
      data: {
        transcript: "Welcome to the video Walking through the new workflow",
        language: "en",
        duration: 42,
        segments,
      },
      error: null,
    });

    const { result } = renderHook(() => useTranscription());

    let returned: Awaited<ReturnType<typeof result.current.transcribe>> = null;
    await act(async () => {
      returned = await result.current.transcribe("https://cdn.postora.cloud/videos/demo.mp4");
    });

    expect(invokeMock).toHaveBeenCalledWith("transcribe-media", {
      body: { mediaUrl: "https://cdn.postora.cloud/videos/demo.mp4" },
    });
    expect(returned).toEqual({
      transcript: "Welcome to the video Walking through the new workflow",
      language: "en",
      duration: 42,
      segments,
    });
    expect(result.current.transcript).toBe("Welcome to the video Walking through the new workflow");
    expect(result.current.language).toBe("en");
    expect(result.current.duration).toBe(42);
    expect(result.current.segments).toEqual(segments);
    expect(result.current.isTranscribing).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("sets segments to null when transcribe-media omits segments or returns malformed segment items", async () => {
    invokeMock.mockResolvedValueOnce({
      data: {
        transcript: "Untimed Gemini transcript",
        language: "ar",
        duration: 60,
      },
      error: null,
    });

    const { result } = renderHook(() => useTranscription());

    await act(async () => {
      await result.current.transcribe("https://cdn.postora.cloud/videos/no-timing.mp4");
    });

    expect(result.current.transcript).toBe("Untimed Gemini transcript");
    expect(result.current.segments).toBeNull();
    expect(result.current.error).toBeNull();

    invokeMock.mockResolvedValueOnce({
      data: {
        transcript: "Invalid segment bounds",
        language: "en",
        duration: 30,
        segments: [{ start: 10, end: 5, text: "Backwards timestamps" }],
      },
      error: null,
    });

    await act(async () => {
      await result.current.transcribe("https://cdn.postora.cloud/videos/malformed.mp4");
    });

    expect(result.current.transcript).toBe("Invalid segment bounds");
    expect(result.current.segments).toBeNull();
  });

  it("clears segments to null on transcription failure and on reset()", async () => {
    const segments = [{ start: 0, end: 15, text: "First segment" }];
    invokeMock.mockResolvedValueOnce({
      data: {
        transcript: "First segment",
        language: "en",
        duration: 15,
        segments,
      },
      error: null,
    });

    const { result } = renderHook(() => useTranscription());

    await act(async () => {
      await result.current.transcribe("https://cdn.postora.cloud/videos/first.mp4");
    });
    expect(result.current.segments).toEqual(segments);

    invokeMock.mockResolvedValueOnce({
      data: null,
      error: { message: "All transcription services failed" },
    });

    await act(async () => {
      const failedResult = await result.current.transcribe("https://cdn.postora.cloud/videos/fail.mp4");
      expect(failedResult).toBeNull();
    });

    expect(result.current.segments).toBeNull();
    expect(result.current.error).toBe("All transcription services failed");
    expect(result.current.isTranscribing).toBe(false);

    act(() => {
      result.current.reset();
    });

    expect(result.current.transcript).toBe("");
    expect(result.current.language).toBe("");
    expect(result.current.duration).toBe(0);
    expect(result.current.segments).toBeNull();
    expect(result.current.error).toBeNull();
  });
});
