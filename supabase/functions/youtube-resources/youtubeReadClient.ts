import { z } from "npm:zod@3.23.8";
import { classifyGoogleError, type YouTubeErrorClass } from "../_shared/youtubeApiErrors.ts";
import type {
  YouTubeChannelDetails,
  YouTubeResourceErrorCode,
  YouTubeVideoDetails,
  YouTubeVideoListItem,
  YouTubeVideosPage,
} from "./contracts.ts";

const DATA_API = "https://www.googleapis.com/youtube/v3";

export const YOUTUBE_READ_TIMEOUT_MS = 15_000;

export type YouTubeReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: YouTubeResourceErrorCode; unauthorized: boolean };

export interface YouTubeReadClient {
  getChannel(accessToken: string, input: { channelId: string }): Promise<YouTubeReadResult<YouTubeChannelDetails>>;
  listUploads(
    accessToken: string,
    input: { channelId: string; pageSize: number; pageToken?: string },
  ): Promise<YouTubeReadResult<YouTubeVideosPage>>;
  getVideo(
    accessToken: string,
    input: { channelId: string; videoId: string },
  ): Promise<YouTubeReadResult<YouTubeVideoDetails>>;
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

const PlaylistItemSchema = z.object({
  snippet: z.object({
    title: z.string().optional(),
    publishedAt: z.string().optional(),
    resourceId: z.object({ videoId: z.string().optional() }).optional(),
    thumbnails: z.unknown().optional(),
  }).optional(),
  contentDetails: z.object({
    videoId: z.string().optional(),
    videoPublishedAt: z.string().optional(),
  }).optional(),
  status: z.object({
    privacyStatus: z.string().optional(),
  }).optional(),
});

const PlaylistItemsSchema = z.object({
  nextPageToken: z.string().optional(),
  pageInfo: z.object({ totalResults: z.unknown().optional() }).optional(),
  items: z.array(PlaylistItemSchema).optional(),
});

const VideoItemSchema = z.object({
  id: z.string().optional(),
  snippet: z.object({
    channelId: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    publishedAt: z.string().optional(),
    tags: z.array(z.string()).optional(),
    categoryId: z.string().optional(),
    defaultLanguage: z.string().optional(),
    thumbnails: z.unknown().optional(),
  }).optional(),
  contentDetails: z.object({
    duration: z.string().optional(),
  }).optional(),
  statistics: z.object({
    viewCount: z.unknown().optional(),
    likeCount: z.unknown().optional(),
    commentCount: z.unknown().optional(),
  }).optional(),
  status: z.object({
    privacyStatus: z.string().optional(),
    uploadStatus: z.string().optional(),
    madeForKids: z.boolean().optional(),
  }).optional(),
});

const VideoListSchema = z.object({
  items: z.array(VideoItemSchema).optional(),
});

function videoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
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

    listUploads: async (accessToken, input): Promise<YouTubeReadResult<YouTubeVideosPage>> => {
      // The playlist ID is derived here and nowhere else: no caller names a playlist.
      const query: Record<string, string> = {
        part: "snippet,contentDetails,status",
        playlistId: options.uploadsPlaylistIdFor(input.channelId),
        maxResults: String(input.pageSize),
      };
      if (input.pageToken !== undefined) query.pageToken = input.pageToken;
      const read = await send("playlistItems", query, accessToken);
      if (!read.ok) {
        // A stale or copied cursor is a client error, not an upstream failure.
        const code: YouTubeResourceErrorCode = read.status === 400 && input.pageToken !== undefined
          ? "invalid_cursor"
          : read.code;
        return { ok: false, code, unauthorized: read.unauthorized };
      }
      const parsed = PlaylistItemsSchema.safeParse(read.body);
      if (!parsed.success) return { ok: false, code: "upstream_unavailable", unauthorized: false };
      const items: YouTubeVideoListItem[] = [];
      for (const entry of parsed.data.items ?? []) {
        const id = entry.contentDetails?.videoId ?? entry.snippet?.resourceId?.videoId;
        // playlistItems rows can carry promoted/deleted entries without a video id.
        if (!id) continue;
        items.push({
          id,
          title: entry.snippet?.title ?? "",
          thumbnail_url: thumbnail(entry.snippet?.thumbnails),
          published_at: entry.contentDetails?.videoPublishedAt ?? entry.snippet?.publishedAt ?? null,
          privacy_status: optionalString(entry.status?.privacyStatus),
          url: videoUrl(id),
        });
      }
      return {
        ok: true,
        value: {
          items,
          next_page_token: parsed.data.nextPageToken ?? null,
          total_results: count(parsed.data.pageInfo?.totalResults),
        },
      };
    },

    getVideo: async (accessToken, input): Promise<YouTubeReadResult<YouTubeVideoDetails>> => {
      const read = await send("videos", { part: "snippet,contentDetails,statistics,status", id: input.videoId }, accessToken);
      if (!read.ok) return { ok: false, code: read.code, unauthorized: read.unauthorized };
      const parsed = VideoListSchema.safeParse(read.body);
      if (!parsed.success) return { ok: false, code: "upstream_unavailable", unauthorized: false };
      const item = (parsed.data.items ?? [])[0];
      // A foreign video and an absent one are the same not_found, so this endpoint
      // cannot look up videos outside the connected channel.
      if (!item || item.snippet?.channelId !== input.channelId) {
        return { ok: false, code: "not_found", unauthorized: false };
      }
      return {
        ok: true,
        value: {
          id: item.id ?? input.videoId,
          channel_id: input.channelId,
          title: item.snippet?.title ?? "",
          description: item.snippet?.description ?? "",
          thumbnail_url: thumbnail(item.snippet?.thumbnails),
          published_at: optionalString(item.snippet?.publishedAt),
          tags: item.snippet?.tags ?? [],
          category_id: optionalString(item.snippet?.categoryId),
          default_language: optionalString(item.snippet?.defaultLanguage),
          duration_iso8601: optionalString(item.contentDetails?.duration),
          privacy_status: optionalString(item.status?.privacyStatus),
          upload_status: optionalString(item.status?.uploadStatus),
          made_for_kids: item.status?.madeForKids ?? null,
          statistics: {
            view_count: count(item.statistics?.viewCount),
            like_count: count(item.statistics?.likeCount),
            comment_count: count(item.statistics?.commentCount),
          },
          url: videoUrl(input.videoId),
        },
      };
    },
  };
}
