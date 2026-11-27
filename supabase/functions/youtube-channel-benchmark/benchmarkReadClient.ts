import { classifyGoogleError } from "../_shared/youtubeApiErrors.ts";
import { uploadsPlaylistId as defaultUploadsPlaylistId } from "../_shared/youtubeComments.ts";
import {
  classifyBenchmarkChannelInput,
  YOUTUBE_BENCHMARK_CHANNEL_ID_PATTERN,
  YOUTUBE_BENCHMARK_RECENT_VIDEOS_LIMIT,
  type YouTubeBenchmarkChannel,
  type YouTubeBenchmarkChannelErrorCode,
  type YouTubeBenchmarkRecentVideo,
} from "./contracts.ts";

const DEFAULT_DATA_API_BASE_URL = "https://www.googleapis.com/youtube/v3";
export const YOUTUBE_BENCHMARK_READ_TIMEOUT_MS = 5_000;

const PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{10,64}$/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export type BenchmarkUnitDebitResult =
  | { allowed: true }
  | { allowed: false; code: "quota_exceeded" | "upstream_unavailable" };

export type BenchmarkChannelLookupOutcome =
  | { kind: "channel"; unitsSpent: 0 | 1 | 2 | 3; channel: YouTubeBenchmarkChannel }
  | { kind: "unauthorized"; unitsSpent: 1 | 2 | 3 };

export interface YouTubeBenchmarkReadClient {
  lookupChannel(input: {
    accessToken: string;
    input: string;
    debitUnit?: () => Promise<BenchmarkUnitDebitResult>;
  }): Promise<BenchmarkChannelLookupOutcome>;
}

export interface CreateYouTubeBenchmarkReadClientOptions {
  fetchImpl: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

type ProviderStepResponse =
  | { ok: true; body: unknown }
  | { ok: false; unauthorized: true }
  | { ok: false; unauthorized: false; status: number; code: YouTubeBenchmarkChannelErrorCode; body: unknown };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseDigitCounter(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function parseSafeYtimgThumbnail(thumbnails: unknown): string | null {
  const record = asRecord(thumbnails);
  if (!record) return null;
  for (const key of ["medium", "high", "default"]) {
    const entry = asRecord(record[key]);
    if (typeof entry?.url !== "string") continue;
    try {
      const url = new URL(entry.url);
      if (
        url.protocol === "https:" &&
        (url.hostname === "ytimg.com" || url.hostname.endsWith(".ytimg.com"))
      ) {
        return url.toString();
      }
    } catch {
      continue;
    }
  }
  return null;
}

function parsePublishedAt(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function unavailableChannel(
  input: string,
  error: YouTubeBenchmarkChannelErrorCode,
): YouTubeBenchmarkChannel {
  return {
    input,
    status: "unavailable",
    error,
    channel_id: null,
    title: null,
    thumbnail_url: null,
    subscriber_count: null,
    subscriber_count_hidden: false,
    view_count: null,
    video_count: null,
    recent_videos: [],
  };
}

function notFoundChannel(input: string): YouTubeBenchmarkChannel {
  return {
    input,
    status: "not_found",
    channel_id: null,
    title: null,
    thumbnail_url: null,
    subscriber_count: null,
    subscriber_count_hidden: false,
    view_count: null,
    video_count: null,
    recent_videos: [],
  };
}

function isPlaylistNotFoundError(status: number, body: unknown): boolean {
  if (status !== 404) return false;
  const errors = (body as { error?: { errors?: Array<{ reason?: unknown }> } } | null)?.error?.errors;
  return Array.isArray(errors) && errors[0]?.reason === "playlistNotFound";
}

function mapFailureCode(status: number, body: unknown): YouTubeBenchmarkChannelErrorCode {
  const kind = classifyGoogleError(status, body);
  if (kind === "quota") return "quota_exceeded";
  if (kind === "scope_missing") return "reconnect_required";
  return "upstream_unavailable";
}

function parseListEnvelope(
  body: unknown,
  expectedKind: string,
): { ok: true; items: unknown[] } | { ok: false } {
  const envelope = asRecord(body);
  if (!envelope) return { ok: false };
  if (envelope.kind !== undefined && envelope.kind !== expectedKind) {
    return { ok: false };
  }
  if (envelope.items === undefined) {
    // Google omits `items` on some empty list responses when `kind` is present.
    return envelope.kind === expectedKind ? { ok: true, items: [] } : { ok: false };
  }
  if (!Array.isArray(envelope.items)) return { ok: false };
  return { ok: true, items: envelope.items };
}

function parseChannelItem(
  input: string,
  rawItem: unknown,
): { channel: YouTubeBenchmarkChannel; uploadsId: string } | null {
  const item = asRecord(rawItem);
  if (!item || typeof item.id !== "string" || !YOUTUBE_BENCHMARK_CHANNEL_ID_PATTERN.test(item.id)) {
    return null;
  }
  const snippet = asRecord(item.snippet);
  const statistics = asRecord(item.statistics);
  const contentDetails = asRecord(item.contentDetails);
  const relatedPlaylists = asRecord(contentDetails?.relatedPlaylists);
  const rawUploads = relatedPlaylists?.uploads;
  const uploadsId = typeof rawUploads === "string" && PLAYLIST_ID_RE.test(rawUploads)
    ? rawUploads
    : defaultUploadsPlaylistId(item.id);
  const hidden = statistics?.hiddenSubscriberCount === true;

  return {
    channel: {
      input,
      status: "found",
      channel_id: item.id,
      title: typeof snippet?.title === "string" ? snippet.title : null,
      thumbnail_url: parseSafeYtimgThumbnail(snippet?.thumbnails),
      subscriber_count: hidden ? null : parseDigitCounter(statistics?.subscriberCount),
      subscriber_count_hidden: hidden,
      view_count: parseDigitCounter(statistics?.viewCount),
      video_count: parseDigitCounter(statistics?.videoCount),
      recent_videos: [],
    },
    uploadsId,
  };
}

function extractUploadVideoIds(items: unknown[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    if (ids.length >= YOUTUBE_BENCHMARK_RECENT_VIDEOS_LIMIT) break;
    const item = asRecord(raw);
    const contentDetails = asRecord(item?.contentDetails);
    const videoId = contentDetails?.videoId;
    if (typeof videoId !== "string" || !VIDEO_ID_RE.test(videoId) || seen.has(videoId)) {
      continue;
    }
    seen.add(videoId);
    ids.push(videoId);
  }
  return ids;
}

function mapRecentVideos(
  orderedIds: string[],
  items: unknown[],
  expectedChannelId: string,
): YouTubeBenchmarkRecentVideo[] {
  const byId = new Map<string, YouTubeBenchmarkRecentVideo>();
  for (const raw of items) {
    const item = asRecord(raw);
    if (!item || typeof item.id !== "string" || !VIDEO_ID_RE.test(item.id)) continue;
    const snippet = asRecord(item.snippet);
    if (snippet?.channelId !== expectedChannelId) continue;
    const statistics = asRecord(item.statistics);
    byId.set(item.id, {
      id: item.id,
      title: typeof snippet?.title === "string" ? snippet.title : "",
      published_at: parsePublishedAt(snippet?.publishedAt),
      view_count: parseDigitCounter(statistics?.viewCount),
      like_count: parseDigitCounter(statistics?.likeCount),
      comment_count: parseDigitCounter(statistics?.commentCount),
    });
  }
  const videos: YouTubeBenchmarkRecentVideo[] = [];
  for (const id of orderedIds) {
    const video = byId.get(id);
    if (video) videos.push(video);
  }
  return videos;
}

export function createYouTubeBenchmarkReadClient(
  options: CreateYouTubeBenchmarkReadClientOptions,
): YouTubeBenchmarkReadClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_DATA_API_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? YOUTUBE_BENCHMARK_READ_TIMEOUT_MS;

  async function sendGet(
    path: string,
    query: Record<string, string>,
    accessToken: string,
  ): Promise<ProviderStepResponse> {
    let response: Response;
    try {
      response = await options.fetchImpl(`${baseUrl}/${path}?${new URLSearchParams(query)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ok: false, unauthorized: false, status: 0, code: "upstream_unavailable", body: null };
    }
    if (response.status === 401) {
      return { ok: false, unauthorized: true };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, unauthorized: false, status: response.status, code: "upstream_unavailable", body: null };
    }
    if (response.ok) {
      return { ok: true, body };
    }
    return {
      ok: false,
      unauthorized: false,
      status: response.status,
      code: mapFailureCode(response.status, body),
      body,
    };
  }

  return {
    async lookupChannel({ accessToken, input, debitUnit }): Promise<BenchmarkChannelLookupOutcome> {
      const classified = classifyBenchmarkChannelInput(input);
      if (!classified) {
        return {
          kind: "channel",
          unitsSpent: 0,
          channel: unavailableChannel(input, "upstream_unavailable"),
        };
      }
      const label = classified.normalized;

      if (debitUnit) {
        const debit = await debitUnit();
        if (!debit.allowed) {
          return {
            kind: "channel",
            unitsSpent: 0,
            channel: unavailableChannel(label, debit.code),
          };
        }
      }

      const channelQuery: Record<string, string> = {
        part: "snippet,statistics,contentDetails",
        maxResults: "1",
        ...(classified.kind === "handle"
          ? { forHandle: classified.queryValue }
          : { id: classified.queryValue }),
      };
      const step1 = await sendGet("channels", channelQuery, accessToken);
      if (!step1.ok) {
        if (step1.unauthorized) return { kind: "unauthorized", unitsSpent: 1 };
        return {
          kind: "channel",
          unitsSpent: 1,
          channel: unavailableChannel(label, step1.code),
        };
      }

      const channelEnvelope = parseListEnvelope(step1.body, "youtube#channelListResponse");
      if (!channelEnvelope.ok) {
        return {
          kind: "channel",
          unitsSpent: 1,
          channel: unavailableChannel(label, "upstream_unavailable"),
        };
      }
      if (channelEnvelope.items.length === 0) {
        return {
          kind: "channel",
          unitsSpent: 1,
          channel: notFoundChannel(label),
        };
      }

      const parsedChannel = parseChannelItem(label, channelEnvelope.items[0]);
      if (!parsedChannel) {
        return {
          kind: "channel",
          unitsSpent: 1,
          channel: unavailableChannel(label, "upstream_unavailable"),
        };
      }

      const foundBase = parsedChannel.channel;
      if (debitUnit) {
        const debit = await debitUnit();
        if (!debit.allowed) {
          return {
            kind: "channel",
            unitsSpent: 1,
            channel: { ...foundBase, error: debit.code },
          };
        }
      }

      const step2 = await sendGet("playlistItems", {
        part: "contentDetails",
        playlistId: parsedChannel.uploadsId,
        maxResults: String(YOUTUBE_BENCHMARK_RECENT_VIDEOS_LIMIT),
      }, accessToken);
      if (!step2.ok) {
        if (step2.unauthorized) return { kind: "unauthorized", unitsSpent: 2 };
        if (isPlaylistNotFoundError(step2.status, step2.body)) {
          // Channels with zero uploads have no uploads playlist yet (playlistNotFound); skip videos.list.
          return { kind: "channel", unitsSpent: 2, channel: foundBase };
        }
        return {
          kind: "channel",
          unitsSpent: 2,
          channel: { ...foundBase, error: step2.code },
        };
      }

      const playlistEnvelope = parseListEnvelope(step2.body, "youtube#playlistItemListResponse");
      if (!playlistEnvelope.ok) {
        return {
          kind: "channel",
          unitsSpent: 2,
          channel: { ...foundBase, error: "upstream_unavailable" },
        };
      }

      const videoIds = extractUploadVideoIds(playlistEnvelope.items);
      if (videoIds.length === 0) {
        return { kind: "channel", unitsSpent: 2, channel: foundBase };
      }

      if (debitUnit) {
        const debit = await debitUnit();
        if (!debit.allowed) {
          return {
            kind: "channel",
            unitsSpent: 2,
            channel: { ...foundBase, error: debit.code },
          };
        }
      }

      const step3 = await sendGet("videos", {
        part: "snippet,statistics",
        id: videoIds.join(","),
        maxResults: String(YOUTUBE_BENCHMARK_RECENT_VIDEOS_LIMIT),
      }, accessToken);
      if (!step3.ok) {
        if (step3.unauthorized) return { kind: "unauthorized", unitsSpent: 3 };
        return {
          kind: "channel",
          unitsSpent: 3,
          channel: { ...foundBase, error: step3.code },
        };
      }

      const videoEnvelope = parseListEnvelope(step3.body, "youtube#videoListResponse");
      if (!videoEnvelope.ok) {
        return {
          kind: "channel",
          unitsSpent: 3,
          channel: { ...foundBase, error: "upstream_unavailable" },
        };
      }

      return {
        kind: "channel",
        unitsSpent: 3,
        channel: {
          ...foundBase,
          recent_videos: mapRecentVideos(
            videoIds,
            videoEnvelope.items,
            foundBase.channel_id ?? "",
          ),
        },
      };
    },
  };
}
