import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PostCard } from "../PostCard";
import type { BrandPost } from "@/types/brand-intelligence";

type MediaType = BrandPost["mediaType"];
const post = (mediaType: MediaType, videoViewCount: number | null | undefined): BrandPost => ({
  id: "p1", mediaType, thumbnailUrl: "", caption: "", likesCount: 1, commentsCount: 0, engagementScore: 1,
  timestamp: "2026-10-30T08:00:00Z", permalink: "https://www.instagram.com/p/1", videoViewCount,
});

describe("brand PostCard views badge", () => {
  it.each<[MediaType, number | null | undefined]>([
    ["IMAGE", null], ["CAROUSEL", null], ["TEXT", null],
    ["IMAGE", undefined], ["CAROUSEL", undefined], ["VIDEO", undefined], ["REEL", undefined],
  ])("hides the views badge on a %s post when the view count is %s", (mediaType, count) => {
    render(<PostCard post={post(mediaType, count)} index={0} onClick={() => undefined} />);
    expect(screen.queryByText(/▶️/)).not.toBeInTheDocument();
  });

  it.each<[MediaType, number | null, string]>([
    ["VIDEO", null, "—"], ["REEL", null, "—"], ["IMAGE", 0, "0"], ["VIDEO", 5, "5"],
  ])("shows the views badge on a %s post with %s views as %s", (mediaType, count, text) => {
    render(<PostCard post={post(mediaType, count)} index={0} onClick={() => undefined} />);
    expect(screen.getByText(`▶️ ${text}`)).toBeInTheDocument();
  });
});
