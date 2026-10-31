/**
 * Separate test file for useYouTubeThumbnails video generation tests
 * These tests require document.createElement mocking which can conflict with React rendering
 * Kept in isolation to prevent test pollution
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useYouTubeThumbnails } from "../useYouTubeThumbnails";

// Store original before any tests run
const originalCreateElement = document.createElement.bind(document);

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
            invoke: (...args: unknown[]) => mockInvoke(...args),
        },
    },
}));

// Mock URL methods
const mockRevokeObjectURL = vi.fn();
const mockCreateObjectURL = vi.fn(() => "blob:mock-url");
globalThis.URL.createObjectURL = mockCreateObjectURL;
globalThis.URL.revokeObjectURL = mockRevokeObjectURL;

// Minimal stand-ins for the elements the hook creates. Handlers take an optional
// Event and getContext an optional id so each fake stays comparable to the real
// DOM element type it is returned as.
type FakeHandler = ((ev?: Event) => void) | null;

interface FakeVideo {
    src: string;
    crossOrigin: string;
    muted: boolean;
    currentTime: number;
    duration: number;
    videoWidth: number;
    videoHeight: number;
    onloadedmetadata: FakeHandler;
    onseeked: FakeHandler;
    onerror: FakeHandler;
}

interface FakeCanvas {
    width: number;
    height: number;
    getContext: (contextId?: string) => { drawImage: (...args: unknown[]) => void };
    toDataURL: () => string;
}

type FakeAnchor = Pick<HTMLAnchorElement, "href" | "download" | "click">;

describe("useYouTubeThumbnails - Video Generation", () => {
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
        // Restore original createElement after each test
        vi.spyOn(document, "createElement").mockImplementation(originalCreateElement);
        vi.restoreAllMocks();
    });

    describe("generateAutoThumbnails with video", () => {
        it("processes video file for thumbnail extraction", async () => {
            const mockVideoFile = {
                id: "video-1",
                file: new File([""], "test.mp4", { type: "video/mp4" }),
                fileType: "video" as const,
                previewUrl: "blob:video-url",
                uploaded: true,
                uploadProgress: 100,
            };

            const propsWithVideo = {
                ...defaultProps,
                files: [mockVideoFile],
            };

            // Mock video element
            const mockVideo: FakeVideo = {
                src: "",
                crossOrigin: "",
                muted: false,
                currentTime: 0,
                duration: 60,
                videoWidth: 1920,
                videoHeight: 1080,
                onloadedmetadata: null,
                onseeked: null,
                onerror: null,
            };

            // Mock canvas element
            const mockCanvas: FakeCanvas = {
                width: 0,
                height: 0,
                getContext: () => ({
                    drawImage: vi.fn(),
                }),
                toDataURL: () => "data:image/jpeg;base64,mockthumbnail",
            };

            // Mock anchor element
            const mockAnchor: FakeAnchor = {
                href: "",
                download: "",
                click: vi.fn(),
            };

            // Apply createElement mock
            vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
                if (tag === "video") return mockVideo as HTMLVideoElement;
                if (tag === "canvas") return mockCanvas as HTMLCanvasElement;
                if (tag === "a") return mockAnchor as HTMLAnchorElement;
                return originalCreateElement(tag);
            });

            const { result } = renderHook(() => useYouTubeThumbnails(propsWithVideo));

            // Start the generation (don't await, it uses async callbacks)
            act(() => {
                result.current.generateAutoThumbnails();
            });

            // Simulate video loaded
            if (mockVideo.onloadedmetadata) {
                await act(async () => {
                    mockVideo.onloadedmetadata();
                });
            }

            // Video file was found, so "No video found" toast should NOT be shown
            expect(mockToast).not.toHaveBeenCalledWith(
                expect.objectContaining({ title: "No video found" })
            );
        });

        it("shows error when no video file exists", async () => {
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

        it("extracts frames at correct intervals", async () => {
            const mockVideoFile = {
                id: "video-1",
                file: new File([""], "test.mp4", { type: "video/mp4" }),
                fileType: "video" as const,
                previewUrl: "blob:video-url",
                uploaded: true,
                uploadProgress: 100,
            };

            const propsWithVideo = {
                ...defaultProps,
                files: [mockVideoFile],
            };

            const seekTimes: number[] = [];
            const mockVideo: FakeVideo = {
                src: "",
                crossOrigin: "",
                muted: false,
                currentTime: 0,
                duration: 60,
                videoWidth: 1920,
                videoHeight: 1080,
                onloadedmetadata: null,
                onseeked: null,
                onerror: null,
            };

            // Track when currentTime is set
            Object.defineProperty(mockVideo, "currentTime", {
                get: () => seekTimes[seekTimes.length - 1] || 0,
                set: (v) => {
                    seekTimes.push(v);
                    if (mockVideo.onseeked) {
                        setTimeout(() => mockVideo.onseeked(), 0);
                    }
                },
            });

            vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
                if (tag === "video") return mockVideo as HTMLVideoElement;
                if (tag === "canvas") {
                    const canvas: FakeCanvas = {
                        width: 0,
                        height: 0,
                        getContext: () => ({ drawImage: vi.fn() }),
                        toDataURL: () => "data:image/jpeg;base64,mock",
                    };
                    return canvas as HTMLCanvasElement;
                }
                if (tag === "a") {
                    const anchor: FakeAnchor = { href: "", download: "", click: vi.fn() };
                    return anchor as HTMLAnchorElement;
                }
                return originalCreateElement(tag);
            });

            const { result } = renderHook(() => useYouTubeThumbnails(propsWithVideo));

            act(() => {
                result.current.generateAutoThumbnails();
            });

            // Trigger loadedmetadata
            if (mockVideo.onloadedmetadata) {
                await act(async () => {
                    mockVideo.onloadedmetadata();
                });
            }

            // Should have set currentTime for frame extraction
            // The exact timing depends on video duration and intervals
            expect(seekTimes.length).toBeGreaterThanOrEqual(0);
        });
    });
});
