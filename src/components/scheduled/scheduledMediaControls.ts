export type ScheduledPostType = "feed" | "story" | "reel";

export interface MediaFolderOption {
  id?: string;
  name: string;
  full_path: string;
}

const TYPE_ORDER: ScheduledPostType[] = ["feed", "story", "reel"];

function values(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

export function getScheduledPostTypes(
  metadata: Record<string, any> | null | undefined,
  platforms: string[],
): ScheduledPostType[] {
  const found = new Set<ScheduledPostType>();
  const candidates = [
    metadata?.facebook_post_type,
    metadata?.instagram_post_type,
    metadata?.instagram?.mediaType,
  ];

  for (const candidate of candidates.flatMap(values)) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.toLowerCase() === "stories" ? "story" : candidate.toLowerCase();
    if (TYPE_ORDER.includes(normalized as ScheduledPostType)) {
      found.add(normalized as ScheduledPostType);
    }
  }

  if (found.size === 0 && platforms.some((platform) => platform === "facebook" || platform === "instagram")) {
    found.add("feed");
  }

  return TYPE_ORDER.filter((type) => found.has(type));
}

export function getMediaFolderLabel(
  paths: Array<string | null | undefined>,
  folders: MediaFolderOption[],
): string {
  const normalizedPaths = new Set(paths.map((path) => path || "/"));
  if (normalizedPaths.size > 1) return "Multiple folders";

  const path = normalizedPaths.values().next().value ?? "/";
  if (path === "/") return "Media Library";
  return folders.find((folder) => folder.full_path === path)?.name ?? path;
}
