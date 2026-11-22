/**
 * Provider adapter for the conditional published-video edit.
 *
 * Only the documented videos.get / videos.update contract is used. The item
 * ETag is carried in If-Match and never replaced by a fallback. No credential,
 * request body or provider response reaches a log line.
 */

import type { UpdatePlan, ProviderVideo } from "./editLifecycle.ts";

const DATA_API = "https://www.googleapis.com/youtube/v3";

export type EditReadResult =
  | { ok: true; value: ProviderVideo }
  | { ok: false; code: "reconnect_required" | "not_found" | "upstream_unavailable" };

export type EditWriteResult =
  | { ok: true; id: string }
  | { ok: false; code: "edit_conflict" | "reconnect_required" | "upstream_unavailable" };

export interface YouTubeEditProvider {
  getVideo(accessToken: string, input: { videoId: string; channelId: string }): Promise<EditReadResult>;
  updateVideo(
    accessToken: string,
    input: { videoId: string; plan: UpdatePlan },
  ): Promise<EditWriteResult>;
}

function parseVideo(body: unknown): ProviderVideo | null {
  if (!body || typeof body !== "object") return null;
  const item = body as Record<string, unknown>;
  if (typeof item.id !== "string" || typeof item.etag !== "string") return null;
  const snippet = item.snippet as Record<string, unknown> | undefined;
  const status = item.status as Record<string, unknown> | undefined;
  if (!snippet || typeof snippet.channelId !== "string" || typeof snippet.title !== "string" ||
      typeof snippet.description !== "string" || !status || typeof status.privacyStatus !== "string") {
    return null;
  }
  return {
    id: item.id,
    etag: item.etag,
    snippet: {
      channelId: snippet.channelId,
      title: snippet.title,
      description: snippet.description,
      ...(Array.isArray(snippet.tags) ? { tags: snippet.tags.filter((tag): tag is string => typeof tag === "string") } : {}),
      ...(typeof snippet.categoryId === "string" ? { categoryId: snippet.categoryId } : {}),
      ...(typeof snippet.defaultLanguage === "string" ? { defaultLanguage: snippet.defaultLanguage } : {}),
    },
    status: {
      privacyStatus: status.privacyStatus,
      ...(typeof status.embeddable === "boolean" ? { embeddable: status.embeddable } : {}),
      ...(typeof status.license === "string" ? { license: status.license } : {}),
      ...(typeof status.publicStatsViewable === "boolean" ? { publicStatsViewable: status.publicStatsViewable } : {}),
      ...(typeof status.selfDeclaredMadeForKids === "boolean" ? { selfDeclaredMadeForKids: status.selfDeclaredMadeForKids } : {}),
      ...(typeof status.containsSyntheticMedia === "boolean" ? { containsSyntheticMedia: status.containsSyntheticMedia } : {}),
      ...(typeof status.publishAt === "string" ? { publishAt: status.publishAt } : {}),
    },
  };
}

function readFailure(status: number): EditReadResult {
  if (status === 401 || status === 403) return { ok: false, code: "reconnect_required" };
  if (status === 404) return { ok: false, code: "not_found" };
  return { ok: false, code: "upstream_unavailable" };
}

function writeFailure(status: number): EditWriteResult {
  if (status === 412) return { ok: false, code: "edit_conflict" };
  if (status === 401 || status === 403) return { ok: false, code: "reconnect_required" };
  return { ok: false, code: "upstream_unavailable" };
}

export function createYouTubeEditProvider(args: {
  fetchImpl: typeof fetch;
  timeoutMs?: number;
}): YouTubeEditProvider {
  const timeoutMs = args.timeoutMs ?? 8_000;
  const headers = (token: string) => ({ Authorization: `Bearer ${token}` });
  return {
    async getVideo(accessToken, input) {
      const url = new URL(`${DATA_API}/videos`);
      url.searchParams.set("part", "snippet,status");
      url.searchParams.set("id", input.videoId);
      let response: Response;
      try {
        response = await args.fetchImpl(url, { headers: headers(accessToken), signal: AbortSignal.timeout(timeoutMs) });
      } catch {
        return { ok: false, code: "upstream_unavailable" };
      }
      if (!response.ok) return readFailure(response.status);
      let body: unknown;
      try { body = await response.json(); } catch { return { ok: false, code: "upstream_unavailable" }; }
      const parsed = parseVideo(body);
      if (!parsed || parsed.id !== input.videoId || parsed.snippet.channelId !== input.channelId) {
        return { ok: false, code: "not_found" };
      }
      return { ok: true, value: parsed };
    },
    async updateVideo(accessToken, input) {
      const url = new URL(`${DATA_API}/videos`);
      url.searchParams.set("part", input.plan.parts.join(","));
      let response: Response;
      try {
        response = await args.fetchImpl(url, {
          method: "PUT",
          headers: {
            ...headers(accessToken),
            "Content-Type": "application/json",
            "If-Match": input.plan.ifMatch,
          },
          body: JSON.stringify({ ...input.plan.body, id: input.videoId }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return { ok: false, code: "upstream_unavailable" };
      }
      if (!response.ok) return writeFailure(response.status);
      let body: unknown;
      try { body = await response.json(); } catch { return { ok: false, code: "upstream_unavailable" }; }
      const parsed = parseVideo(body);
      if (!parsed || parsed.id !== input.videoId) return { ok: false, code: "upstream_unavailable" };
      return { ok: true, id: parsed.id };
    },
  };
}
