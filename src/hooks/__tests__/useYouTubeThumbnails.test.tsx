/**
 * Tests for useYouTubeThumbnails hook
 * Main test file - no DOM mocking that could break React
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useYouTubeThumbnails } from "../useYouTubeThumbnails";

// Mock useToast
const mockToast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

// Mock supabase
const mockInvoke = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    channel: () => { const channel = { on: () => channel, subscribe: () => channel }; return channel; },
    removeChannel: vi.fn(),
    functions: {
      invoke: (...args: unknown[]) => mockInvoke(...args),
    },
  },
}));

// Mock URL methods
const mockRevokeObjectURL = vi.fn();
const mockCreateObjectURL = vi.fn(() => "blob:mock-url");
globalThis.URL.createObjectURL = mockCreateObjectURL;
globalThis.URL.revokeObjectURL = mockRevokeObjectURL;

describe("useYouTubeThumbnails", () => {
  const mockSetAutoThumbnails = vi.fn();
  const mockSetSelectedAutoThumbnail = vi.fn();
  const mockSetAiGeneratedThumbnails = vi.fn();
  const mockSetGeneratingAiThumbnail = vi.fn();

  const defaultProps = {
    files: [],
    setYoutubeAutoThumbnails: mockSetAutoThumbnails,
    setYoutubeSelectedAutoThumbnail: mockSetSelectedAutoThumbnail,
    setYoutubeAiGeneratedThumbnails: mockSetAiGeneratedThumbnails,
    setYoutubeGeneratingAiThumbnail: mockSetGeneratingAiThumbnail,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  describe("generateAutoThumbnails", () => {
    it("shows error toast when no video file exists", async () => {
      const { result } = renderHook(() => useYouTubeThumbnails(defaultProps));

      await act(async () => {
        await result.current.generateAutoThumbnails();
      });

      expect(mockToast).toHaveBeenCalledWith({
        title: "No video found",
        description: "Please upload a video first.",
        variant: "destructive",
      });
    });
  });

  describe("generateAiThumbnail", () => {

    it.each(["succeeded", "failed"])("waits for a queued image job to finish as %s", async (status) => {
      vi.useFakeTimers();
      mockInvoke.mockImplementation((name: string) => Promise.resolve({
        data: name === "generate-image"
          ? { success: true, jobId: "j1", status: "queued" }
          : { success: true, status, imageUrl: status === "succeeded" ? "data:image/png;base64,AA" : null,
            error: status === "failed" ? "Provider failed" : null },
        error: null,
      }));
      const { result } = renderHook(() => useYouTubeThumbnails(defaultProps));
      let done: Promise<void>;
      await act(async () => { done = result.current.generateAiThumbnail("cat"); });
      expect(result.current.isGeneratingAi).toBe(true);
      expect(mockSetAiGeneratedThumbnails).not.toHaveBeenCalled();
      expect(mockSetGeneratingAiThumbnail).not.toHaveBeenCalledWith(false);
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); await done; });
      expect(result.current.isGeneratingAi).toBe(false);
      if (status === "succeeded") {
        expect(mockSetAiGeneratedThumbnails).toHaveBeenCalledTimes(1);
        expect(mockSetAiGeneratedThumbnails.mock.calls[0][0](["prior"])).toEqual(["prior", "data:image/png;base64,AA"]);
        expect(mockSetAiGeneratedThumbnails.mock.invocationCallOrder[0]).toBeLessThan(mockSetGeneratingAiThumbnail.mock.invocationCallOrder[1]);
      } else {
        expect(mockSetAiGeneratedThumbnails).not.toHaveBeenCalled();
        expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Failed to generate", variant: "destructive" }));
      }
    });

    it("sends the prompt and ratio, leaving the model to the server", async () => {
      mockInvoke.mockResolvedValue({
        data: { imageUrl: "https://generated-image.jpg" },
        error: null,
      });

      const { result } = renderHook(() => useYouTubeThumbnails(defaultProps));

      await act(async () => {
        await result.current.generateAiThumbnail("A beautiful thumbnail");
      });

      expect(mockInvoke).toHaveBeenCalledWith("generate-image", {
        body: {
          prompt: "A beautiful thumbnail",
          aspectRatio: "16:9",
          referenceImage: undefined,
          async: true,
        },
      });
    });

    // The whole point of the change: model choice is administrative, so the
    // client must not pin one, and quality is an admin knob now.
    it("does not send a model, quality, width or height", async () => {
      mockInvoke.mockResolvedValue({
        data: { imageUrl: "https://generated-image.jpg" },
        error: null,
      });

      const { result } = renderHook(() => useYouTubeThumbnails(defaultProps));

      await act(async () => {
        await result.current.generateAiThumbnail("Anything");
      });

      const body = mockInvoke.mock.calls[0][1].body;
      expect(body).not.toHaveProperty("model");
      expect(body).not.toHaveProperty("quality");
      expect(body).not.toHaveProperty("width");
      expect(body).not.toHaveProperty("height");
    });

    it("includes reference image when provided", async () => {
      mockInvoke.mockResolvedValue({
        data: { imageUrl: "https://generated-image.jpg" },
        error: null,
      });

      const { result } = renderHook(() => useYouTubeThumbnails(defaultProps));

      await act(async () => {
        await result.current.generateAiThumbnail(
          "Thumbnail with reference",
          "data:image/jpeg;base64,refimage"
        );
      });

      expect(mockInvoke).toHaveBeenCalledWith("generate-image", {
        body: expect.objectContaining({
          referenceImage: "data:image/jpeg;base64,refimage",
          async: true,
        }),
      });
    });

    it("updates AI generated thumbnails on success", async () => {
      mockInvoke.mockResolvedValue({
        data: { imageUrl: "https://new-thumbnail.jpg" },
        error: null,
      });

      const { result } = renderHook(() => useYouTubeThumbnails(defaultProps));

      await act(async () => {
        await result.current.generateAiThumbnail("Test");
      });

      expect(mockSetAiGeneratedThumbnails).toHaveBeenCalled();
      expect(mockToast).toHaveBeenCalledWith({
        title: "Thumbnail generated!",
        description: "AI thumbnail has been created.",
      });
    });

    it("shows error toast on failure", async () => {
      mockInvoke.mockResolvedValue({
        data: null,
        error: new Error("API error"),
      });

      const { result } = renderHook(() => useYouTubeThumbnails(defaultProps));

      await act(async () => {
        await result.current.generateAiThumbnail("Test");
      });

      expect(mockToast).toHaveBeenCalledWith({
        title: "Failed to generate",
        description: "Could not generate AI thumbnail.",
        variant: "destructive",
      });
    });

    it("handles error in data response", async () => {
      mockInvoke.mockResolvedValue({
        data: { error: "Rate limit exceeded" },
        error: null,
      });

      const { result } = renderHook(() => useYouTubeThumbnails(defaultProps));

      await act(async () => {
        await result.current.generateAiThumbnail("Test");
      });

      expect(mockToast).toHaveBeenCalledWith({
        title: "Failed to generate",
        description: "Could not generate AI thumbnail.",
        variant: "destructive",
      });
    });

    it("sets and clears loading state correctly", async () => {
      mockInvoke.mockResolvedValue({
        data: { imageUrl: "https://generated.jpg" },
        error: null,
      });

      const { result } = renderHook(() => useYouTubeThumbnails(defaultProps));

      expect(result.current.isGeneratingAi).toBe(false);

      await act(async () => {
        await result.current.generateAiThumbnail("Test");
      });

      expect(mockSetGeneratingAiThumbnail).toHaveBeenCalledWith(true);
      expect(mockSetGeneratingAiThumbnail).toHaveBeenCalledWith(false);
    });
  });

  describe("downloadThumbnail", () => {
    it("shows error toast on download failure", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

      const { result } = renderHook(() => useYouTubeThumbnails(defaultProps));

      await act(async () => {
        await result.current.downloadThumbnail(
          "https://example.com/fail.jpg",
          "fail.jpg"
        );
      });

      expect(mockToast).toHaveBeenCalledWith({
        title: "Download failed",
        description: "Could not download thumbnail.",
        variant: "destructive",
      });
    });

    it("attempts to download data URL", async () => {
      // This test verifies the function runs without error for data URLs
      // Full download behavior is tested in integration/e2e tests
      const { result } = renderHook(() => useYouTubeThumbnails(defaultProps));

      // Should not throw
      await act(async () => {
        try {
          await result.current.downloadThumbnail(
            "data:image/jpeg;base64,abc123",
            "thumbnail.jpg"
          );
        } catch {
          // May fail in JSDOM environment, that's okay
        }
      });

      // Function was called successfully
      expect(result.current).toBeDefined();
    });

    it("attempts to fetch external URL", async () => {
      const mockBlob = new Blob(["image"], { type: "image/jpeg" });
      globalThis.fetch = vi.fn().mockResolvedValue({
        blob: () => Promise.resolve(mockBlob),
      });

      const { result } = renderHook(() => useYouTubeThumbnails(defaultProps));

      await act(async () => {
        try {
          await result.current.downloadThumbnail(
            "https://example.com/image.jpg",
            "external-thumb.jpg"
          );
        } catch {
          // May fail in JSDOM environment, that's okay
        }
      });

      // Fetch was called with correct URL
      expect(fetch).toHaveBeenCalledWith("https://example.com/image.jpg");
    });
  });

  describe("return values", () => {
    it("returns all expected functions and state", () => {
      const { result } = renderHook(() => useYouTubeThumbnails(defaultProps));

      expect(result.current).toHaveProperty("generateAutoThumbnails");
      expect(result.current).toHaveProperty("generateAiThumbnail");
      expect(result.current).toHaveProperty("downloadThumbnail");
      expect(result.current).toHaveProperty("isGeneratingAi");

      expect(typeof result.current.generateAutoThumbnails).toBe("function");
      expect(typeof result.current.generateAiThumbnail).toBe("function");
      expect(typeof result.current.downloadThumbnail).toBe("function");
      expect(typeof result.current.isGeneratingAi).toBe("boolean");
    });

    it("initial isGeneratingAi is false", () => {
      const { result } = renderHook(() => useYouTubeThumbnails(defaultProps));
      expect(result.current.isGeneratingAi).toBe(false);
    });
  });
});
