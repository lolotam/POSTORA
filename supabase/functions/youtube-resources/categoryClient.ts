/**
 * Provider adapter for YouTube's read-only videoCategories.list contract.
 *
 * This is the only path that may claim a COMPLETE regional catalog. The
 * committed list in categories.ts is an explicitly labelled fallback used when
 * this adapter is unavailable. No credential or region data is logged.
 */

import { approvedYouTubeRegion, youtubeCategoryLocale } from "./categories.ts";
import type { YouTubeCategoryOption } from "./categories.ts";

const CATEGORIES_ENDPOINT = "https://www.googleapis.com/youtube/v3/videoCategories";

export type CategoryListResult =
  | { ok: true; value: YouTubeCategoryOption[]; region: string; locale: string }
  | {
    ok: false;
    code: "quota_exceeded" | "reconnect_required" | "upstream_unavailable" | "invalid_request";
    retryAfterSeconds?: number;
  };

export interface YouTubeCategoryClient {
  list(
    accessToken: string,
    input: { region?: unknown; locale?: unknown },
  ): Promise<CategoryListResult>;
}

function numericId(id: string): number {
  const value = Number(id);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

/** Maps only the documented videoCategories.list snippet fields. */
export function parseVideoCategoriesResponse(
  body: unknown,
  locale: "en" | "ar",
): YouTubeCategoryOption[] | null {
  if (!body || typeof body !== "object") return null;
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  const options: YouTubeCategoryOption[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as Record<string, unknown>;
    const id = item.id;
    const snippet = item.snippet;
    if (typeof id !== "string" || !/^\d{1,4}$/.test(id) || !snippet || typeof snippet !== "object") {
      return null;
    }
    const fields = snippet as Record<string, unknown>;
    if (typeof fields.title !== "string" || typeof fields.assignable !== "boolean") return null;
    const localized = fields.localized as Record<string, { title?: string }> | undefined;
    const name = locale === "ar" ? localized?.ar?.title ?? fields.title : fields.title;
    options.push({
      id,
      name,
      label: `\u2068${id}\u2069 (${name})`,
      assignable: fields.assignable,
    });
  }
  if (options.length === 0) return null;
  return options.sort((a, b) => numericId(a.id) - numericId(b.id) || a.id.localeCompare(b.id));
}

function failureFromStatus(status: number, retryAfter: number | null): CategoryListResult {
  if (status === 401 || status === 403) return { ok: false, code: "reconnect_required" };
  if (status === 429) {
    return { ok: false, code: "quota_exceeded", retryAfterSeconds: retryAfter ?? 3600 };
  }
  if (status >= 400 && status < 500) return { ok: false, code: "invalid_request" };
  return { ok: false, code: "upstream_unavailable" };
}

export function createYouTubeCategoryClient(args: {
  fetchImpl: typeof fetch;
  timeoutMs?: number;
}): YouTubeCategoryClient {
  const timeoutMs = args.timeoutMs ?? 8_000;
  return {
    async list(accessToken, input) {
      const region = approvedYouTubeRegion(input.region);
      const locale = youtubeCategoryLocale(input.locale);
      let response: Response;
      try {
        const url = new URL(CATEGORIES_ENDPOINT);
        url.searchParams.set("part", "snippet");
        url.searchParams.set("regionCode", region);
        url.searchParams.set("hl", locale);
        response = await args.fetchImpl(url, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return { ok: false, code: "upstream_unavailable" };
      }
      if (!response.ok) {
        const retryHeader = response.headers.get("retry-after");
        const retryAfter = retryHeader === null ? null : Number(retryHeader);
        return failureFromStatus(
          response.status,
          retryAfter !== null && Number.isFinite(retryAfter) ? retryAfter : null,
        );
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { ok: false, code: "upstream_unavailable" };
      }
      const value = parseVideoCategoriesResponse(body, locale);
      if (!value) return { ok: false, code: "upstream_unavailable" };
      return { ok: true, value, region, locale };
    },
  };
}
