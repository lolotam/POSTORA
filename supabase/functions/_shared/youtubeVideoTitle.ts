/**
 * The one title contract for a YouTube upload.
 *
 * The native request and the composer preview must agree: when no title
 * override was saved, the caption is the title; Shorts are truncated to 90
 * characters and gain #Shorts only when it is not already present. Google,
 * not the hashtag, decides whether a video is a Short.
 */
export function resolveYouTubeVideoTitle(input: {
  title?: string | null;
  caption?: string | null;
  videoType?: "video" | "short";
  fallback?: string;
}): string {
  let title = (input.title ?? "").trim() ||
    (input.caption ?? "").substring(0, 100) ||
    input.fallback ||
    "New Video";
  if (input.videoType === "short" && !title.toLowerCase().includes("#shorts")) {
    title = title.length > 90 ? title.substring(0, 90) + " #Shorts" : title + " #Shorts";
  }
  return title;
}
