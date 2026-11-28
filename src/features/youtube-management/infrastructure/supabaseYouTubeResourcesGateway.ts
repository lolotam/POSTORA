import { supabase } from "@/integrations/supabase/client";
import { toYouTubeResourceError, YouTubeResourceError } from "../domain/errors";
import { measureCaptionUtf8Bytes } from "../domain/captions";
import {
  CAPTION_CONTENT_MAX_BYTES,
} from "../domain/types";
import type {
  YouTubeAccountCapabilities,
  YouTubeCategoryOption,
  YouTubeChannelDetails,
  YouTubeCaptionFormat,
  YouTubeCaptionsListData,
  YouTubeCreatePlaylistData,
  YouTubePlaylistsPage,
  YouTubeResourceSuccess,
  YouTubeSetThumbnailResult,
  YouTubeUploadCaptionData,
  YouTubeVideoDetails,
  YouTubeVideosPage,
} from "../domain/types";
import type { YouTubeResourcesGateway } from "../application/ports";

// A stalled edge call must not hang the screen: abort after 15 seconds.
export const YOUTUBE_GATEWAY_TIMEOUT_MS = 15000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumberOrNull(value: unknown): value is number | null {
  return typeof value === "number" ? Number.isFinite(value) : value === null;
}

// Contract envelope: the documented schema version, a request id, a freshness
// stamp, and a data object that the per-operation validator then narrows.
function isEnvelopeFor<T>(
  payload: unknown,
  isData: (value: unknown) => boolean,
): payload is YouTubeResourceSuccess<T> {
  if (!isRecord(payload)) return false;
  if (payload.schema_version !== 1) return false;
  if (typeof payload.request_id !== "string") return false;
  if (!isRecord(payload.freshness) || typeof payload.freshness.fetched_at !== "string") return false;
  if (!isRecord(payload.data) || !isData(payload.data)) return false;
  return true;
}

// The fields below are the ones the UI actually reads; a payload that is
// missing any of them never reaches a component.
function isCapabilitiesData(value: unknown): value is YouTubeAccountCapabilities {
  if (!isRecord(value) || typeof value.account_id !== "string" || !isRecord(value.quota)) return false;
  const capabilities = value.capabilities;
  return isRecord(capabilities) && isRecord(capabilities.browse) && typeof capabilities.browse.state === "string";
}

function isChannelData(value: unknown): value is YouTubeChannelDetails {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string") return false;
  const stats = value.statistics;
  return isRecord(stats)
    && typeof stats.subscriber_count_hidden === "boolean"
    && isNumberOrNull(stats.view_count)
    && isNumberOrNull(stats.subscriber_count)
    && isNumberOrNull(stats.video_count);
}

function isVideosData(value: unknown): value is YouTubeVideosPage {
  if (!isRecord(value) || !Array.isArray(value.items)) return false;
  return value.next_page_token === null || typeof value.next_page_token === "string";
}

function isPlaylistsData(value: unknown): value is YouTubePlaylistsPage {
  if (!isRecord(value) || !Array.isArray(value.items)) return false;
  return value.next_page_token === null || typeof value.next_page_token === "string";
}

function isCreatePlaylistData(value: unknown): value is YouTubeCreatePlaylistData {
  if (!isRecord(value) || !isRecord(value.playlist)) return false;
  const playlist = value.playlist;
  return (
    typeof playlist.id === "string" &&
    /^[A-Za-z0-9_-]{10,64}$/.test(playlist.id) &&
    typeof playlist.title === "string"
  );
}

function isVideoData(value: unknown): value is YouTubeVideoDetails {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || typeof value.title !== "string" || typeof value.description !== "string" || typeof value.url !== "string") return false;
  if (!Array.isArray(value.tags)) return false;
  if (value.duration_iso8601 !== null && typeof value.duration_iso8601 !== "string") return false;
  const stats = value.statistics;
  return isRecord(stats)
    && isNumberOrNull(stats.view_count)
    && isNumberOrNull(stats.like_count)
    && isNumberOrNull(stats.comment_count);
}

// One helper does every call: never a user id in the body (identity comes
// from the Authorization header server-side), an explicit finite timeout, and
// a failure always throws a YouTubeResourceError with the server's stable
// code — a malformed or empty answer is never handed to the UI as a resource.
async function call<T>(
  body: Record<string, unknown>,
  isData: (value: unknown) => boolean,
  options?: { unreadableFailureCode?: "upstream_unavailable" | "outcome_unknown" },
): Promise<YouTubeResourceSuccess<T>> {
  const unreadableFailureCode = options?.unreadableFailureCode ?? "upstream_unavailable";
  let data: YouTubeResourceSuccess<T> | null = null;
  let error: { context?: unknown } | null = null;
  try {
    const result = await supabase.functions.invoke<YouTubeResourceSuccess<T>>("youtube-resources", {
      body,
      timeout: YOUTUBE_GATEWAY_TIMEOUT_MS,
    });
    data = result.data ?? null;
    error = (result.error ?? null) as { context?: unknown } | null;
  } catch (thrown) {
    // A network failure or the timeout abort above rejects; both are
    // upstream failures for reads and outcome_unknown for writes.
    error = thrown as { context?: unknown };
  }
  if (error) {
    const context = error.context;
    const payload: unknown = context instanceof Response
      ? await context.clone().json().catch(() => null)
      : null;
    throw toYouTubeResourceError(payload, unreadableFailureCode);
  }
  if (data === null || !isEnvelopeFor<T>(data, isData)) {
    throw new YouTubeResourceError(unreadableFailureCode);
  }
  return data;
}

export class SupabaseYouTubeResourcesGateway implements YouTubeResourcesGateway {
  getEditSnapshot(params: { accountId: string; videoId: string }): Promise<YouTubeResourceSuccess<{
    revision: string;
    values: {
      title: string;
      description?: string;
      tags?: string[];
      privacyStatus: string;
      categoryId: string | null;
    };
  }>> {
    return call(
      { operation: "edit_snapshot", account_id: params.accountId, video_id: params.videoId },
      (data): data is {
        revision: string;
        values: {
          title: string;
          description?: string;
          tags?: string[];
          privacyStatus: string;
          categoryId: string | null;
        };
      } =>
        typeof data === "object" && data !== null && typeof (data as { revision?: unknown }).revision === "string",
    );
  }

  updateVideo(params: {
    accountId: string;
    videoId: string;
    baseRevision: string;
    changes: {
      title?: string;
      description?: string;
      tags?: string[];
      category_id?: string;
      privacy_status?: "private" | "unlisted" | "public";
    };
    privacyConfirmation?: { to: "private" | "unlisted" | "public" };
  }): Promise<YouTubeResourceSuccess<{ revision: string }>> {
    return call(
      {
        operation: "update_video",
        account_id: params.accountId,
        video_id: params.videoId,
        base_revision: params.baseRevision,
        changes: params.changes,
        ...(params.privacyConfirmation ? { privacy_confirmation: params.privacyConfirmation } : {}),
      },
      (data): data is { revision: string } =>
        typeof data === "object" && data !== null && typeof (data as { revision?: unknown }).revision === "string",
      // A write whose answer never arrives is not a refusal: the change may
      // already be on YouTube, so the caller must be told to check, not retry.
      { unreadableFailureCode: "outcome_unknown" },
    );
  }

  getCategories(params: { accountId: string; region?: string; locale?: string }): Promise<YouTubeResourceSuccess<{
    region: string;
    locale: string;
    categories: YouTubeCategoryOption[];
    source: string;
  }>> {
    return call(
      { operation: "categories", account_id: params.accountId, ...(params.region ? { region: params.region } : {}), ...(params.locale ? { locale: params.locale } : {}) },
      (data): data is { region: string; locale: string; categories: YouTubeCategoryOption[]; source: string } =>
        typeof data === "object" && data !== null && Array.isArray((data as { categories?: unknown }).categories),
    );
  }

  getCapabilities(accountId: string): Promise<YouTubeResourceSuccess<YouTubeAccountCapabilities>> {
    return call({ operation: "capabilities", account_id: accountId }, isCapabilitiesData);
  }

  getChannel(accountId: string): Promise<YouTubeResourceSuccess<YouTubeChannelDetails>> {
    return call({ operation: "channel", account_id: accountId }, isChannelData);
  }

  listVideos(params: { accountId: string; pageToken?: string | null }): Promise<YouTubeResourceSuccess<YouTubeVideosPage>> {
    return call(
      {
        operation: "videos",
        account_id: params.accountId,
        ...(params.pageToken ? { page_token: params.pageToken } : {}),
      },
      isVideosData,
    );
  }

  listPlaylists(params: { accountId: string; pageToken?: string | null }): Promise<YouTubeResourceSuccess<YouTubePlaylistsPage>> {
    return call(
      {
        operation: "playlists",
        account_id: params.accountId,
        ...(params.pageToken ? { page_token: params.pageToken } : {}),
      },
      isPlaylistsData,
    );
  }

  createPlaylist(params: {
    accountId: string;
    title: string;
    description?: string;
    privacyStatus: "public" | "unlisted" | "private";
  }): Promise<YouTubeResourceSuccess<YouTubeCreatePlaylistData>> {
    return call(
      {
        operation: "create_playlist",
        account_id: params.accountId,
        title: params.title,
        ...(params.description !== undefined ? { description: params.description } : {}),
        privacy_status: params.privacyStatus,
      },
      isCreatePlaylistData,
      { unreadableFailureCode: "outcome_unknown" },
    );
  }

  getVideo(params: { accountId: string; videoId: string }): Promise<YouTubeResourceSuccess<YouTubeVideoDetails>> {
    return call({ operation: "video", account_id: params.accountId, video_id: params.videoId }, isVideoData);
  }

  // The media id is the only thing the client sends: the server resolves the
  // file by id and owner, so a URL or a foreign file never crosses the wire.
  setThumbnail(params: {
    accountId: string;
    videoId: string;
    mediaFileId: string;
  }): Promise<YouTubeResourceSuccess<YouTubeSetThumbnailResult>> {
    return call(
      {
        operation: "set_thumbnail",
        account_id: params.accountId,
        video_id: params.videoId,
        media_file_id: params.mediaFileId,
      },
      (data): data is YouTubeSetThumbnailResult =>
        typeof data === "object" && data !== null
        && (data as { video_id?: unknown }).video_id === params.videoId
        && (data as { applied?: unknown }).applied === true,
      { unreadableFailureCode: "outcome_unknown" },
    );
  }

  // The caption tracks of one owned video. The answer must name the same
  // video that was asked for: a list for another video never reaches the UI.
  listCaptions(params: { accountId: string; videoId: string }): Promise<YouTubeResourceSuccess<YouTubeCaptionsListData>> {
    return call(
      { operation: "captions", account_id: params.accountId, video_id: params.videoId },
      (data): data is YouTubeCaptionsListData =>
        typeof data === "object" && data !== null
        && (data as { video_id?: unknown }).video_id === params.videoId
        && Array.isArray((data as { items?: unknown }).items),
    );
  }

  // The caption text is sent as ordinary UTF-8 JSON (plain `JSON.stringify`,
  // never `\uXXXX`-escaped), so Arabic text reaches YouTube byte for byte.
  // The method is async on purpose: a refusal is a rejected promise, the
  // one channel a caller has to handle.
  async uploadCaption(params: {
    accountId: string;
    videoId: string;
    language: string;
    name: string;
    format: YouTubeCaptionFormat;
    content: string;
  }): Promise<YouTubeResourceSuccess<YouTubeUploadCaptionData>> {
    // The browser already knows the file's real size, so an oversize file
    // is refused here instead of costing a provider call (400 units).
    if (measureCaptionUtf8Bytes(params.content) > CAPTION_CONTENT_MAX_BYTES) {
      throw new YouTubeResourceError("caption_invalid");
    }
    return call(
      {
        operation: "upload_caption",
        account_id: params.accountId,
        video_id: params.videoId,
        language: params.language,
        name: params.name,
        format: params.format,
        content: params.content,
      },
      (data): data is YouTubeUploadCaptionData =>
        typeof data === "object" && data !== null
        && (data as { video_id?: unknown }).video_id === params.videoId
        && typeof (data as { track?: unknown }).track === "object"
        && (data as { track?: unknown }).track !== null,
      // A lost answer is not a refusal: the upload may already exist on
      // YouTube, and the creator has to be told to refresh, not to retry.
      { unreadableFailureCode: "outcome_unknown" },
    );
  }
}

export const defaultYouTubeResourcesGateway = new SupabaseYouTubeResourcesGateway();
