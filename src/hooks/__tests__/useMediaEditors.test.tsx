import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMediaEditors } from "../useMediaEditors";
import type { UploadedFile } from "@/hooks/usePostForm";

// Mock useToast
const mockToast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

// useMediaEditors reads the processing-jobs context, which throws outside its
// provider. Mocking the module keeps these unit tests focused on editor state and
// matches how use-toast is handled above.
vi.mock("@/contexts/ProcessingJobsContext", () => ({
  useProcessingJobsContext: () => ({
    jobs: [],
    addJob: vi.fn(),
    updateJob: vi.fn(),
    removeJob: vi.fn(),
    clearCompleted: vi.fn(),
    retryJob: vi.fn(),
    registerRetryHandler: vi.fn(),
  }),
}));

// Mock URL methods
const mockRevokeObjectURL = vi.fn();
(globalThis as any).URL.revokeObjectURL = mockRevokeObjectURL;

describe("useMediaEditors", () => {
  const mockSetFiles = vi.fn();
  const mockUploadFileToStorage = vi.fn().mockResolvedValue(undefined);

  const createMockFile = (overrides: Partial<UploadedFile> = {}): UploadedFile => ({
    id: "file-1",
    file: new File([""], "test.jpg", { type: "image/jpeg" }),
    fileType: "image" as const,
    previewUrl: "blob:test-url",
    uploaded: true,
    uploadProgress: 100,
    ...overrides,
  });

  const createDefaultProps = (overrides = {}) => ({
    files: [] as UploadedFile[],
    setFiles: mockSetFiles,
    uploadFileToStorage: mockUploadFileToStorage,
    user: { id: "user-1" },
    flags: { imageCrop: true, videoCompress: true },
    isFlagsLoading: false,
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("initial state", () => {
    it("returns closed cropper state initially", () => {
      const { result } = renderHook(() => useMediaEditors(createDefaultProps()));

      expect(result.current.cropperState).toEqual({
        open: false,
        mediaSrc: "",
        mediaType: "image",
        fileId: null,
        mediaFileId: null,
        targetRatio: undefined,
      });
    });

    it("returns closed compressor state initially", () => {
      const { result } = renderHook(() => useMediaEditors(createDefaultProps()));

      expect(result.current.compressorState).toEqual({
        open: false,
        file: null,
        fileId: null,
        mediaFileId: null,
        src: "",
      });
    });
  });

  describe("openCropper", () => {
    it("opens cropper with file data", () => {
      const mockFile = createMockFile();
      const { result } = renderHook(() => useMediaEditors(createDefaultProps()));

      act(() => {
        result.current.openCropper(mockFile);
      });

      expect(result.current.cropperState).toEqual({
        open: true,
        mediaSrc: "blob:test-url",
        mediaType: "image",
        fileId: "file-1",
        mediaFileId: null,
        targetRatio: undefined,
      });
    });

    it("opens cropper with target ratio", () => {
      const mockFile = createMockFile();
      const { result } = renderHook(() => useMediaEditors(createDefaultProps()));

      act(() => {
        result.current.openCropper(mockFile, "16:9");
      });

      expect(result.current.cropperState.targetRatio).toBe("16:9");
    });

    it("shows error toast when imageCrop flag is disabled", () => {
      const mockFile = createMockFile();
      const props = createDefaultProps({
        flags: { imageCrop: false, videoCompress: true },
      });
      const { result } = renderHook(() => useMediaEditors(props));

      act(() => {
        result.current.openCropper(mockFile);
      });

      expect(mockToast).toHaveBeenCalledWith({
        title: "Feature disabled",
        description: "Image cropping is currently disabled by the admin.",
        variant: "destructive",
      });
      expect(result.current.cropperState.open).toBe(false);
    });

    it("shows error toast when flags are loading", () => {
      const mockFile = createMockFile();
      const props = createDefaultProps({ isFlagsLoading: true });
      const { result } = renderHook(() => useMediaEditors(props));

      act(() => {
        result.current.openCropper(mockFile);
      });

      expect(mockToast).toHaveBeenCalledWith({
        title: "Feature disabled",
        description: "Image cropping is currently disabled by the admin.",
        variant: "destructive",
      });
    });

    it("handles video files", () => {
      const mockVideoFile = createMockFile({
        id: "video-1",
        fileType: "video",
        file: new File([""], "test.mp4", { type: "video/mp4" }),
      });
      const { result } = renderHook(() => useMediaEditors(createDefaultProps()));

      act(() => {
        result.current.openCropper(mockVideoFile);
      });

      expect(result.current.cropperState.mediaType).toBe("video");
    });
  });

  describe("closeCropper", () => {
    it("closes the cropper", () => {
      const mockFile = createMockFile();
      const { result } = renderHook(() => useMediaEditors(createDefaultProps()));

      act(() => {
        result.current.openCropper(mockFile);
      });

      expect(result.current.cropperState.open).toBe(true);

      act(() => {
        result.current.closeCropper();
      });

      expect(result.current.cropperState.open).toBe(false);
    });
  });

  describe("handleCropComplete", () => {
    it("updates files with cropped image", async () => {
      const mockFile = createMockFile();
      const props = createDefaultProps({ files: [mockFile] });
      const { result } = renderHook(() => useMediaEditors(props));

      // Open cropper first
      act(() => {
        result.current.openCropper(mockFile);
      });

      const croppedBlob = new Blob(["cropped"], { type: "image/jpeg" });
      const croppedUrl = "blob:cropped-url";

      await act(async () => {
        await result.current.handleCropComplete(croppedBlob, croppedUrl);
      });

      expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:test-url");
      expect(mockSetFiles).toHaveBeenCalled();
      expect(mockUploadFileToStorage).toHaveBeenCalled();
      expect(mockToast).toHaveBeenCalledWith({
        title: "Image cropped",
        description: "Your image has been cropped and re-uploaded.",
      });
    });

    it("does nothing when no fileId set", async () => {
      const { result } = renderHook(() => useMediaEditors(createDefaultProps()));

      await act(async () => {
        await result.current.handleCropComplete(new Blob(), "url");
      });

      expect(mockSetFiles).not.toHaveBeenCalled();
    });

    it("does nothing when user is null", async () => {
      const mockFile = createMockFile();
      const props = createDefaultProps({ files: [mockFile], user: null });
      const { result } = renderHook(() => useMediaEditors(props));

      act(() => {
        result.current.openCropper(mockFile);
      });

      await act(async () => {
        await result.current.handleCropComplete(new Blob(), "url");
      });

      expect(mockSetFiles).not.toHaveBeenCalled();
    });

    it("does nothing when file not found", async () => {
      const mockFile = createMockFile({ id: "file-1" });
      const props = createDefaultProps({ files: [] }); // Empty files array
      const { result } = renderHook(() => useMediaEditors(props));

      // Manually set cropperState since file doesn't exist
      act(() => {
        result.current.openCropper(mockFile);
      });

      // Now files array is empty, so file won't be found
      const propsWithEmptyFiles = createDefaultProps({ files: [] });
      const { result: result2 } = renderHook(() => useMediaEditors(propsWithEmptyFiles));

      await act(async () => {
        await result2.current.handleCropComplete(new Blob(), "url");
      });

      // setFiles should not be called since no file was found
      expect(mockUploadFileToStorage).not.toHaveBeenCalled();
    });
  });

  describe("handleImageCropRequest", () => {
    it("opens cropper for image file with suggested ratio", () => {
      const mockFile = createMockFile({ fileType: "image" });
      const props = createDefaultProps({ files: [mockFile] });
      const { result } = renderHook(() => useMediaEditors(props));

      const suggestion = {
        platform: "instagram",
        isValid: false,
        currentRatio: 1.33,
        currentDimensions: { width: 800, height: 600 },
        recommendedRatio: "1:1",
        targetDimensions: { width: 600, height: 600 },
        cropDirection: "width" as const,
      };

      act(() => {
        result.current.handleImageCropRequest(suggestion);
      });

      expect(result.current.cropperState.open).toBe(true);
      expect(result.current.cropperState.targetRatio).toBe("1:1");
    });

    it("does nothing when imageCrop flag is disabled", () => {
      const mockFile = createMockFile({ fileType: "image" });
      const props = createDefaultProps({
        files: [mockFile],
        flags: { imageCrop: false, videoCompress: true },
      });
      const { result } = renderHook(() => useMediaEditors(props));

      const suggestion = {
        platform: "instagram",
        isValid: false,
        currentRatio: 1.33,
        currentDimensions: { width: 800, height: 600 },
        recommendedRatio: "1:1",
        targetDimensions: { width: 600, height: 600 },
        cropDirection: "width" as const,
      };

      act(() => {
        result.current.handleImageCropRequest(suggestion);
      });

      expect(result.current.cropperState.open).toBe(false);
    });

    it("does nothing when no image file exists", () => {
      const mockVideoFile = createMockFile({ fileType: "video" });
      const props = createDefaultProps({ files: [mockVideoFile] });
      const { result } = renderHook(() => useMediaEditors(props));

      const suggestion = {
        platform: "instagram",
        isValid: false,
        currentRatio: 1.33,
        currentDimensions: { width: 800, height: 600 },
        recommendedRatio: "1:1",
        targetDimensions: { width: 600, height: 600 },
        cropDirection: "width" as const,
      };

      act(() => {
        result.current.handleImageCropRequest(suggestion);
      });

      expect(result.current.cropperState.open).toBe(false);
    });
  });

  describe("openCompressor", () => {
    it("opens compressor with file data", () => {
      const mockFile = createMockFile({
        fileType: "video",
        file: new File([""], "test.mp4", { type: "video/mp4" }),
      });
      const { result } = renderHook(() => useMediaEditors(createDefaultProps()));

      act(() => {
        result.current.openCompressor(mockFile);
      });

      expect(result.current.compressorState).toEqual({
        open: true,
        file: mockFile.file,
        fileId: "file-1",
        mediaFileId: null,
        src: "blob:test-url",
      });
    });

    it("shows error toast when videoCompress flag is disabled", () => {
      const mockFile = createMockFile({ fileType: "video" });
      const props = createDefaultProps({
        flags: { imageCrop: true, videoCompress: false },
      });
      const { result } = renderHook(() => useMediaEditors(props));

      act(() => {
        result.current.openCompressor(mockFile);
      });

      expect(mockToast).toHaveBeenCalledWith({
        title: "Feature disabled",
        description: "Video compression is currently disabled by the admin.",
        variant: "destructive",
      });
      expect(result.current.compressorState.open).toBe(false);
    });

    it("shows error toast when flags are loading", () => {
      const mockFile = createMockFile({ fileType: "video" });
      const props = createDefaultProps({ isFlagsLoading: true });
      const { result } = renderHook(() => useMediaEditors(props));

      act(() => {
        result.current.openCompressor(mockFile);
      });

      expect(mockToast).toHaveBeenCalledWith({
        title: "Feature disabled",
        description: "Video compression is currently disabled by the admin.",
        variant: "destructive",
      });
    });
  });

  describe("closeCompressor", () => {
    it("closes the compressor", () => {
      const mockFile = createMockFile({ fileType: "video" });
      const { result } = renderHook(() => useMediaEditors(createDefaultProps()));

      act(() => {
        result.current.openCompressor(mockFile);
      });

      expect(result.current.compressorState.open).toBe(true);

      act(() => {
        result.current.closeCompressor();
      });

      expect(result.current.compressorState.open).toBe(false);
    });
  });

  describe("handleCompressComplete", () => {
    it("updates files with compressed video", async () => {
      const mockFile = createMockFile({
        fileType: "video",
        file: new File([""], "test.mp4", { type: "video/mp4" }),
      });
      const props = createDefaultProps({ files: [mockFile] });
      const { result } = renderHook(() => useMediaEditors(props));

      act(() => {
        result.current.openCompressor(mockFile);
      });

      const compressedBlob = new Blob(["compressed"], { type: "video/mp4" });
      const compressedUrl = "blob:compressed-url";

      await act(async () => {
        await result.current.handleCompressComplete(compressedBlob, compressedUrl);
      });

      expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:test-url");
      expect(mockSetFiles).toHaveBeenCalled();
      expect(mockUploadFileToStorage).toHaveBeenCalled();
      expect(mockToast).toHaveBeenCalledWith({
        title: "Video processed",
        description: "Your video has been processed and re-uploaded.",
      });
    });

    it("does nothing when no fileId set", async () => {
      const { result } = renderHook(() => useMediaEditors(createDefaultProps()));

      await act(async () => {
        await result.current.handleCompressComplete(new Blob(), "url");
      });

      expect(mockSetFiles).not.toHaveBeenCalled();
    });

    it("does nothing when user is null", async () => {
      const mockFile = createMockFile({ fileType: "video" });
      const props = createDefaultProps({ files: [mockFile], user: null });
      const { result } = renderHook(() => useMediaEditors(props));

      act(() => {
        result.current.openCompressor(mockFile);
      });

      await act(async () => {
        await result.current.handleCompressComplete(new Blob(), "url");
      });

      expect(mockSetFiles).not.toHaveBeenCalled();
    });
  });

  describe("return values", () => {
    it("returns all expected properties", () => {
      const { result } = renderHook(() => useMediaEditors(createDefaultProps()));

      // Cropper
      expect(result.current).toHaveProperty("cropperState");
      expect(result.current).toHaveProperty("openCropper");
      expect(result.current).toHaveProperty("closeCropper");
      expect(result.current).toHaveProperty("handleCropComplete");
      expect(result.current).toHaveProperty("handleImageCropRequest");

      // Compressor
      expect(result.current).toHaveProperty("compressorState");
      expect(result.current).toHaveProperty("openCompressor");
      expect(result.current).toHaveProperty("closeCompressor");
      expect(result.current).toHaveProperty("handleCompressComplete");

      // Type checks
      expect(typeof result.current.openCropper).toBe("function");
      expect(typeof result.current.closeCropper).toBe("function");
      expect(typeof result.current.handleCropComplete).toBe("function");
      expect(typeof result.current.handleImageCropRequest).toBe("function");
      expect(typeof result.current.openCompressor).toBe("function");
      expect(typeof result.current.closeCompressor).toBe("function");
      expect(typeof result.current.handleCompressComplete).toBe("function");
    });
  });
});
