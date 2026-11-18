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
  BeginUploadSession,
  ClaimUploadSession,
  CheckpointUploadSession,
  CompleteUploadSession,
  ReleaseUploadSession,
  YoutubeUploadRefusal,
  YoutubeUploadSessionRecord,
  YoutubeUploadSessionStore,
} from "./youtubeResumableUpload.ts";
import { redactResumableCredentials } from "./youtubeResumableUpload.ts";

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
    state: state as YoutubeUploadSessionRecord["state"],
    sessionUri: typeof payload.session_uri === "string" ? payload.session_uri : null,
    confirmedBytes: Number(payload.confirmed_bytes ?? 0),
    bytesSent: Number(payload.bytes_sent ?? 0),
    videoMayExist: payload.video_may_exist === true,
    totalBytes: Number(payload.total_bytes ?? 0),
    videoId: typeof payload.video_id === "string" ? payload.video_id : null,
    sessionExpiresAt: typeof payload.session_expires_at === "string" ? payload.session_expires_at : null,
  };
}

/**
 * The store backed by the database.
 *
 * Every call goes through a SECURITY DEFINER function that the browser roles
 * may not execute, so the session URI only ever travels between this edge
 * function and the database.
 */
export function createSupabaseYoutubeUploadSessionStore(
  // deno-lint-ignore no-explicit-any
  supabase: any,
): YoutubeUploadSessionStore {
  async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) throw error;
    return data as T;
  }

  return {
    async begin(input: BeginUploadSession) {
      try {
        const payload = await call<Record<string, unknown>>("begin_youtube_upload_session", {
          p_post_id: input.postId,
          p_social_account_id: input.socialAccountId,
          p_user_id: input.userId,
          p_media_file_id: input.mediaFileId,
          p_media_size: input.mediaSize,
          p_total_bytes: input.totalBytes,
          p_upload_body: input.uploadBody,
        });
        const record = toRecord(payload);
        // A session that needs a human comes back in that state rather than
        // as a refusal, because the mark is durable and a refusal raised
        // inside the function would be undone by the caller's rollback.
        if (record?.state === "reconcile") {
          return { record: null, refused: "reconcile_required" };
        }
        return { record, refused: null };
      } catch (error) {
        const refusal = readRefusal(error);
        if (refusal) return { record: null, refused: refusal };
        throw error;
      }
    },

    async claim(input: ClaimUploadSession) {
      try {
        const payload = await call<Record<string, unknown>>("claim_youtube_upload_session", {
          p_session_id: input.sessionId,
          p_lease_token: input.leaseToken,
          p_lease_ms: input.leaseMs,
        });
        return { record: toRecord(payload), refused: null };
      } catch (error) {
        const refusal = readRefusal(error);
        if (refusal) return { record: null, refused: refusal };
        throw error;
      }
    },

    async checkpoint(input: CheckpointUploadSession) {
      try {
        return await call<boolean>("checkpoint_youtube_upload_session", {
          p_session_id: input.sessionId,
          p_lease_token: input.leaseToken,
          p_confirmed_bytes: input.confirmedBytes,
          p_bytes_sent: input.bytesSent,
          p_session_uri: input.sessionUri ?? null,
          p_video_may_exist: input.videoMayExist ?? null,
        });
      } catch (error) {
        const refusal = readRefusal(error);
        if (refusal) return false;
        throw error;
      }
    },

    async complete(input: CompleteUploadSession) {
      try {
        return await call<boolean>("complete_youtube_upload_session", {
          p_session_id: input.sessionId,
          p_lease_token: input.leaseToken,
          p_video_id: input.videoId,
        });
      } catch (error) {
        const refusal = readRefusal(error);
        if (refusal) return false;
        throw error;
      }
    },

    async release(input: ReleaseUploadSession) {
      try {
        return await call<boolean>("release_youtube_upload_session", {
          p_session_id: input.sessionId,
          p_lease_token: input.leaseToken,
          p_state: input.state,
          // The error text is kept in a private row, but a provider answer
          // can echo the request it refused, and the request carries the
          // session URI. The credential is taken out before it is stored.
          p_error: input.error ? redactResumableCredentials(input.error).slice(0, 300) : null,
        });
      } catch (error) {
        const refusal = readRefusal(error);
        if (refusal) return false;
        throw error;
      }
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
}): YoutubeUploadSessionStore & { sessions: Map<string, MemorySession> } {
  const now = options?.now ?? (() => Date.now());
  let counter = 0;
  const nextId = options?.nextId ?? (() => `session-${++counter}`);
  const sessions = new Map<string, MemorySession>();

  function payload(session: MemorySession): YoutubeUploadSessionRecord {
    return {
      id: session.id,
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

    async begin(input: BeginUploadSession): Promise<{ record: YoutubeUploadSessionRecord | null; refused: YoutubeUploadRefusal | null }> {
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
          confirmedBytes: 0,
          bytesSent: 0,
          sessionUri: null,
          sessionExpiresAt: null,
          videoMayExist: false,
          videoId: null,
          state: "open",
          leaseToken: null,
          leaseExpiresAt: null,
        };
        sessions.set(session.id, session);
        return { record: payload(session), refused: null };
      }

      // The session belongs to the owner of the post. Another user asking for
      // the same post and account is asking for someone else's session.
      if (session.userId !== input.userId) {
        return { record: null, refused: "post_not_found" };
      }

      if (session.state === "uploaded") return { record: payload(session), refused: null };
      if (session.state === "reconcile") return { record: null, refused: "reconcile_required" };

      const sameContent =
        JSON.stringify(session.uploadBody) === JSON.stringify(input.uploadBody) &&
        session.mediaFileId === input.mediaFileId &&
        session.totalBytes === input.totalBytes;
      if (!sameContent) return { record: null, refused: "content_changed" };

      if (session.state === "expired" || (session.sessionExpiresAt !== null && session.sessionExpiresAt <= now())) {
        if (session.videoMayExist) {
          // The last chunk may have been written, so a video may exist and a
          // fresh session could create a second one.
          session.state = "reconcile";
          return { record: null, refused: "reconcile_required" };
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

      return { record: payload(session), refused: null };
    },

    async claim(input: ClaimUploadSession): Promise<{ record: YoutubeUploadSessionRecord | null; refused: YoutubeUploadRefusal | null }> {
      const session = sessions.get(input.sessionId);
      if (!session) return { record: null, refused: "session_not_found" };
      if (session.state === "uploaded") return { record: payload(session), refused: null };
      if (session.state === "reconcile") return { record: null, refused: "reconcile_required" };
      if (session.sessionExpiresAt !== null && session.sessionExpiresAt <= now()) {
        return { record: null, refused: "session_expired" };
      }
      if (holdsLiveLease(session) && session.leaseToken !== input.leaseToken) {
        return { record: null, refused: "lease_held" };
      }
      session.leaseToken = input.leaseToken;
      session.leaseExpiresAt = now() + input.leaseMs;
      return { record: payload(session), refused: null };
    },

    async checkpoint(input: CheckpointUploadSession) {
      const session = sessions.get(input.sessionId);
      if (!session) return false;
      if (session.leaseToken !== input.leaseToken) return false;
      if (session.leaseExpiresAt === null || session.leaseExpiresAt <= now()) return false;
      session.confirmedBytes = Math.max(session.confirmedBytes, input.confirmedBytes);
      session.bytesSent = Math.max(session.bytesSent, input.bytesSent);
      if (input.sessionUri) session.sessionUri = input.sessionUri;
      if (typeof input.videoMayExist === "boolean") session.videoMayExist = input.videoMayExist;
      return true;
    },

    async complete(input: CompleteUploadSession) {
      const session = sessions.get(input.sessionId);
      if (!session) return false;
      if (session.state === "uploaded" && session.videoId === input.videoId) return true;
      if (session.leaseToken !== input.leaseToken) return false;
      if (session.leaseExpiresAt === null || session.leaseExpiresAt <= now()) return false;
      session.state = "uploaded";
      session.videoId = input.videoId;
      session.sessionUri = null;
      session.confirmedBytes = session.totalBytes;
      session.bytesSent = session.totalBytes;
      session.leaseToken = null;
      session.leaseExpiresAt = null;
      return true;
    },

    async release(input: ReleaseUploadSession) {
      const session = sessions.get(input.sessionId);
      if (!session) return false;
      if (session.state === "uploaded") return false;
      if (session.leaseToken !== input.leaseToken) return false;
      if (session.leaseExpiresAt === null || session.leaseExpiresAt <= now()) return false;
      session.state = input.state;
      session.leaseToken = null;
      session.leaseExpiresAt = null;
      return true;
    },
  };
}
