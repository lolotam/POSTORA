/** Stable prefix raised by enforce_media_quota_on_insert. */
export const MEDIA_QUOTA_CODE = "MEDIA_QUOTA_DAILY_EXCEEDED";

const FALLBACK = "Daily upload limit reached. Upgrade your plan or try again tomorrow.";

export function isMediaQuotaMessage(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return raw.includes(MEDIA_QUOTA_CODE) || raw.includes("Daily upload limit of ");
}

/** The sentence after the prefix. A missing limit falls back to a sentence without a fake number. */
export function mediaQuotaHumanMessage(raw: string | null | undefined): string {
  if (!raw) return FALLBACK;
  const at = raw.indexOf(MEDIA_QUOTA_CODE);
  if (at >= 0) {
    let rest = raw.slice(at + MEDIA_QUOTA_CODE.length).trim();
    if (rest.startsWith(":")) rest = rest.slice(1).trim();
    return rest || FALLBACK;
  }
  const daily = raw.indexOf("Daily upload limit");
  if (daily >= 0) return raw.slice(daily).trim();
  return FALLBACK;
}

export function mediaQuotaBody(limit: number): {
  success: false;
  error: string;
  code: typeof MEDIA_QUOTA_CODE;
} {
  return {
    success: false,
    error: `Daily upload limit of ${limit} reached. Upgrade your plan or try again tomorrow.`,
    code: MEDIA_QUOTA_CODE,
  };
}

/** Every entry is a quota refusal. Mixed failures return null so the caller keeps its own status. */
export function quotaOnlyMessage(errors: string[]): string | null {
  if (errors.length === 0) return null;
  const humans: string[] = [];
  for (const error of errors) {
    if (!isMediaQuotaMessage(error)) return null;
    humans.push(mediaQuotaHumanMessage(error));
  }
  return humans[0] ?? null;
}

/** supabase-js leaves the function body on error.context when data is null. */
export async function invokeErrorText(error: unknown): Promise<string | null> {
  if (!error || typeof error !== "object") return null;
  const context = (error as { context?: unknown }).context;
  const nested = (context as { response?: unknown } | undefined)?.response;
  const response = context instanceof Response ? context : nested instanceof Response ? nested : undefined;
  if (!response) return null;
  const payload = await response.clone().json().catch(() => null) as { error?: unknown } | null;
  return typeof payload?.error === "string" ? payload.error : null;
}
