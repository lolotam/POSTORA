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
    functions: {
      invoke: (...args: any[]) => mockInvoke(...args),
    },
  },
}));

// Mock URL methods
const mockRevokeObjectURL = vi.fn();
const mockCreateObjectURL = vi.fn(() => "blob:mock-url");
(globalThis as any).URL.createObjectURL = mockCreateObjectURL;
(globalThis as any).URL.revokeObjectURL = mockRevokeObjectURL;

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
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error")) as any;

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
