import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { YouTubePackagingScoreCard } from "../YouTubePackagingScoreCard";
import type { PackagingScore } from "@/lib/youtubePackagingScoreClient";

beforeEach(cleanup);

const SAMPLE_SCORE_WITHOUT_SYNERGY: PackagingScore = {
  overall_score: 79,
  breakdown: {
    hook: 82,
    clarity: 74,
    mobile_length: 80,
    thumbnail_synergy: null,
  },
  strengths: ["Strong opening keyword", "Mobile-friendly length"],
  fixes: ["Make the benefit more specific"],
  better_titles: [
    "How to Build a YouTube Studio on a $200 Budget",
    "My $200 YouTube Studio Setup (Full Gear Breakdown)",
    "Look Pro for $200: The Budget YouTube Studio Guide",
  ],
};

describe("YouTubePackagingScoreCard", () => {
  it("disables the score button when the title is blank and enables it when a title is present", () => {
    const requestScore = vi.fn();
    const onApplyTitle = vi.fn();
    const { rerender } = render(
      <YouTubePackagingScoreCard
        title="   "
        requestScore={requestScore}
        onApplyTitle={onApplyTitle}
      />,
    );

    expect(screen.getByTestId("youtube-packaging-score-button")).toBeDisabled();

    rerender(
      <YouTubePackagingScoreCard
        title="Budget YouTube Studio"
        requestScore={requestScore}
        onApplyTitle={onApplyTitle}
      />,
    );

    expect(screen.getByTestId("youtube-packaging-score-button")).not.toBeDisabled();
  });

  it("renders overall score, 4 breakdown rows, strengths, fixes, disclaimer, and null synergy hint", async () => {
    const requestScore = vi.fn().mockResolvedValue(SAMPLE_SCORE_WITHOUT_SYNERGY);
    const onApplyTitle = vi.fn();

    render(
      <YouTubePackagingScoreCard
        title="Budget YouTube Studio"
        description="Gear breakdown"
        requestScore={requestScore}
        onApplyTitle={onApplyTitle}
      />,
    );

    expect(screen.getByTestId("youtube-packaging-score-disclaimer")).toHaveTextContent(
      "AI estimate, not a YouTube metric",
    );

    fireEvent.click(screen.getByTestId("youtube-packaging-score-button"));

    await waitFor(() =>
      expect(screen.getByTestId("youtube-packaging-overall-score")).toHaveTextContent("79/100"),
    );

    expect(requestScore).toHaveBeenCalledWith({
      title: "Budget YouTube Studio",
      description: "Gear breakdown",
      language: "english",
    });
    expect(screen.getByText("Hook")).toBeInTheDocument();
    expect(screen.getByText("Clarity")).toBeInTheDocument();
    expect(screen.getByText("Mobile length")).toBeInTheDocument();
    expect(screen.getByText("Thumbnail synergy")).toBeInTheDocument();
    expect(screen.getByTestId("youtube-packaging-synergy-empty")).toHaveTextContent(
      "Describe your thumbnail to score this",
    );
    expect(screen.getByText("Strong opening keyword")).toBeInTheDocument();
    expect(screen.getByText("Make the benefit more specific")).toBeInTheDocument();
  });

  it("passes thumbnailText to requestScore and applies a chosen alternative title via onApplyTitle", async () => {
    const scoreWithSynergy: PackagingScore = {
      ...SAMPLE_SCORE_WITHOUT_SYNERGY,
      overall_score: 86,
      breakdown: {
        ...SAMPLE_SCORE_WITHOUT_SYNERGY.breakdown,
        thumbnail_synergy: 92,
      },
    };
    const requestScore = vi.fn().mockResolvedValue(scoreWithSynergy);
    const onApplyTitle = vi.fn();

    render(
      <YouTubePackagingScoreCard
        title="Budget YouTube Studio"
        requestScore={requestScore}
        onApplyTitle={onApplyTitle}
      />,
    );

    fireEvent.change(screen.getByTestId("youtube-packaging-thumbnail-text"), {
      target: { value: "Split screen $200 vs $2,000 camera quality" },
    });
    fireEvent.click(screen.getByTestId("youtube-packaging-score-button"));

    await waitFor(() =>
      expect(screen.getByTestId("youtube-packaging-overall-score")).toHaveTextContent("86/100"),
    );
    expect(requestScore).toHaveBeenCalledWith({
      title: "Budget YouTube Studio",
      thumbnailText: "Split screen $200 vs $2,000 camera quality",
      language: "english",
    });
    expect(screen.queryByTestId("youtube-packaging-synergy-empty")).not.toBeInTheDocument();
    expect(screen.getByText("92/100")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("youtube-packaging-use-title-1"));
    expect(onApplyTitle).toHaveBeenCalledWith(
      "My $200 YouTube Studio Setup (Full Gear Breakdown)",
    );
  });

  it("shows an inline alert when requestScore rejects", async () => {
    const requestScore = vi.fn().mockRejectedValue(new Error("AI unavailable"));
    const onApplyTitle = vi.fn();

    render(
      <YouTubePackagingScoreCard
        title="Budget YouTube Studio"
        requestScore={requestScore}
        onApplyTitle={onApplyTitle}
      />,
    );

    fireEvent.click(screen.getByTestId("youtube-packaging-score-button"));

    const alert = await screen.findByTestId("youtube-packaging-score-error");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent("Could not score title and thumbnail right now. Try again.");
  });

  it("invalidates an in-flight score request when title changes and ignores its stale response", async () => {
    let resolveFirst!: (value: PackagingScore) => void;
    const requestScore = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<PackagingScore>((res) => {
            resolveFirst = res;
          }),
      )
      .mockResolvedValueOnce({
        ...SAMPLE_SCORE_WITHOUT_SYNERGY,
        overall_score: 91,
      });
    const onApplyTitle = vi.fn();

    const { rerender } = render(
      <YouTubePackagingScoreCard
        title="First Title"
        requestScore={requestScore}
        onApplyTitle={onApplyTitle}
      />,
    );

    fireEvent.click(screen.getByTestId("youtube-packaging-score-button"));
    expect(screen.getByTestId("youtube-packaging-score-button")).toBeDisabled();

    // Change title while first request is still pending
    rerender(
      <YouTubePackagingScoreCard
        title="Second Title"
        requestScore={requestScore}
        onApplyTitle={onApplyTitle}
      />,
    );
    expect(screen.getByTestId("youtube-packaging-score-button")).not.toBeDisabled();

    // Stale first request resolves -> must be ignored
    resolveFirst(SAMPLE_SCORE_WITHOUT_SYNERGY);
    await Promise.resolve();
    expect(screen.queryByTestId("youtube-packaging-overall-score")).not.toBeInTheDocument();

    // Scoring the second title succeeds
    fireEvent.click(screen.getByTestId("youtube-packaging-score-button"));
    await waitFor(() =>
      expect(screen.getByTestId("youtube-packaging-overall-score")).toHaveTextContent("91/100"),
    );
  });

  it("ignores a late resolution after component unmount", async () => {
    let resolveScore!: (value: PackagingScore) => void;
    const requestScore = vi.fn().mockImplementationOnce(
      () =>
        new Promise<PackagingScore>((res) => {
          resolveScore = res;
        }),
    );

    const { unmount } = render(
      <YouTubePackagingScoreCard
        title="Unmount Title"
        requestScore={requestScore}
        onApplyTitle={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("youtube-packaging-score-button"));
    unmount();

    resolveScore(SAMPLE_SCORE_WITHOUT_SYNERGY);
    await Promise.resolve();
    expect(requestScore).toHaveBeenCalledTimes(1);
  });
});
