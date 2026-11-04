// Display filters operate on this page only; report totals and continuation retain upstream scope.
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function matchesMedia(post: Record<string, unknown>, filter: string): boolean {
  if (filter === "all") return true;
  const raw = String(post.mediaType ?? "").toUpperCase();
  const type = post.format === "reel" || post.mediaProductType === "REELS" ? "REEL" : raw === "CAROUSEL_ALBUM" ? "CAROUSEL" : raw;
  const types: Record<string, string[]> = { image: ["IMAGE", "CAROUSEL"], video: ["VIDEO", "REEL"], reel: ["REEL"], carousel: ["CAROUSEL"] };
  return types[filter]?.includes(type) ?? false;
}

export function filterAccountMedia(body: unknown, filter: string): unknown {
  const report = record(body);
  const media = record(report.media);
  const page = record(media.page);
  if (!Array.isArray(page.items)) return body;
  const items = page.items.filter((post) => matchesMedia(record(post), filter));
  return { ...report, media: { ...media, page: { ...page, items, returned: items.length,
    // The legacy cursor is a tuple; expose a string that can be passed back directly by an agent.
    nextCursor: page.nextCursor ? JSON.stringify(page.nextCursor) : null } } };
}

export function normalizeBrandHandle(raw: string, platform: string): string | null {
  let handle = raw.trim();
  if (/^(www\.)?(instagram|facebook)\.com\//i.test(handle)) handle = `https://${handle}`;
  if (/^https?:\/\//i.test(handle)) {
    try {
      const url = new URL(handle);
      const hosts = platform === "instagram" ? ["instagram.com", "www.instagram.com"] : ["facebook.com", "www.facebook.com", "m.facebook.com"];
      if (!hosts.includes(url.hostname) || url.username || url.password) return null;
      const parts = url.pathname.split("/").filter(Boolean);
      if (platform === "facebook" && parts[0] === "profile.php") handle = url.searchParams.get("id") ?? "";
      else if (parts.length === 1) handle = parts[0];
      else if (platform === "facebook" && ["pages", "people"].includes(parts[0]) && parts.length === 3 && /^\d+$/.test(parts[2])) handle = parts[2];
      else return null;
    } catch { return null; }
  }
  handle = handle.replace(/^@+/, "").trim().toLowerCase();
  const valid = platform === "instagram" ? /^[a-z0-9._]{1,30}$/.test(handle) && !handle.includes("..") : /^[a-z0-9._-]{1,100}$/.test(handle);
  return valid ? handle : null;
}

type BrandFilters = { media_type?: string; period?: string; sort?: string; min_engagement?: number };
export function filterBrandPosts(body: unknown, filters: BrandFilters, now = Date.now()): unknown {
  const report = record(body);
  if (!Array.isArray(report.posts)) return body;
  const days: Record<string, number> = { "30d": 30, "3m": 90, "6m": 180, "1y": 365 };
  const cutoff = filters.period && days[filters.period] ? now - days[filters.period] * 86400000 : null;
  const posts = report.posts.map(record).filter((post) => matchesMedia(post, filters.media_type ?? "all") &&
    (cutoff === null || Date.parse(String(post.timestamp)) > cutoff) &&
    (!filters.min_engagement || typeof post.engagementScore === "number" && post.engagementScore >= filters.min_engagement));
  const metrics: Record<string, string> = { engagement: "engagementScore", likes: "likesCount", comments: "commentsCount", views: "videoViewCount", shares: "sharesCount", saves: "savesCount" };
  const sort = filters.sort ?? "engagement";
  posts.sort((left, right) => {
    if (sort === "newest" || sort === "oldest") {
      // An unreadable timestamp sorts last in either direction instead of breaking the comparator.
      const instant = (post: Record<string, unknown>) => Date.parse(String(post.timestamp));
      const rightAt = instant(right), leftAt = instant(left);
      if (Number.isNaN(rightAt) || Number.isNaN(leftAt)) return Number(Number.isNaN(leftAt)) - Number(Number.isNaN(rightAt));
      const delta = rightAt - leftAt;
      return sort === "oldest" ? -delta : delta;
    }
    const a = left[metrics[sort]], b = right[metrics[sort]];
    const knownA = typeof a === "number" && Number.isFinite(a), knownB = typeof b === "number" && Number.isFinite(b);
    if (knownA !== knownB) return knownA ? -1 : 1;
    return (knownA && knownB ? Number(b) - Number(a) : 0) || String(left.id).localeCompare(String(right.id));
  });
  return { ...report, posts };
}
