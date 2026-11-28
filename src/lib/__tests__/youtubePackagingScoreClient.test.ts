import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  requestYouTubePackagingScore,
  type PackagingScore,
} from "../youtubePackagingScoreClient";

const mockGetSession = vi.fn();
const mockInvoke = vi.fn();
const mockHandleAIError = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: () => mockGetSession(),
    },
    functions: {
      invoke: (...args: unknown[]) => mockInvoke(...args),
    },
  },
}));

vi.mock("@/lib/aiErrorHandler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/aiErrorHandler")>();
  return {
    ...actual,
    handleAIError: (...args: unknown[]) => mockHandleAIError(...args),
  };
});

const VALID_SCORE: PackagingScore = {
  overall_score: 84,
  breakdown: {
    hook: 88,
    clarity: 85,
    mobile_length: 100,
    thumbnail_synergy: null,
  },
  strengths: ["Clear topic in the first 40 characters"],
  fixes: ["Add a concrete outcome or curiosity gap"],
  better_titles: [
    "How I Automated My YouTube Workflow in 15 Minutes",
    "The 15-Minute YouTube Workflow Every Solo Creator Needs",
    "Stop Wasting Hours Editing: My 15-Minute YouTube Setup",
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue({
    data: { session: { user: { id: "user-1" } } },
  });
});

describe("requestYouTubePackagingScore", () => {
  it("sends youtube_title_thumbnail_score with JSON context and omits blank thumbnail_text", async () => {
    mockInvoke.mockResolvedValue({
      data: { score: VALID_SCORE },
      error: null,
    });

    const result = await requestYouTubePackagingScore({
      title: "  My YouTube Workflow  ",
      thumbnailText: "   ",
      description: "  Step by step guide  ",
      language: "english",
    });

    expect(result).toEqual(VALID_SCORE);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("generate-caption", {
      body: {
        requestType: "youtube_title_thumbnail_score",
        platform: "youtube",
        language: "english",
        context: JSON.stringify({
          title: "My YouTube Workflow",
          description: "Step by step guide",
        }),
      },
    });
  });

  it("includes thumbnail_text in JSON context when provided", async () => {
    const scoreWithSynergy: PackagingScore = {
      ...VALID_SCORE,
      breakdown: {
        ...VALID_SCORE.breakdown,
        thumbnail_synergy: 90,
      },
    };
    mockInvoke.mockResolvedValue({
      data: { score: scoreWithSynergy },
      error: null,
    });

    const result = await requestYouTubePackagingScore({
      title: "My YouTube Workflow",
      thumbnailText: "Bold red arrow pointing to 0 hours",
      language: "arabic",
    });

    expect(result.breakdown.thumbnail_synergy).toBe(90);
    expect(mockInvoke).toHaveBeenCalledWith("generate-caption", {
      body: {
        requestType: "youtube_title_thumbnail_score",
        platform: "youtube",
        language: "arabic",
        context: JSON.stringify({
          title: "My YouTube Workflow",
          thumbnail_text: "Bold red arrow pointing to 0 hours",
        }),
      },
    });
  });

  it("rejects empty or over-100-character titles before calling Supabase", async () => {
    await expect(
      requestYouTubePackagingScore({ title: "   " }),
    ).rejects.toThrow(/1–100 characters/);
    await expect(
      requestYouTubePackagingScore({ title: "a".repeat(101) }),
    ).rejects.toThrow(/1–100 characters/);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("calls handleAIError and rejects on 401, 429, or 422 score_invalid errors", async () => {
    const rateLimitErr = Object.assign(new Error("Rate limit exceeded"), {
      status: 429,
    });
    mockInvoke.mockResolvedValueOnce({ data: null, error: rateLimitErr });

    await expect(
      requestYouTubePackagingScore({ title: "Valid title" }),
    ).rejects.toThrow("Rate limit exceeded");
    expect(mockHandleAIError).toHaveBeenCalledWith(
      { status: 429, message: "Rate limit exceeded" },
      "YouTube Packaging Score",
    );

    mockHandleAIError.mockClear();
    mockInvoke.mockResolvedValueOnce({
      data: { error: "score_invalid" },
      error: null,
    });

    await expect(
      requestYouTubePackagingScore({ title: "Valid title" }),
    ).rejects.toThrow("score_invalid");
    expect(mockHandleAIError).toHaveBeenCalledTimes(1);
  });

  it("calls handleAIError and rejects when the returned score payload is malformed", async () => {
    mockInvoke.mockResolvedValueOnce({
      data: {
        score: {
          ...VALID_SCORE,
          better_titles: ["Only one title"],
        },
      },
      error: null,
    });

    await expect(
      requestYouTubePackagingScore({ title: "Valid title" }),
    ).rejects.toThrow("Invalid packaging score response");
    expect(mockHandleAIError).toHaveBeenCalledTimes(1);
  });
});
