export type YouTubeErrorClass =
  | "scope_missing"
  | "quota"
  | "unauthorized"
  | "not_found"
  | "forbidden"
  | "upstream";

const QUOTA_REASONS = new Set([
  "quotaExceeded",
  "dailyLimitExceeded",
  "rateLimitExceeded",
  "userRateLimitExceeded",
]);

function firstReason(body: unknown): string {
  const errors = (body as {
    error?: { errors?: Array<{ reason?: string }> };
  } | null)?.error?.errors;
  return Array.isArray(errors) && typeof errors[0]?.reason === "string"
    ? errors[0].reason
    : "";
}

export function classifyGoogleError(
  status: number,
  body: unknown,
): YouTubeErrorClass {
  const reason = firstReason(body);
  if (reason === "insufficientPermissions") return "scope_missing";
  if (status === 429 || QUOTA_REASONS.has(reason)) return "quota";
  if (status === 401 || reason === "authError") return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 403) return "forbidden";
  return "upstream";
}

// Composio surfaces the upstream failure as one string; the Google reason is usually inside it.
export function classifyComposioError(
  message: string | undefined,
): YouTubeErrorClass {
  const text = message ?? "";
  if (
    /insufficientPermissions|insufficient authentication scopes/i.test(text)
  ) {
    return "scope_missing";
  }
  if (/quota|rateLimitExceeded|dailyLimitExceeded/i.test(text)) return "quota";
  if (/\b401\b|unauthori[sz]ed|invalid_grant|authError/i.test(text)) {
    return "unauthorized";
  }
  if (/\b404\b|not ?found/i.test(text)) return "not_found";
  if (/\b403\b|forbidden/i.test(text)) return "forbidden";
  return "upstream";
}
