export function buildYouTubeSuggestContext(
  type: "title" | "description" | "tags",
  title: string,
  description?: string,
): string {
  if (type === "title") {
    return title;
  }
  if (type === "description") {
    if (!description?.trim()) {
      return title;
    }
    return `Title: ${title}\nDraft Description / Notes: ${description}`;
  }
  return `Title: ${title}\nDescription: ${description || ""}`;
}
