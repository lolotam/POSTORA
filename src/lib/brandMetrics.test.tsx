import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { compareBrandMetric, matchesMediaTypeFilter } from "./brandMetrics";
import { PostCard } from "@/components/brand-intelligence/PostCard";
import type { BrandPost } from "@/types/brand-intelligence";

const post: BrandPost = { id: "post", mediaType: "VIDEO", caption: "", thumbnailUrl: "", likesCount: null,
  commentsCount: 0, videoViewCount: null, engagementScore: null, timestamp: "2026-11-01T00:00:00Z", permalink: "" };

describe("unavailable discovery measurements", () => {
  it("renders missing metrics as unavailable while retaining measured zero", () => {
    render(<PostCard post={post} index={0} onClick={() => undefined} />);
    expect(screen.getByText("❤️ —")).toBeInTheDocument();
    expect(screen.getByText("💬 0")).toBeInTheDocument();
    expect(screen.getByText("▶️ —")).toBeInTheDocument();
  });

  it("sorts measured zero ahead of unknown and keeps equal measurements deterministic", () => {
    const ordered = [{ ...post, id: "unknown" }, { ...post, id: "b", likesCount: 0 }, { ...post, id: "a", likesCount: 0 }]
      .sort((left, right) => compareBrandMetric(left, right, "likesCount"));
    expect(ordered.map((entry) => entry.id)).toEqual(["a", "b", "unknown"]);
  });
});

// Regression 2026-11-04: on /analytics/instagram?tab=analyze the Video filter showed no Reels and the
// Image filter dropped carousels, because Instagram labels them REEL and CAROUSEL.
describe("media type filter", () => {
  it.each([
    ["video", "REEL", true],
    ["video", "VIDEO", true],
    ["video", "IMAGE", false],
    ["image", "CAROUSEL", true],
    ["image", "IMAGE", true],
    ["image", "REEL", false],
    ["all", "TEXT", true],
  ] as const)("the %s filter keeps a %s post: %s", (filter, mediaType, kept) => {
    expect(matchesMediaTypeFilter({ ...post, mediaType }, filter)).toBe(kept);
  });
});
