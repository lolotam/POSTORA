/**
 * How a YouTube video is named when its title is unavailable. One rule, read by the Comment
 * Manager (post label) and the workflow form (scope picker), so the two never show a video
 * under different names.
 */
export function videoLabel(id: string, title: string | null | undefined): string {
  const trimmed = (title ?? "").trim();
  return trimmed ? trimmed.slice(0, 80) : `Video ${id.slice(-6)}`;
}
