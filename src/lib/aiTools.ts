// Client-side mirror of messaging-api's ai_upsert_tool validation, for
// immediate form feedback. The server remains authoritative.

export const RESERVED_AI_TOOL_NAMES = [
  "search_knowledge",
  "escalate_to_human",
  "notify_admin",
  "list_connected_accounts",
  "search_posts",
  "get_posting_summary",
  "create_scheduled_post",
] as const;

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,40}$/;

export function validateAiToolName(name: string): string | null {
  if (!TOOL_NAME_RE.test(name)) {
    return "Use snake_case: start with a letter, 3-41 lowercase letters/digits/underscores.";
  }
  if ((RESERVED_AI_TOOL_NAMES as readonly string[]).includes(name)) {
    return `"${name}" is a reserved builtin tool name.`;
  }
  return null;
}

export function validateAiToolUrl(url: string): string | null {
  if (!/^https:\/\/.+/.test(url)) return "URL must start with https://";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "URL is not a valid web address";
  }
  // "https://shop@gmail.com" is user "shop" on host gmail.com, not a shop.
  if (parsed.username || parsed.password) {
    return "URL must not contain an @ before the website name. Enter the website address (https://yourshop.com), not an email.";
  }
  return null;
}
