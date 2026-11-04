import { assertEquals } from "jsr:@std/assert@1";
import { filterBrandPosts, normalizeBrandHandle } from "./analyticsFilters.ts";

Deno.test("brand filters preserve UI media families, date windows and unknown metric ordering", () => {
  const now = Date.parse("2026-11-04T00:00:00Z");
  const posts = ["IMAGE", "CAROUSEL", "VIDEO", "REEL"].map((mediaType, index) => ({
    id: String(index), mediaType, engagementScore: index === 0 ? null : index,
    timestamp: new Date(now - index * 40 * 86400000).toISOString(),
  }));
  for (const [filter, expected] of [["all", ["3", "2", "1", "0"]], ["image", ["1", "0"]], ["video", ["3", "2"]], ["reel", ["3"]], ["carousel", ["1"]]] as const) {
    const response = filterBrandPosts({ posts }, { media_type: filter }, now) as { posts: { id: string }[] };
    assertEquals(response.posts.map((post) => post.id), [...expected]);
  }
  const recent = filterBrandPosts({ posts }, { period: "3m", min_engagement: 2 }, now) as { posts: { id: string }[] };
  assertEquals(recent.posts.map((post) => post.id), ["2"]);
  const oldest = filterBrandPosts({ posts }, { sort: "oldest" }, now) as { posts: { id: string }[] };
  assertEquals(oldest.posts.map((post) => post.id), ["3", "2", "1", "0"]);
  const undated = [...posts, { id: "x", mediaType: "IMAGE", engagementScore: 1, timestamp: "not a date" }];
  for (const sort of ["newest", "oldest"] as const) {
    const sorted = filterBrandPosts({ posts: undated }, { sort }, now) as { posts: { id: string }[] };
    assertEquals(sorted.posts.at(-1)?.id, "x", sort);
  }
});

Deno.test("profile URLs cannot inject another host or a provider path", () => {
  for (const url of ["https://instagram.com.attacker.invalid/name", "https://user:pass@instagram.com/name", "https://instagram.com/p/post", "https://facebook.com/name"]) {
    assertEquals(normalizeBrandHandle(url, "instagram"), null);
  }
  assertEquals(normalizeBrandHandle("https://www.instagram.com/Brand/", "instagram"), "brand");
  assertEquals(normalizeBrandHandle("https://facebook.com/profile.php?id=123", "facebook"), "123");
  assertEquals(normalizeBrandHandle("https://facebook.com/pages/Brand/123", "facebook"), "123");
  assertEquals(normalizeBrandHandle("instagram.com/Brand/", "instagram"), "brand");
});
