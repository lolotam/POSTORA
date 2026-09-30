export const MEDIA_QUOTA_CODE = "MEDIA_QUOTA_DAILY_EXCEEDED";

const MEDIA_QUOTA_FALLBACK = "Daily upload limit reached. Upgrade your plan or try again tomorrow.";

export function isMediaQuotaMessage(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return raw.includes(MEDIA_QUOTA_CODE) || raw.includes("Daily upload limit of ");
}

export function mediaQuotaHumanMessage(raw: string | null | undefined): string {
  if (!raw) return MEDIA_QUOTA_FALLBACK;
  const at = raw.indexOf(MEDIA_QUOTA_CODE);
  if (at >= 0) {
    let rest = raw.slice(at + MEDIA_QUOTA_CODE.length).trim();
    if (rest.startsWith(":")) rest = rest.slice(1).trim();
    return rest || MEDIA_QUOTA_FALLBACK;
  }
  const daily = raw.indexOf("Daily upload limit");
  if (daily >= 0) return raw.slice(daily).trim();
  return MEDIA_QUOTA_FALLBACK;
}

export async function readUploadRefusal(error: unknown): Promise<string | null> {
  const context = (error as { context?: unknown }).context;
  const nested = (context as { response?: unknown } | undefined)?.response;
  const response = context instanceof Response ? context : nested instanceof Response ? nested : undefined;
  if (!response) return error instanceof Error ? error.message : null;
  const payload = await response.clone().json().catch(() => null) as { error?: unknown } | null;
  if (typeof payload?.error === "string") return payload.error;
  return error instanceof Error ? error.message : null;
}
