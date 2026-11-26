import { describe, expect, it } from "vitest";
import type { YouTubeVideoListItem } from "./types";
import { filterLibraryVideos, isLikelyShort, sortLibraryVideos } from "./videoLibraryView";

const video = (id: string, overrides: Partial<YouTubeVideoListItem> = {}): YouTubeVideoListItem => ({
  id,
  title: id,
  thumbnail_url: null,
  published_at: null,
  privacy_status: null,
  url: `https://www.youtube.com/watch?v=${id}`,
  description: null,
  duration_iso8601: null,
  statistics: { view_count: null, like_count: null, comment_count: null },
  ...overrides,
});

describe("video library view", () => {
  it("detects Shorts from title or description and filters search text", () => {
    const short = video("short-id", { description: "A clip #Shorts today" });
    const normal = video("normal-id", { title: "Long tutorial" });
    expect(isLikelyShort(short)).toBe(true);
    expect(isLikelyShort(normal)).toBe(false);
    expect(filterLibraryVideos([short, normal], "shorts", "").map((item) => item.id)).toEqual(["short-id"]);
    expect(filterLibraryVideos([short, normal], "videos", "").map((item) => item.id)).toEqual(["normal-id"]);
    expect(filterLibraryVideos([short, normal], "all", "clip")).toEqual([short]);
    expect(filterLibraryVideos([short, normal], "all", "NORMAL-ID")).toEqual([normal]);
  });

  it("sorts durations and statistics with nulls last and stable ties", () => {
    const rows = [
      video("a", { duration_iso8601: "PT1M30S", statistics: { view_count: 5, like_count: null, comment_count: null } }),
      video("b", { duration_iso8601: "PT30S", statistics: { view_count: 5, like_count: null, comment_count: null } }),
      video("c"),
    ];
    expect(sortLibraryVideos(rows, "duration", "ascending", { visibilityLabels: {} }).map((item) => item.id)).toEqual(["b", "a", "c"]);
    expect(sortLibraryVideos(rows, "duration", "descending", { visibilityLabels: {} }).map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(sortLibraryVideos(rows, "views", "descending", { visibilityLabels: {} }).map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("sorts localized visibility labels", () => {
    const rows = [video("a", { privacy_status: "private" }), video("b", { privacy_status: "public" }), video("c")];
    expect(sortLibraryVideos(rows, "visibility", "ascending", { visibilityLabels: { private: "Private", public: "Public" } }).map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("sorts titles alphabetically", () => {
    const titled = [video("a", { title: "Beta" }), video("b", { title: "Alpha" })];
    expect(sortLibraryVideos(titled, "video", "ascending", { visibilityLabels: {} }).map((item) => item.id)).toEqual(["b", "a"]);
  });
});
