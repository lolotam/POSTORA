import { z } from "npm:zod@3.23.8";
import { readJsonBodyCapped } from "../_shared/cappedJsonBody.ts";
import { restrictedCorsHeaders } from "../_shared/cors.ts";
import type { CaptionFormat } from "./captionFile.ts";
import { deriveYouTubeCapabilities } from "./capabilities.ts";
import {
  YOUTUBE_RESOURCE_ERROR_STATUS,
  YOUTUBE_RESOURCES_SCHEMA_VERSION,
  YOUTUBE_VIDEOS_DEFAULT_PAGE_SIZE,
  YOUTUBE_VIDEOS_MAX_PAGE_SIZE,
  type YouTubeAccountCapabilities,
  type YouTubeCaptionsListData,
  type YouTubeCreatePlaylistData,
  type YouTubeResourceErrorCode,
  type YouTubeResourceSuccess,
  type YouTubeSetThumbnailResult,
  type YouTubeUploadCaptionData,
} from "./contracts.ts";
import type { YouTubeReadClient, YouTubeReadResult } from "./youtubeReadClient.ts";
import type { EditChanges, EditFailureCode, EditSnapshot } from "./editLifecycle.ts";
import type { CategoryListResult, YouTubeCategoryClient } from "./categoryClient.ts";

export const YOUTUBE_RESOURCES_MAX_BODY_BYTES = Math.floor(1.5 * 1024 * 1024);
const BODY_READ_TIMEOUT_MS = 10_000;

/**
 * The edit seam. Production does not provide it (D1/D5): every edit request is
 * refused before any provider call. Tests inject a fake provider-backed port
 * to exercise the real snapshot/plan/verify lifecycle offline.
 */
export interface YouTubeThumbnailPort {
  setThumbnail(input: {
    account: YouTubeResourceAccount;
    userId: string;
    videoId: string;
    mediaFileId: string;
  }): Promise<
    | { ok: true; value: YouTubeSetThumbnailResult }
    | { ok: false; code: YouTubeResourceErrorCode; retryAfterSeconds?: number }
  >;
}

export interface YouTubeCaptionPort {
  listCaptions(input: {
    account: YouTubeResourceAccount;
    userId: string;
    videoId: string;
  }): Promise<
    | { ok: true; value: YouTubeCaptionsListData }
    | { ok: false; code: YouTubeResourceErrorCode; retryAfterSeconds?: number }
  >;
  uploadCaption(input: {
    account: YouTubeResourceAccount;
    userId: string;
    videoId: string;
    language: string;
    name: string;
    format: CaptionFormat;
    content: string;
  }): Promise<
    | { ok: true; value: YouTubeUploadCaptionData }
    | { ok: false; code: YouTubeResourceErrorCode; retryAfterSeconds?: number }
  >;
}

export interface YouTubePlaylistWritePort {
  createPlaylist(input: {
    account: YouTubeResourceAccount;
    userId: string;
    title: string;
    description?: string;
    privacyStatus: "public" | "unlisted" | "private";
  }): Promise<
    | { ok: true; value: YouTubeCreatePlaylistData }
    | { ok: false; code: YouTubeResourceErrorCode; retryAfterSeconds?: number }
  >;
}

export interface YouTubeEditPort {
  snapshot(input: { accountId: string; videoId: string; ownerId: string; channelId: string }): Promise<EditSnapshot>;
  update(input: {
    accountId: string;
    videoId: string;
    ownerId: string;
    channelId: string;
    baseRevision: string;
    changes: EditChanges;
    privacyConfirmation: { to: string } | null;
  }): Promise<{ snapshot: EditSnapshot; verified: boolean }>;
  failureCode?(error: unknown): EditFailureCode | null;
  retryAfterSeconds?(error: unknown): number | undefined;
}

export interface YouTubeResourceAccount {
  id: string;
  userId: string;
  channelId: string | null;
  channelTitle: string | null;
  authProvider: string | null;
  needsReauth: boolean;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
  accountMetadata: unknown;
}

export interface YouTubeResourceRefusal {
  operation: string;
  code: YouTubeResourceErrorCode;
  userId: string | null;
  accountId: string | null;
  requestId: string;
}

export type YouTubeTokenResult =
  | { ok: true; accessToken: string; minted: boolean }
  | { ok: false; code: "reconnect_required" | "upstream_unavailable" };

export interface YouTubeResourcesPorts {
  auth: { authenticate(req: Request): Promise<{ userId: string }> };
  accounts: {
    load(input: { accountId: string; userId: string }): Promise<YouTubeResourceAccount | null>;
  };
  clock: { now(): Date };
  ids: { requestId(): string };
  log: { refusal(entry: YouTubeResourceRefusal): Promise<void> };
  tokens: {
    get(account: YouTubeResourceAccount, options: { force: boolean }): Promise<YouTubeTokenResult>;
  };
  youtube: YouTubeReadClient;
  categories: YouTubeCategoryClient;
  edit?: YouTubeEditPort;
  thumbnail?: YouTubeThumbnailPort;
  captions?: YouTubeCaptionPort;
  playlists?: YouTubePlaylistWritePort;
  rateLimit: { check(userId: string): Promise<{ allowed: boolean; retryAfterSeconds: number }> };
}

const AccountId = z.string().uuid();
const CapabilitiesRequest = z.object({ operation: z.literal("capabilities"), account_id: AccountId }).strict();
const CategoriesRequest = z.object({
  operation: z.literal("categories"),
  account_id: AccountId,
  region: z.string().regex(/^[A-Za-z]{2}$/).optional(),
  locale: z.string().max(16).optional(),
}).strict();
const ChannelRequest = z.object({ operation: z.literal("channel"), account_id: AccountId }).strict();
// The cursor is opaque and bound to the caller's own uploads playlist. Real Google
// tokens observed on Data API list methods are longer base64 strings that carry the
// `=` padding character, so no character class is enforced — only a sanity length cap.
// A strict class here would turn every "Load more" past page 1 into 400 invalid_request.
const VideosRequest = z.object({
  operation: z.literal("videos"),
  account_id: AccountId,
  page_size: z.number().int().min(1).max(YOUTUBE_VIDEOS_MAX_PAGE_SIZE).optional(),
  page_token: z.string().min(1).max(256).optional(),
}).strict();
// The id class Google itself uses; a path-shaped value never reaches the provider.
const VideoRequest = z.object({
  operation: z.literal("video"),
  account_id: AccountId,
  video_id: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/),
}).strict();
const PlaylistsRequest = z.object({
  operation: z.literal("playlists"),
  account_id: AccountId,
  page_token: z.string().min(1).max(256).optional(),
}).strict();
// Edit requests are accepted only so the contract can be exercised and refused
// with a stable code. A strict shape keeps a future enabled path from ever
// accepting an untyped provider part or an arbitrary metadata field.
const EditableChanges = z.object({
  title: z.string().min(1).max(100).optional(),
  description: z.string().max(5000).optional(),
  tags: z.array(z.string()).max(500).optional(),
  category_id: z.string().regex(/^\d{1,4}$/).optional(),
  privacy_status: z.enum(["private", "unlisted", "public"]).optional(),
}).strict();
const EditSnapshotRequest = z.object({
  operation: z.literal("edit_snapshot"),
  account_id: AccountId,
  video_id: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/),
}).strict();
const UpdateVideoRequest = z.object({
  operation: z.literal("update_video"),
  account_id: AccountId,
  video_id: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/),
  base_revision: z.string().min(1).max(512),
  changes: EditableChanges.refine((changes) => Object.keys(changes).length > 0, {
    message: "at least one change is required",
  }),
  privacy_confirmation: z.object({ to: z.enum(["private", "unlisted", "public"]) }).strict().optional(),
}).strict();
const SetThumbnailRequest = z.object({
  operation: z.literal("set_thumbnail"),
  account_id: AccountId,
  video_id: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/),
  media_file_id: z.string().uuid(),
}).strict();
const CaptionsRequest = z.object({
  operation: z.literal("captions"),
  account_id: AccountId,
  video_id: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/),
}).strict();
const UploadCaptionRequest = z.object({
  operation: z.literal("upload_caption"),
  account_id: AccountId,
  video_id: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/),
  language: z.string().min(1).max(35),
  name: z.string().max(300),
  format: z.enum(["srt", "vtt"]),
  // Note: Do NOT put a character .max() on `content` in Zod that could fire
  // before the UTF-8 byte check in captionFile.ts! Any oversized body > 1.5 MiB
  // is stopped by readJsonBodyCapped, and any content > 512 KiB UTF-8 bytes
  // is answered as `caption_invalid` by the caption validator.
  content: z.string(),
}).strict();
const CreatePlaylistRequest = z.object({
  operation: z.literal("create_playlist"),
  account_id: AccountId,
  title: z.string(),
  description: z.string().optional(),
  privacy_status: z.enum(["private", "unlisted", "public"]),
}).strict();
const RequestSchema = z.discriminatedUnion("operation", [
  CapabilitiesRequest,
  CategoriesRequest,
  ChannelRequest,
  VideosRequest,
  VideoRequest,
  PlaylistsRequest,
  EditSnapshotRequest,
  UpdateVideoRequest,
  SetThumbnailRequest,
  CaptionsRequest,
  UploadCaptionRequest,
  CreatePlaylistRequest,
]);

// The audit label for a refusal: the requested operation when the body names one of
// the known literals, "unknown" otherwise. An arbitrary body string is never echoed
// into the log, and refusals before the body is read cannot know the operation.
function requestedOperationOf(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "unknown";
  const requested = (body as Record<string, unknown>).operation;
  return requested === "capabilities" || requested === "categories" || requested === "channel" ||
      requested === "videos" || requested === "video" || requested === "playlists" ||
      requested === "edit_snapshot" || requested === "update_video" || requested === "set_thumbnail" ||
      requested === "captions" || requested === "upload_caption" || requested === "create_playlist"
    ? requested
    : "unknown";
}

// Same shape as _shared/auth-helper.ts, retained locally as defense-in-depth at the
// injectable ports.auth boundary in case a test or alternate port returns a non-UUID.
const USER_ID_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Owner-bound capabilities handler for youtube-resources. The handler does no I/O of its
 * own: identity comes only from ports.auth, the account row only from ports.accounts.
 * A foreign account and a missing account are the same 404, so account ids cannot be
 * enumerated. No credential field ever reaches a response.
 */
export function createYouTubeResourcesHandler(
  ports: YouTubeResourcesPorts,
): (req: Request) => Promise<Response> {
  // method_not_allowed and unauthorized are not written: an anonymous caller must not be
  // able to fill the log table. The write is awaited so the edge worker cannot be torn
  // down before the audit row lands; a failed log write never changes the response.
  async function refuse(
    req: Request,
    entry: YouTubeResourceRefusal,
    extra?: Record<string, unknown>,
  ): Promise<Response> {
    if (entry.code !== "method_not_allowed" && entry.code !== "unauthorized") {
      try {
        await ports.log.refusal(entry);
      } catch {
        console.warn({ event: "youtube_resources_refusal_log_failed", code: entry.code });
      }
    }
    return new Response(
      JSON.stringify({ error: entry.code, request_id: entry.requestId, ...extra }),
      {
        status: YOUTUBE_RESOURCE_ERROR_STATUS[entry.code],
        headers: {
          ...restrictedCorsHeaders(req),
          "Content-Type": "application/json",
          ...(entry.code === "method_not_allowed" ? { "Allow": "POST, OPTIONS" } : {}),
        },
      },
    );
  }

  function editEnvelope(req: Request, requestId: string, data: EditSnapshot): Response {
    return new Response(JSON.stringify({
      schema_version: YOUTUBE_RESOURCES_SCHEMA_VERSION,
      request_id: requestId,
      freshness: { fetched_at: data.fetchedAt, source: "provider" },
      data,
    }), {
      status: 200,
      headers: { ...restrictedCorsHeaders(req), "Content-Type": "application/json" },
    });
  }

  // One admission path for every provider-backed operation, in spec order: Composio,
  // the derived browse capability, the stored channel, then the per-user limit.
  // Returns the refusal code, or null when the provider may be called.
  async function admit(
    account: YouTubeResourceAccount,
    userId: string,
  ): Promise<{ code: YouTubeResourceErrorCode; retryAfterSeconds?: number } | null> {
    if (account.authProvider === "composio") return { code: "provider_unsupported" };
    const browse = deriveYouTubeCapabilities({
      id: account.id,
      channelId: account.channelId,
      channelTitle: account.channelTitle,
      authProvider: account.authProvider,
      needsReauth: account.needsReauth,
      hasAccessToken: Boolean(account.accessToken),
      hasRefreshToken: Boolean(account.refreshToken),
      accountMetadata: account.accountMetadata,
    }).capabilities.browse;
    if (browse.state === "unavailable") return { code: browse.reason };
    if (account.channelId === null) return { code: "reconnect_required" };
    const decision = await ports.rateLimit.check(userId);
    if (!decision.allowed) return { code: "rate_limited", retryAfterSeconds: decision.retryAfterSeconds };
    return null;
  }

  // One provider read, with the single forced-refresh repeat after a 401 — and only
  // when the token was not minted by this request: a fresh token that Google rejects
  // will reject its replacement too, and the refresh budget is not wasted.
  async function providerRead<T>(
    account: YouTubeResourceAccount,
    read: (accessToken: string) => Promise<YouTubeReadResult<T>>,
  ): Promise<YouTubeReadResult<T>> {
    const token = await ports.tokens.get(account, { force: false });
    if (!token.ok) return { ok: false, code: token.code, unauthorized: false };
    const result = await read(token.accessToken);
    if (!result.ok && result.unauthorized && !token.minted) {
      const refreshed = await ports.tokens.get(account, { force: true });
      if (!refreshed.ok) return { ok: false, code: refreshed.code, unauthorized: false };
      return await read(refreshed.accessToken);
    }
    return result;
  }

  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: restrictedCorsHeaders(req) });
    }
    const requestId = ports.ids.requestId();
    // Refusals before the body is understood carry the unknown label.
    const unknownOperation = "unknown";
    if (req.method !== "POST") {
      return await refuse(req, {
        operation: unknownOperation,
        code: "method_not_allowed",
        userId: null,
        accountId: null,
        requestId,
      });
    }
    let userId: string;
    try {
      userId = (await ports.auth.authenticate(req)).userId;
    } catch {
      // Every auth failure is the same unauthorized answer; the thrown reason
      // (missing header, bad JWT, service-role bearer) never reaches the caller.
      return await refuse(req, {
        operation: unknownOperation,
        code: "unauthorized",
        userId: null,
        accountId: null,
        requestId,
      });
    }
    if (typeof userId !== "string" || !USER_ID_UUID_RE.test(userId)) {
      // Defense-in-depth at the ports.auth boundary: refuse any non-UUID caller
      // identity before any account read, without a log row.
      return await refuse(req, {
        operation: unknownOperation,
        code: "unauthorized",
        userId: null,
        accountId: null,
        requestId,
      });
    }
    const bodyResult = await readJsonBodyCapped(
      req,
      YOUTUBE_RESOURCES_MAX_BODY_BYTES,
      AbortSignal.timeout(BODY_READ_TIMEOUT_MS),
    ).catch(() => ({ ok: false as const, reason: "invalid_json" as const }));
    if (!bodyResult.ok) {
      // Malformed or oversized JSON is a client error; the raw parse error text is not echoed.
      return await refuse(req, {
        operation: unknownOperation,
        code: "invalid_request",
        userId,
        accountId: null,
        requestId,
      });
    }
    const body = bodyResult.value;
    const requestedOperation = requestedOperationOf(body);
    const parsed = RequestSchema.safeParse(body);
    if (!parsed.success) {
      return await refuse(req, {
        operation: requestedOperation,
        code: "invalid_request",
        userId,
        accountId: null,
        requestId,
      });
    }
    if (parsed.data.operation === "categories") {
      // The catalog is a provider read behind the same owner-bound account
      // lookup and token lease as every other YouTube browse operation.
      let catalogAccount: YouTubeResourceAccount | null;
      try {
        catalogAccount = await ports.accounts.load({ accountId: parsed.data.account_id, userId });
      } catch {
        return await refuse(req, {
          operation: "categories", code: "internal_error", userId,
          accountId: parsed.data.account_id, requestId,
        });
      }
      if (!catalogAccount || catalogAccount.userId !== userId) {
        return await refuse(req, {
          operation: "categories", code: "not_found", userId,
          accountId: parsed.data.account_id, requestId,
        });
      }
      // The catalog is a provider read and must spend the same read rate
      // budget as every other browse operation. Check it BEFORE any token
      // or provider call so a 429 costs neither a refresh nor a Google unit.
      const catalogRate = await ports.rateLimit.check(userId);
      if (!catalogRate.allowed) {
        return await refuse(req, {
          operation: "categories", code: "rate_limited", userId,
          accountId: parsed.data.account_id, requestId,
        }, { retry_after_seconds: catalogRate.retryAfterSeconds });
      }
      const catalogToken = await ports.tokens.get(catalogAccount, { force: false });
      if (!catalogToken.ok) {
        return await refuse(req, {
          operation: "categories", code: catalogToken.code, userId,
          accountId: parsed.data.account_id, requestId,
        });
      }
      const listed: CategoryListResult = await ports.categories.list(catalogToken.accessToken, {
        region: parsed.data.region,
        locale: parsed.data.locale,
      });
      if (!listed.ok) {
        return await refuse(req, {
          operation: "categories", code: listed.code, userId,
          accountId: parsed.data.account_id, requestId,
        }, listed.retryAfterSeconds !== undefined
          ? { retry_after_seconds: listed.retryAfterSeconds }
          : undefined);
      }
      // The bundled table is explicitly a fallback, never proof of a
      // complete regional catalog. The provider response is authoritative.
      const data = {
        region: listed.region,
        locale: listed.locale,
        categories: listed.value,
        source: "provider" as const,
      };
      const envelope: YouTubeResourceSuccess<typeof data> = {
        schema_version: YOUTUBE_RESOURCES_SCHEMA_VERSION,
        request_id: requestId,
        freshness: { fetched_at: ports.clock.now().toISOString(), source: "provider" },
        data,
      };
      return new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { ...restrictedCorsHeaders(req), "Content-Type": "application/json" },
      });
    }
    const accountId = parsed.data.account_id;
    let account: YouTubeResourceAccount | null;
    try {
      account = await ports.accounts.load({ accountId, userId });
    } catch {
      // A failed read must never look like a missing row: this refusal is what
      // separates a database outage (500) from an unknown account (404).
      return await refuse(req, {
        operation: requestedOperation,
        code: "internal_error",
        userId,
        accountId,
        requestId,
      });
    }
    if (!account || account.userId !== userId) {
      return await refuse(req, {
        operation: requestedOperation,
        code: "not_found",
        userId,
        accountId,
        requestId,
      });
    }
    // Phase 4A: when the edit port is enabled, edit operations pass through
    // admit() first (Composio, browse capability, stored channel, read limiter)
    // before any provider read or write.
    if (parsed.data.operation === "edit_snapshot" || parsed.data.operation === "update_video") {
      if (!ports.edit) {
        return await refuse(req, {
          operation: parsed.data.operation,
          code: "write_not_enabled",
          userId,
          accountId,
          requestId,
        });
      }
      const editPort = ports.edit;
      const editCapability = deriveYouTubeCapabilities({
        id: account.id,
        channelId: account.channelId,
        channelTitle: account.channelTitle,
        authProvider: account.authProvider,
        needsReauth: account.needsReauth,
        hasAccessToken: Boolean(account.accessToken),
        hasRefreshToken: Boolean(account.refreshToken),
        accountMetadata: account.accountMetadata,
      }).capabilities.edit_metadata;
      if (editCapability?.state === "unavailable") {
        return await refuse(req, {
          operation: parsed.data.operation,
          code: editCapability.reason,
          userId,
          accountId,
          requestId,
        });
      }
      try {
        const admission = await admit(account, userId);
        const channelId = admission === null ? account.channelId : null;
        if (admission !== null || channelId === null) {
          return await refuse(req, {
            operation: parsed.data.operation,
            code: admission?.code ?? "reconnect_required",
            userId,
            accountId,
            requestId,
          }, admission?.retryAfterSeconds !== undefined
            ? { retry_after_seconds: admission.retryAfterSeconds }
            : undefined);
        }
        if (parsed.data.operation === "edit_snapshot") {
          const snapshot = await editPort.snapshot({
            accountId,
            videoId: parsed.data.video_id,
            ownerId: userId,
            channelId,
          });
          return editEnvelope(req, requestId, snapshot);
        }
        // The public wire shape is snake_case; the domain uses camelCase. Map
        // at this boundary so a new wire key can never silently reach the
        // domain as an unknown property.
        const wireChanges = parsed.data.changes;
        const domainChanges: EditChanges = {
          ...(wireChanges.title !== undefined ? { title: wireChanges.title } : {}),
          ...(wireChanges.description !== undefined ? { description: wireChanges.description } : {}),
          ...(wireChanges.tags !== undefined ? { tags: wireChanges.tags } : {}),
          ...(wireChanges.category_id !== undefined ? { categoryId: wireChanges.category_id } : {}),
          ...(wireChanges.privacy_status !== undefined ? { privacyStatus: wireChanges.privacy_status } : {}),
        };
        const result = await editPort.update({
          accountId,
          videoId: parsed.data.video_id,
          ownerId: userId,
          channelId,
          baseRevision: parsed.data.base_revision,
          changes: domainChanges,
          privacyConfirmation: parsed.data.privacy_confirmation ?? null,
        });
        if (!result.verified) {
          return await refuse(req, {
            operation: "update_video",
            code: "outcome_unknown",
            userId,
            accountId,
            requestId,
          });
        }
        return editEnvelope(req, requestId, result.snapshot);
      } catch (error) {
        const code = editPort.failureCode?.(error) ?? "internal_error";
        if (code === "internal_error") {
          console.error("[youtube-resources] edit failed:", error instanceof Error ? error.name : "unknown");
        }
        const retryAfter = editPort.retryAfterSeconds?.(error);
        return await refuse(
          req,
          { operation: parsed.data.operation, code, userId, accountId, requestId },
          retryAfter !== undefined ? { retry_after_seconds: retryAfter } : undefined,
        );
      }
    }
    async function runAdmittedPort<T>(
      operation: string,
      targetAccount: YouTubeResourceAccount,
      fn: () => Promise<
        | { ok: true; value: T }
        | { ok: false; code: YouTubeResourceErrorCode; retryAfterSeconds?: number }
      >,
    ): Promise<Response> {
      try {
        const admission = await admit(targetAccount, userId);
        if (admission !== null) {
          return await refuse(req, {
            operation,
            code: admission.code,
            userId,
            accountId,
            requestId,
          }, admission.retryAfterSeconds !== undefined
            ? { retry_after_seconds: admission.retryAfterSeconds }
            : undefined);
        }
        const result = await fn();
        if (!result.ok) {
          return await refuse(req, {
            operation,
            code: result.code,
            userId,
            accountId,
            requestId,
          }, result.retryAfterSeconds !== undefined
            ? { retry_after_seconds: result.retryAfterSeconds }
            : undefined);
        }
        const envelope: YouTubeResourceSuccess<T> = {
          schema_version: YOUTUBE_RESOURCES_SCHEMA_VERSION,
          request_id: requestId,
          freshness: { fetched_at: ports.clock.now().toISOString(), source: "provider" },
          data: result.value,
        };
        return new Response(JSON.stringify(envelope), {
          status: 200,
          headers: { ...restrictedCorsHeaders(req), "Content-Type": "application/json" },
        });
      } catch {
        return await refuse(req, {
          operation,
          code: "internal_error",
          userId,
          accountId,
          requestId,
        });
      }
    }

    if (parsed.data.operation === "set_thumbnail") {
      if (!ports.thumbnail) {
        return await refuse(req, {
          operation: "set_thumbnail",
          code: "write_not_enabled",
          userId,
          accountId,
          requestId,
        });
      }
      const thumbnailPort = ports.thumbnail;
      const thumbData = parsed.data;
      return await runAdmittedPort("set_thumbnail", account, () =>
        thumbnailPort.setThumbnail({
          account,
          userId,
          videoId: thumbData.video_id,
          mediaFileId: thumbData.media_file_id,
        })
      );
    }
    if (parsed.data.operation === "captions" || parsed.data.operation === "upload_caption") {
      if (!ports.captions) {
        return await refuse(req, {
          operation: parsed.data.operation,
          code: "write_not_enabled",
          userId,
          accountId,
          requestId,
        });
      }
      const captionsPort = ports.captions;
      if (parsed.data.operation === "captions") {
        const listData = parsed.data;
        return await runAdmittedPort("captions", account, () =>
          captionsPort.listCaptions({
            account,
            userId,
            videoId: listData.video_id,
          })
        );
      }
      const uploadData = parsed.data;
      return await runAdmittedPort("upload_caption", account, () =>
        captionsPort.uploadCaption({
          account,
          userId,
          videoId: uploadData.video_id,
          language: uploadData.language,
          name: uploadData.name,
          format: uploadData.format,
          content: uploadData.content,
        })
      );
    }
    if (parsed.data.operation === "create_playlist") {
      if (!ports.playlists) {
        return await refuse(req, {
          operation: "create_playlist",
          code: "write_not_enabled",
          userId,
          accountId,
          requestId,
        });
      }
      const playlistsPort = ports.playlists;
      const createData = parsed.data;
      return await runAdmittedPort("create_playlist", account, () =>
        playlistsPort.createPlaylist({
          account,
          userId,
          title: createData.title,
          description: createData.description,
          privacyStatus: createData.privacy_status,
        })
      );
    }
    if (parsed.data.operation === "capabilities") {
      const envelope: YouTubeResourceSuccess<YouTubeAccountCapabilities> = {
        schema_version: YOUTUBE_RESOURCES_SCHEMA_VERSION,
        request_id: requestId,
        freshness: { fetched_at: ports.clock.now().toISOString(), source: "database" },
        data: deriveYouTubeCapabilities({
          id: account.id,
          channelId: account.channelId,
          channelTitle: account.channelTitle,
          authProvider: account.authProvider,
          needsReauth: account.needsReauth,
          hasAccessToken: Boolean(account.accessToken),
          hasRefreshToken: Boolean(account.refreshToken),
          accountMetadata: account.accountMetadata,
        }),
      };
      return new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { ...restrictedCorsHeaders(req), "Content-Type": "application/json" },
      });
    }
    const refusedOperation = parsed.data.operation;
    // Narrowed here so every provider-backed operation shares one admission path,
    // one repeat-on-401 path and one response shape.
    const videos = refusedOperation === "videos" ? parsed.data : null;
    const video = refusedOperation === "video" ? parsed.data : null;
    const playlists = refusedOperation === "playlists" ? parsed.data : null;
    try {
      const admission = await admit(account, userId);
      // admit refuses a row without a stored channel as reconnect_required, so the
      // local null check mirrors its decision and gives the provider call a string.
      const channelId = admission === null ? account.channelId : null;
      if (admission !== null || channelId === null) {
        return await refuse(req, {
          operation: refusedOperation,
          code: admission?.code ?? "reconnect_required",
          userId,
          accountId,
          requestId,
        }, admission?.retryAfterSeconds !== undefined
          ? { retry_after_seconds: admission.retryAfterSeconds }
          : undefined);
      }
      // The provider layer owns the foreign-video answer: getVideo refuses a video of
      // another channel as not_found, and the handler adds no second rule. The read is
      // typed as unknown here because the envelope is serialized, not consumed.
      const result = await providerRead(
        account,
        (accessToken): Promise<YouTubeReadResult<unknown>> => {
          if (videos !== null) {
            return ports.youtube.listUploads(accessToken, {
              channelId,
              pageSize: videos.page_size ?? YOUTUBE_VIDEOS_DEFAULT_PAGE_SIZE,
              ...(videos.page_token ? { pageToken: videos.page_token } : {}),
            });
          }
          if (video !== null) {
            return ports.youtube.getVideo(accessToken, { channelId, videoId: video.video_id });
          }
          if (playlists !== null) {
            return ports.youtube.listPlaylists(accessToken, {
              channelId,
              ...(playlists.page_token ? { pageToken: playlists.page_token } : {}),
            });
          }
          return ports.youtube.getChannel(accessToken, { channelId });
        },
      );
      if (!result.ok) {
        return await refuse(req, {
          operation: refusedOperation,
          code: result.code,
          userId,
          accountId,
          requestId,
        });
      }
      const envelope: YouTubeResourceSuccess<unknown> = {
        schema_version: YOUTUBE_RESOURCES_SCHEMA_VERSION,
        request_id: requestId,
        freshness: { fetched_at: ports.clock.now().toISOString(), source: "provider" },
        data: result.value,
      };
      return new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { ...restrictedCorsHeaders(req), "Content-Type": "application/json" },
      });
    } catch {
      // An unexpected admission or read failure is an internal error; nothing from
      // the exception reaches the caller.
      return await refuse(req, {
        operation: refusedOperation,
        code: "internal_error",
        userId,
        accountId,
        requestId,
      });
    }
  };
}
