import { z } from "npm:zod@3.23.8";
import { classifyGoogleError, type YouTubeErrorClass } from "../_shared/youtubeApiErrors.ts";
import type { YouTubeChannelDetails, YouTubeResourceErrorCode } from "./contracts.ts";

const DATA_API = "https://www.googleapis.com/youtube/v3";

export const YOUTUBE_READ_TIMEOUT_MS = 15_000;

export type YouTubeReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: YouTubeResourceErrorCode; unauthorized: boolean };

export interface YouTubeReadClient {
  getChannel(accessToken: string, input: { channelId: string }): Promise<YouTubeReadResult<YouTubeChannelDetails>>;
}

export interface YouTubeReadClientOptions {
  fetchImpl: typeof fetch;
  uploadsPlaylistIdFor(channelId: string): string;
  timeoutMs?: number;
}

const CODE_BY_CLASS: Record<YouTubeErrorClass, YouTubeResourceErrorCode> = {
  scope_missing: "missing_scope",
  quota: "quota_exceeded",
  unauthorized: "reconnect_required",
  not_found: "not_found",
  forbidden: "not_found",
  upstream: "upstream_unavailable",
};

interface FailedRead {
  ok: false;
  code: YouTubeResourceErrorCode;
  unauthorized: boolean;
  status: number;
}

type ReadBody =
  | { ok: true; body: unknown }
  | FailedRead;

// Google counts come back as decimal strings; a non-finite value is absent data, not zero.
function count(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// First of medium, high, default; Google may omit any of them.
function thumbnail(thumbnails: unknown): string | null {
  if (!thumbnails || typeof thumbnails !== "object" || Array.isArray(thumbnails)) return null;
  const record = thumbnails as Record<string, unknown>;
  for (const key of ["medium", "high", "default"]) {
    const size = record[key];
    if (size && typeof size === "object" && !Array.isArray(size)) {
      const url = (size as Record<string, unknown>).url;
      if (typeof url === "string" && url.length > 0) return url;
    }
  }
  return null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

const ChannelItemSchema = z.object({
  id: z.string().optional(),
  snippet: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    customUrl: z.string().optional(),
    publishedAt: z.string().optional(),
    country: z.string().optional(),
    thumbnails: z.unknown().optional(),
  }).optional(),
  statistics: z.object({
    viewCount: z.unknown().optional(),
    subscriberCount: z.unknown().optional(),
    hiddenSubscriberCount: z.boolean().optional(),
    videoCount: z.unknown().optional(),
  }).optional(),
  status: z.object({
    privacyStatus: z.string().optional(),
  }).optional(),
});

const ChannelListSchema = z.object({
  items: z.array(ChannelItemSchema).optional(),
});

function channelFromItem(item: z.infer<typeof ChannelItemSchema>, channelId: string): YouTubeChannelDetails {
  const hidden = item.statistics?.hiddenSubscriberCount === true;
  return {
    id: item.id ?? channelId,
    title: item.snippet?.title ?? "",
    description: item.snippet?.description ?? "",
    custom_url: optionalString(item.snippet?.customUrl),
    thumbnail_url: thumbnail(item.snippet?.thumbnails),
    published_at: optionalString(item.snippet?.publishedAt),
    country: optionalString(item.snippet?.country),
    privacy_status: optionalString(item.status?.privacyStatus),
    statistics: {
      view_count: count(item.statistics?.viewCount),
      subscriber_count: hidden ? null : count(item.statistics?.subscriberCount),
      subscriber_count_hidden: hidden,
      video_count: count(item.statistics?.videoCount),
    },
  };
}

export function createYouTubeReadClient(options: YouTubeReadClientOptions): YouTubeReadClient {
  // One provider read. The body is read as unknown and validated by the caller's Zod
  // schema; failures carry an internal status that public results drop.
  async function send(
    path: string,
    query: Record<string, string>,
    accessToken: string,
  ): Promise<ReadBody> {
    let response: Response;
    try {
      response = await options.fetchImpl(`${DATA_API}/${path}?${new URLSearchParams(query)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(options.timeoutMs ?? YOUTUBE_READ_TIMEOUT_MS),
      });
    } catch {
      // Network failure, abort or timeout: stable code, never the fetch error text.
      return { ok: false, code: "upstream_unavailable", unauthorized: false, status: 0 };
    }
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) return { ok: true, body };
    const kind = classifyGoogleError(response.status, body);
    return { ok: false, code: CODE_BY_CLASS[kind], unauthorized: kind === "unauthorized", status: response.status };
  }

  return {
    getChannel: async (accessToken, input): Promise<YouTubeReadResult<YouTubeChannelDetails>> => {
      const read = await send(
        "channels",
        { part: "snippet,statistics,status", mine: "true", maxResults: "50" },
        accessToken,
      );
      if (!read.ok) return { ok: false, code: read.code, unauthorized: read.unauthorized };
      const parsed = ChannelListSchema.safeParse(read.body);
      if (!parsed.success) return { ok: false, code: "upstream_unavailable", unauthorized: false };
      const item = (parsed.data.items ?? []).find((entry) => entry.id === input.channelId);
      if (!item) {
        // The stored grant no longer covers the stored channel: a reconnect fixes it.
        return { ok: false, code: "reconnect_required", unauthorized: false };
      }
      return { ok: true, value: channelFromItem(item, input.channelId) };
    },
  };
}
