/**
 * The durable store behind one native YouTube resumable upload.
 *
 * WHY A STORE AND NOT A ROW
 * -------------------------
 * The upload needs three things kept together that the customer-facing tables
 * are not built for:
 *
 *   * a CREDENTIAL, the provider's resumable session URI, which may not be
 *     read by the browser roles and may not appear in a log line, a
 *     telemetry event or a client response;
 *   * the attempt fence, so that one upload has one owner and a worker that
 *     was paused cannot write over the worker that took over from it;
 *   * the RECEIPT, the video id, which is what stops a second video from
 *     appearing on the customer's channel.
 *
 * The store is the only thing that knows how those are kept, so the upload
 * code asks the store instead of writing a row itself.
 *
 * THE LEASE IS A NUMBER OF MILLISECONDS
 * -------------------------------------
 * The functions take `p_lease_ms`, not an interval. PostgREST sends the named
 * arguments of a function as JSON, and a JSON interval has no agreed shape, so
 * a caller that sent an interval string would depend on the server's parser.
 * A number of milliseconds is the same on both sides, and the function turns
 * it into an interval itself.
 *
 * TWO IMPLEMENTATIONS
 * -------------------
 * The Supabase one talks to the functions in
 * `supabase/migrations/20261118120000_youtube_resumable_upload_sessions.sql`.
 * The in-memory one keeps the same rules without a database, and it is what
 * the fake provider tests drive: the lease rules, the monotonic offsets and
 * the receipt are the parts most likely to be got wrong, so they are proved
 * without one.
 */

import type {
  AdmitUploadSession,
  ClaimContinuations,
  ClaimUploadSession,
  CheckpointUploadSession,
  CompleteUploadSession,
  EffectAuthorityUploadSession,
  ProjectUploadReceipt,
  RecoverFanoutUploadSession,
  ReleaseUploadSession,
  SettleUploadSession,
  YoutubeUploadContinuationClaim,
  YoutubeUploadRefusal,
  YoutubeUploadSessionRecord,
  YoutubeUploadSessionStore,
} from "./youtubeResumableUpload.ts";
import { redactProviderText } from "./youtubeUploadPolicy.ts";

export type { YoutubeUploadRefusal };

/**
 * The SQLSTATE the store's functions raise, mapped to the reason code the
 * upload code branches on.
 *
 * The mapping lives here so the upload code never reads a SQLSTATE and never
 * parses an error message.
 */
const REFUSAL_BY_SQLSTATE: Record<string, YoutubeUploadRefusal> = {
  YUS01: "post_not_found",
  YUS02: "account_not_usable",
  YUS03: "media_not_owned",
  YUS04: "content_changed",
  YUS05: "reconcile_required",
  YUS06: "session_expired",
  YUS07: "lease_held",
  YUS08: "session_not_found",
  YUS09: "lease_stale",
  YUS10: "invalid_size",
  YUS11: "stale_attempt",
  YUS12: "post_superseded",
  YUS13: "too_many_continuations",
  YUS14: "no_public_row",
  YUS15: "target_not_authorized",
};

/**
 * Reads the refusal out of a raised error.
 *
 * The store's functions raise with their own SQLSTATE, so the code is read
 * from there. An error with no such state is not a refusal: it is a failure
 * of the database itself, and the caller treats it as one.
 */
export function readRefusal(error: unknown): YoutubeUploadRefusal | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return null;
  return REFUSAL_BY_SQLSTATE[code] ?? null;
}

function toRecord(payload: Record<string, unknown> | null): YoutubeUploadSessionRecord | null {
  if (!payload) return null;
  const state = typeof payload.state === "string" ? payload.state : "open";
  return {
    id: String(payload.id ?? ""),
    postId: String(payload.post_id ?? ""),
    socialAccountId: String(payload.social_account_id ?? ""),
    state: state as YoutubeUploadSessionRecord["state"],
    sessionUri: typeof payload.session_uri === "string" ? payload.session_uri : null,
    confirmedBytes: Number(payload.confirmed_bytes ?? 0),
    bytesSent: Number(payload.bytes_sent ?? 0),
    videoMayExist: payload.video_may_exist === true,
    totalBytes: Number(payload.total_bytes ?? 0),
    videoId: typeof payload.video_id === "string" ? payload.video_id : null,
    sessionExpiresAt: typeof payload.session_expires_at === "string" ? payload.session_expires_at : null,
    attemptStartedAt: typeof payload.attempt_started_at === "string" ? payload.attempt_started_at : null,
    nextCheckAt: typeof payload.next_check_at === "string" ? payload.next_check_at : null,
    lastOutcome: typeof payload.last_outcome === "string" ? payload.last_outcome : null,
    platformPostId: typeof payload.platform_post_id === "string" ? payload.platform_post_id : null,
    mediaFileId: typeof payload.media_file_id === "string" ? payload.media_file_id : null,
    mediaObjectVersion: payload.media_object_version === null || payload.media_object_version === undefined
      ? null
      : Number(payload.media_object_version),
    continuationCount: Number(payload.continuation_count ?? 0),
    resolvedPlatform: typeof payload.resolved_platform === "string" ? payload.resolved_platform : null,
    targetAccountIds: Array.isArray(payload.target_account_ids)
      ? payload.target_account_ids.filter((value): value is string => typeof value === "string")
      : [],
    uploadBody: payload.upload_body && typeof payload.upload_body === "object"
      ? (payload.upload_body as Record<string, unknown>)
      : {},
  };
}

function toClaim(payload: Record<string, unknown>): YoutubeUploadContinuationClaim | null {
  // The batch claim names the session `session_id`. The single claim names it
  // `id`, so both shapes are read here.
  const sessionId = typeof payload.session_id === "string"
    ? payload.session_id
    : typeof payload.id === "string"
    ? payload.id
    : null;
  if (!sessionId) return null;
  return {
    sessionId,
    postId: String(payload.post_id ?? ""),
    socialAccountId: String(payload.social_account_id ?? ""),
    userId: String(payload.user_id ?? ""),
    leaseToken: String(payload.lease_token ?? ""),
    attemptStartedAt: typeof payload.attempt_started_at === "string" ? payload.attempt_started_at : null,
    platformPostId: typeof payload.platform_post_id === "string" ? payload.platform_post_id : null,
    mediaFileId: typeof payload.media_file_id === "string" ? payload.media_file_id : null,
    confirmedBytes: Number(payload.confirmed_bytes ?? 0),
    totalBytes: Number(payload.total_bytes ?? 0),
    videoMayExist: payload.video_may_exist === true,
    state: typeof payload.state === "string" ? payload.state : "open",
    continuationCount: Number(payload.continuation_count ?? 0),
  };
}

interface YoutubeUploadSessionRpc {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: unknown }>;
}

/**
 * The store backed by the database.
 *
 * Every call goes through a SECURITY DEFINER function that the browser roles
 * may not execute, so the session URI only ever travels between this edge
 * function and the database.
 */
export function createSupabaseYoutubeUploadSessionStore(
  supabase: YoutubeUploadSessionRpc,
): YoutubeUploadSessionStore {
  async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) throw error;
    return data as T;
  }

  /**
   * Calls one function and tells a durable refusal apart from a failure.
   *
   * A refusal raised inside the database function arrives as an error with one
   * of the YUS codes. The store answers with the refusal instead of throwing,
   * because the caller's next step depends on WHICH refusal it was. An error
   * with no such code is a failure of the database itself and is thrown.
   */
  async function callRefusing<T>(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: true; value: T } | { ok: false; refusal: YoutubeUploadRefusal }> {
    try {
      return { ok: true, value: await call<T>(fn, args) };
    } catch (error) {
      const refusal = readRefusal(error);
      if (refusal) return { ok: false, refusal };
      throw error;
    }
  }

  return {
    async admit(input: AdmitUploadSession) {
      const result = await callRefusing<Record<string, unknown>>("admit_youtube_upload", {
        p_post_id: input.postId,
        p_social_account_id: input.socialAccountId,
        p_user_id: input.userId,
        p_media_file_id: input.mediaFileId,
        p_media_size: input.mediaSize,
        p_total_bytes: input.totalBytes,
        p_upload_body: input.uploadBody,
        p_attempt_started_at: input.attemptStartedAt,
        p_target_account_ids: input.targetAccountIds,
        // The snapshot the caller built the upload body from. The admission
        // compares it with the live post under the post's lock.
        p_expected_content: input.expectedContent,
      });
      if (!result.ok) return { record: null, refused: result.refusal, platformPostId: null };
      const payload = result.value ?? {};
      const session = payload.session as Record<string, unknown> | undefined;
      const record = session ? toRecord(session) : null;
      // A session that needs a human comes back in that state rather than as
      // a refusal, because the mark is durable and a refusal raised inside the
      // function would be undone by the caller's rollback.
      if (record?.state === "reconcile") {
        return { record: null, refused: "reconcile_required", platformPostId: null };
      }
      return {
        record,
        refused: null,
        platformPostId: typeof payload.platform_post_id === "string" ? payload.platform_post_id : null,
      };
    },

    async claim(input: ClaimUploadSession) {
      const result = await callRefusing<Record<string, unknown>>("claim_youtube_upload_session", {
        p_session_id: input.sessionId,
        p_lease_token: input.leaseToken,
        p_lease_ms: input.leaseMs,
      });
      if (!result.ok) return { record: null, refused: result.refusal };
      return { record: toRecord(result.value), refused: null };
    },

    async checkpoint(input: CheckpointUploadSession) {
      const result = await callRefusing<boolean>("checkpoint_youtube_upload_session", {
        p_session_id: input.sessionId,
        p_lease_token: input.leaseToken,
        p_confirmed_bytes: input.confirmedBytes,
        p_bytes_sent: input.bytesSent,
        p_session_uri: input.sessionUri ?? null,
        p_video_may_exist: input.videoMayExist ?? null,
        p_next_check_at: input.nextCheckAt ?? null,
        p_last_outcome: input.lastOutcome ?? null,
      });
      return result.ok ? result.value : false;
    },

    async complete(input: CompleteUploadSession) {
      const result = await callRefusing<boolean>("complete_youtube_upload_session", {
        p_session_id: input.sessionId,
        p_lease_token: input.leaseToken,
        p_video_id: input.videoId,
      });
      return result.ok ? result.value : false;
    },

    async settle(input: SettleUploadSession) {
      const result = await callRefusing<Record<string, unknown>>("settle_youtube_upload_session", {
        p_session_id: input.sessionId,
        p_lease_token: input.leaseToken,
        p_status: input.status,
        p_video_id: input.videoId ?? null,
        p_error_message: input.errorMessage ?? null,
        p_response_data: input.responseData ?? {},
      });
      if (!result.ok) return { settled: false, refused: result.refusal };
      return { settled: result.value?.settled === true, refused: null };
    },

    async projectReceipt(input: ProjectUploadReceipt) {
      const result = await callRefusing<Record<string, unknown>>("project_youtube_upload_receipt", {
        p_session_id: input.sessionId,
      });
      if (!result.ok) return { settled: false, refused: result.refusal, videoId: null };
      return {
        settled: result.value?.settled === true,
        refused: null,
        videoId: typeof result.value?.video_id === "string" ? result.value.video_id : null,
      };
    },

    async release(input: ReleaseUploadSession) {
      const result = await callRefusing<boolean>("release_youtube_upload_session", {
        p_session_id: input.sessionId,
        p_lease_token: input.leaseToken,
        p_state: input.state,
        // The error text is kept in a private row, but a provider answer
        // can echo the request it refused, and the request carries the
        // session URI. The credential is taken out before it is stored.
        p_error: input.error ? redactProviderText(input.error).slice(0, 300) : null,
      });
      return result.ok ? result.value : false;
    },

    async effectAuthority(input: EffectAuthorityUploadSession) {
      const result = await callRefusing<Record<string, unknown>>("youtube_upload_effect_authority", {
        p_session_id: input.sessionId,
        p_lease_token: input.leaseToken,
      });
      if (!result.ok) {
        // A refused call is not an authority. The lease is the only thing
        // that could have said yes, and it did not.
        return { authorized: false, reason: result.refusal ?? "authority_unavailable" };
      }
      return {
        authorized: result.value?.authorized === true,
        reason: typeof result.value?.reason === "string" ? result.value.reason : null,
      };
    },

    async recoverFanout(input: RecoverFanoutUploadSession) {
      const result = await callRefusing<Record<string, unknown>>("recover_youtube_upload_fanout", {
        p_session_id: input.sessionId,
        p_lease_token: input.leaseToken ?? null,
      });
      if (!result.ok) {
        // A refused call closed nothing. The candidate keeps whatever state it
        // had, and the post is left for the next reconciliation.
        return { recovered: false, reason: result.refusal ?? "fanout_unavailable" };
      }
      return {
        recovered: result.value?.recovered === true,
        reason: typeof result.value?.reason === "string" ? result.value.reason : null,
      };
    },

    async claimContinuations(input: ClaimContinuations) {
      const result = await callRefusing<Record<string, unknown>[]>("claim_youtube_upload_sessions", {
        p_limit: input.limit,
        p_lease_ms: input.leaseMs,
      });
      if (!result.ok) return [];
      if (!Array.isArray(result.value)) return [];
      const claims: YoutubeUploadContinuationClaim[] = [];
      for (const row of result.value) {
        const claim = toClaim(row);
        if (claim) claims.push(claim);
      }
      return claims;
    },
  };
}

/** One session in the in-memory store. */
interface MemorySession {
  id: string;
  userId: string;
  postId: string;
  socialAccountId: string;
  mediaFileId: string | null;
  mediaObjectVersion: number | null;
  mediaSize: number;
  totalBytes: number;
  uploadBody: Record<string, unknown>;
  /** The post content the caller built the upload body from. */
  expectedContent: Record<string, unknown> | null;
  confirmedBytes: number;
  bytesSent: number;
  sessionUri: string | null;
  /** When the provider session goes away. A timestamp, not a string. */
  sessionExpiresAt: number | null;
  /** Whether the provider may already have turned this upload into a video. */
  videoMayExist: boolean;
  videoId: string | null;
  state: YoutubeUploadSessionRecord["state"];
  leaseToken: string | null;
  leaseExpiresAt: number | null;
  attemptStartedAt: string | null;
  nextCheckAt: number | null;
  lastOutcome: string | null;
  platformPostId: string | null;
  continuationCount: number;
  resolvedPlatform: string | null;
  targetAccountIds: string[];
}

/**
 * The store that keeps its rules without a database.
 *
 * It is the same rules, in the same order, so a test that drives this proves
 * what the database does: one owner per session, offsets that only grow, and
 * a receipt that is kept.
 */
export function createInMemoryYoutubeUploadSessionStore(options?: {
  now?: () => number;
  nextId?: () => string;
  nextLeaseToken?: () => string;
  nextPublicRowId?: () => string;
}): YoutubeUploadSessionStore & {
  sessions: Map<string, MemorySession>;
  fanoutRecoveries: Map<string, number>;
} {
  const now = options?.now ?? (() => Date.now());
  let counter = 0;
  const nextId = options?.nextId ?? (() => `session-${++counter}`);
  let leaseCounter = 0;
  const nextLeaseToken = options?.nextLeaseToken ?? (() => `lease-${++leaseCounter}`);
  let rowCounter = 0;
  const nextPublicRowId = options?.nextPublicRowId ?? (() => `platform-post-${++rowCounter}`);
  const sessions = new Map<string, MemorySession>();
  /** How often the fanout closure was driven for a session. */
  const fanoutRecoveries = new Map<string, number>();

  function payload(session: MemorySession): YoutubeUploadSessionRecord {
    return {
      id: session.id,
      postId: session.postId,
      socialAccountId: session.socialAccountId,
      state: session.state,
      sessionUri: session.sessionUri,
      confirmedBytes: session.confirmedBytes,
      bytesSent: session.bytesSent,
      videoMayExist: session.videoMayExist,
      totalBytes: session.totalBytes,
      videoId: session.videoId,
      sessionExpiresAt: session.sessionExpiresAt === null
        ? null
        : new Date(session.sessionExpiresAt).toISOString(),
      attemptStartedAt: session.attemptStartedAt,
      nextCheckAt: session.nextCheckAt === null ? null : new Date(session.nextCheckAt).toISOString(),
      lastOutcome: session.lastOutcome,
      platformPostId: session.platformPostId,
      mediaFileId: session.mediaFileId,
      mediaObjectVersion: session.mediaObjectVersion,
      continuationCount: session.continuationCount,
      resolvedPlatform: session.resolvedPlatform,
      targetAccountIds: session.targetAccountIds,
      uploadBody: session.uploadBody,
    };
  }

  function find(postId: string, socialAccountId: string): MemorySession | undefined {
    for (const session of sessions.values()) {
      if (session.postId === postId && session.socialAccountId === socialAccountId) return session;
    }
    return undefined;
  }

  function holdsLiveLease(session: MemorySession): boolean {
    return session.leaseExpiresAt !== null && session.leaseExpiresAt > now();
  }

  return {
    sessions,
    fanoutRecoveries,

    admit(input: AdmitUploadSession): Promise<{
      record: YoutubeUploadSessionRecord | null;
      refused: YoutubeUploadRefusal | null;
      platformPostId: string | null;
    }> {
      let session = find(input.postId, input.socialAccountId);
      if (!session) {
        session = {
          id: nextId(),
          userId: input.userId,
          postId: input.postId,
          socialAccountId: input.socialAccountId,
          mediaFileId: input.mediaFileId,
          mediaObjectVersion: input.mediaObjectVersion,
          mediaSize: input.mediaSize,
          totalBytes: input.totalBytes,
          uploadBody: input.uploadBody,
          expectedContent: input.expectedContent,
          confirmedBytes: 0,
          bytesSent: 0,
          sessionUri: null,
          sessionExpiresAt: null,
          videoMayExist: false,
          videoId: null,
          state: "open",
          leaseToken: null,
          leaseExpiresAt: null,
          attemptStartedAt: input.attemptStartedAt,
          nextCheckAt: null,
          lastOutcome: null,
          platformPostId: null,
          continuationCount: 0,
          resolvedPlatform: "youtube",
          targetAccountIds: input.targetAccountIds,
        };
        sessions.set(session.id, session);
      } else {
        // The session belongs to the owner of the post. Another user asking for
        // the same post and account is asking for someone else's session.
        if (session.userId !== input.userId) {
          return Promise.resolve({ record: null, refused: "post_not_found", platformPostId: null });
        }

        if (session.state === "uploaded") {
          return Promise.resolve({ record: payload(session), refused: null, platformPostId: session.platformPostId });
        }
        if (session.state === "reconcile") {
          return Promise.resolve({ record: null, refused: "reconcile_required", platformPostId: null });
        }

        const sameContent =
          JSON.stringify(session.uploadBody) === JSON.stringify(input.uploadBody) &&
          JSON.stringify(session.expectedContent) === JSON.stringify(input.expectedContent) &&
          session.mediaFileId === input.mediaFileId &&
          session.totalBytes === input.totalBytes;
        if (!sameContent) {
          return Promise.resolve({ record: null, refused: "content_changed", platformPostId: null });
        }

        if (session.state === "expired" || (session.sessionExpiresAt !== null && session.sessionExpiresAt <= now())) {
          if (session.videoMayExist || session.bytesSent > 0) {
            // The last chunk may have been written, so a video may exist and a
            // fresh session could create a second one.
            session.state = "reconcile";
            return Promise.resolve({ record: null, refused: "reconcile_required", platformPostId: null });
          }
          session.state = "open";
          session.sessionUri = null;
          session.confirmedBytes = 0;
          session.bytesSent = 0;
          session.leaseToken = null;
          session.leaseExpiresAt = null;
        }

        if (session.state === "failed") {
          session.state = "open";
          session.sessionUri = null;
          session.confirmedBytes = 0;
          session.bytesSent = 0;
          session.leaseToken = null;
          session.leaseExpiresAt = null;
        }

        // The session now belongs to the attempt that is running.
        session.attemptStartedAt = input.attemptStartedAt;
        session.resolvedPlatform = "youtube";
        if (input.targetAccountIds.length > 0) session.targetAccountIds = input.targetAccountIds;
      }

      // The public pending row is created with the session, in one step.
      //
      // A post is never left with a pending row that no continuation can
      // claim, and never with a session that has no row to settle.
      if (session.platformPostId === null) {
        session.platformPostId = nextPublicRowId();
      }
      return Promise.resolve({ record: payload(session), refused: null, platformPostId: session.platformPostId });
    },

    claim(input: ClaimUploadSession): Promise<{ record: YoutubeUploadSessionRecord | null; refused: YoutubeUploadRefusal | null }> {
      const session = sessions.get(input.sessionId);
      if (!session) return Promise.resolve({ record: null, refused: "session_not_found" });
      if (holdsLiveLease(session) && session.leaseToken !== input.leaseToken) {
        // A live lease is never taken over: the owner of an uploaded session
        // is the worker that stored the receipt, and it is about to settle
        // the public row with that lease.
        return Promise.resolve({ record: null, refused: "lease_held" });
      }
      if (session.state === "uploaded") {
        session.leaseToken = input.leaseToken;
        session.leaseExpiresAt = now() + input.leaseMs;
        return Promise.resolve({ record: payload(session), refused: null });
      }
      if (session.state === "reconcile") return Promise.resolve({ record: null, refused: "reconcile_required" });
      if (session.sessionExpiresAt !== null && session.sessionExpiresAt <= now()) {
        return Promise.resolve({ record: null, refused: "session_expired" });
      }
      // The continuation cap. The holder of the live lease it was given may
      // still consume what it was handed; everyone else is refused.
      if (session.continuationCount >= 24 && !holdsLiveLease(session)) {
        return Promise.resolve({ record: null, refused: "too_many_continuations" });
      }
      session.leaseToken = input.leaseToken;
      session.leaseExpiresAt = now() + input.leaseMs;
      return Promise.resolve({ record: payload(session), refused: null });
    },

    checkpoint(input: CheckpointUploadSession): Promise<boolean> {
      const session = sessions.get(input.sessionId);
      if (!session) return Promise.resolve(false);
      if (session.leaseToken !== input.leaseToken) return Promise.resolve(false);
      if (session.leaseExpiresAt === null || session.leaseExpiresAt <= now()) return Promise.resolve(false);
      session.confirmedBytes = Math.max(session.confirmedBytes, input.confirmedBytes);
      session.bytesSent = Math.max(session.bytesSent, input.bytesSent);
      if (input.sessionUri) session.sessionUri = input.sessionUri;
      // The uncertainty that a video may exist only ever grows. A checkpoint
      // that says "no video yet" cannot clear a record that says the last
      // chunk may have been written: a second video on the customer's channel
      // is worse than a post that needs a human.
      if (input.videoMayExist === true) session.videoMayExist = true;
      if (input.nextCheckAt !== undefined) {
        session.nextCheckAt = input.nextCheckAt === null ? null : Date.parse(input.nextCheckAt);
      }
      if (input.lastOutcome !== undefined && input.lastOutcome !== null) {
        session.lastOutcome = input.lastOutcome;
      }
      return Promise.resolve(true);
    },

    complete(input: CompleteUploadSession): Promise<boolean> {
      const session = sessions.get(input.sessionId);
      if (!session) return Promise.resolve(false);
      if (session.state === "uploaded" && session.videoId === input.videoId) return Promise.resolve(true);
      if (session.leaseToken !== input.leaseToken) return Promise.resolve(false);
      if (session.leaseExpiresAt === null || session.leaseExpiresAt <= now()) return Promise.resolve(false);
      session.state = "uploaded";
      session.videoId = input.videoId;
      session.sessionUri = null;
      session.confirmedBytes = session.totalBytes;
      session.bytesSent = session.totalBytes;
      // The lease is KEPT: the owner still has to settle the public row, and
      // the settlement is fenced to the owner.
      return Promise.resolve(true);
    },

    settle(input: SettleUploadSession): Promise<{ settled: boolean; refused: YoutubeUploadRefusal | null }> {
      const session = sessions.get(input.sessionId);
      if (!session) return Promise.resolve({ settled: false, refused: "session_not_found" });
      // A worker that lost the lease settles nothing: the worker that took
      // over may already have written the video.
      if (session.leaseToken !== input.leaseToken) return Promise.resolve({ settled: false, refused: "lease_stale" });
      if (session.leaseExpiresAt === null || session.leaseExpiresAt <= now()) {
        return Promise.resolve({ settled: false, refused: "lease_stale" });
      }
      if (session.platformPostId === null) return Promise.resolve({ settled: false, refused: "no_public_row" });
      if (input.status === "success") {
        session.state = "uploaded";
        session.videoId = input.videoId ?? session.videoId;
        session.confirmedBytes = session.totalBytes;
        session.bytesSent = session.totalBytes;
      } else {
        // A video may exist, so the session is left for a human rather than
        // declared failed.
        session.state = session.videoMayExist ? "reconcile" : "failed";
      }
      session.leaseToken = null;
      session.leaseExpiresAt = null;
      return Promise.resolve({ settled: true, refused: null });
    },

    projectReceipt(input: ProjectUploadReceipt): Promise<{
      settled: boolean;
      refused: YoutubeUploadRefusal | null;
      videoId: string | null;
    }> {
      const session = sessions.get(input.sessionId);
      if (!session) return Promise.resolve({ settled: false, refused: "session_not_found", videoId: null });
      if (session.state !== "uploaded" || session.videoId === null) {
        return Promise.resolve({ settled: false, refused: "reconcile_required", videoId: null });
      }
      if (session.platformPostId === null) {
        return Promise.resolve({ settled: false, refused: "no_public_row", videoId: session.videoId });
      }
      return Promise.resolve({ settled: true, refused: null, videoId: session.videoId });
    },

    release(input: ReleaseUploadSession): Promise<boolean> {
      const session = sessions.get(input.sessionId);
      if (!session) return Promise.resolve(false);
      if (session.state === "uploaded") return Promise.resolve(false);
      if (session.leaseToken !== input.leaseToken) return Promise.resolve(false);
      if (session.leaseExpiresAt === null || session.leaseExpiresAt <= now()) return Promise.resolve(false);
      session.state = input.state;
      // The lease is KEPT: the owner still has to settle the public row, and
      // the settlement is fenced to the owner. The settlement releases it.
      return Promise.resolve(true);
    },

    effectAuthority(input: EffectAuthorityUploadSession): Promise<{ authorized: boolean; reason: string | null }> {
      const session = sessions.get(input.sessionId);
      if (!session) return Promise.resolve({ authorized: false, reason: "session_not_found" });
      if (session.leaseToken !== input.leaseToken) {
        return Promise.resolve({ authorized: false, reason: "lease_stale" });
      }
      if (session.leaseExpiresAt === null || session.leaseExpiresAt <= now()) {
        return Promise.resolve({ authorized: false, reason: "lease_stale" });
      }
      if (session.state !== "open") {
        return Promise.resolve({ authorized: false, reason: "session_not_open" });
      }
      return Promise.resolve({ authorized: true, reason: null });
    },

    recoverFanout(input: RecoverFanoutUploadSession): Promise<{ recovered: boolean; reason: string | null }> {
      const session = sessions.get(input.sessionId);
      if (!session) return Promise.resolve({ recovered: false, reason: "session_not_found" });
      // The same authority the database uses: the caller still owns the
      // session, or the session has already reached a terminal state and the
      // closure is derived from the database rather than from the caller.
      const ownsLease =
        session.leaseToken !== null &&
        session.leaseToken === input.leaseToken &&
        session.leaseExpiresAt !== null &&
        session.leaseExpiresAt > now();
      const terminal = session.state === "uploaded" || session.state === "failed" || session.state === "reconcile";
      if (!ownsLease && !terminal) {
        return Promise.resolve({ recovered: false, reason: "lease_stale" });
      }
      fanoutRecoveries.set(input.sessionId, (fanoutRecoveries.get(input.sessionId) ?? 0) + 1);
      return Promise.resolve({ recovered: true, reason: null });
    },

    claimContinuations(input: ClaimContinuations): Promise<YoutubeUploadContinuationClaim[]> {
      const claims: YoutubeUploadContinuationClaim[] = [];
      for (const session of sessions.values()) {
        if (claims.length >= input.limit) break;
        // Every window after the admission is eligible.
        //
        //   * the upload continues from a provider session;
        //   * the provider session was never opened and no byte was written,
        //     so no video can exist and the worker opens one and starts;
        //   * a receipt is waiting to be projected onto the public row.
        const continues = session.state === "open" && session.sessionUri !== null;
        const neverOpened = session.state === "open" && session.sessionUri === null &&
          session.bytesSent === 0 && !session.videoMayExist;
        const receipt = session.state === "uploaded" && session.videoId !== null;
        if (!continues && !neverOpened && !receipt) continue;
        if (holdsLiveLease(session)) continue;
        if (session.nextCheckAt !== null && session.nextCheckAt > now()) continue;

        const leaseToken = nextLeaseToken();
        session.leaseToken = leaseToken;
        session.leaseExpiresAt = now() + input.leaseMs;
        // Only an upload that still has to be written counts a continuation.
        if (session.state === "open") session.continuationCount += 1;

        claims.push({
          sessionId: session.id,
          postId: session.postId,
          socialAccountId: session.socialAccountId,
          userId: session.userId,
          leaseToken,
          attemptStartedAt: session.attemptStartedAt,
          platformPostId: session.platformPostId,
          mediaFileId: session.mediaFileId,
          confirmedBytes: session.confirmedBytes,
          totalBytes: session.totalBytes,
          videoMayExist: session.videoMayExist,
          state: session.state,
          continuationCount: session.continuationCount,
        });
      }
      return Promise.resolve(claims);
    },
  };
}
