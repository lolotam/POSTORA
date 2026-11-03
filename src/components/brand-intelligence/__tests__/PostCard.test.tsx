import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PostCard } from "../PostCard";
import type { BrandPost } from "@/types/brand-intelligence";

const post = (videoViewCount: number | null | undefined): BrandPost => ({
  id: "p1", mediaType: "IMAGE", thumbnailUrl: "", caption: "", likesCount: 1, commentsCount: 0, engagementScore: 1,
  timestamp: "2026-10-30T08:00:00Z", permalink: "https://www.instagram.com/p/1", videoViewCount,
});

describe("brand PostCard views badge", () => {
  it.each([[null], [undefined]])("hides the views badge when the view count is %s", (count) => {
    render(<PostCard post={post(count)} index={0} onClick={() => undefined} />);
    expect(screen.queryByText(/▶️/)).not.toBeInTheDocument();
  });

  it.each([[0, "0"], [5, "5"]])("shows a measured view count of %s", (count, text) => {
    render(<PostCard post={post(count)} index={0} onClick={() => undefined} />);
    expect(screen.getByText(`▶️ ${text}`)).toBeInTheDocument();
  });
});
