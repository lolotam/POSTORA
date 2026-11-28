import { classifyGoogleError } from "../_shared/youtubeApiErrors.ts";
import { deriveYouTubeCapabilities } from "./capabilities.ts";
import {
  YOUTUBE_PLAYLIST_ID_PATTERN,
  type YouTubeCreatePlaylistData,
  type YouTubeResourceErrorCode,
} from "./contracts.ts";
import type {
  YouTubePlaylistWritePort,
  YouTubeResourceAccount,
  YouTubeTokenResult,
} from "./handler.ts";
import {
  YOUTUBE_PLAYLIST_CREATE_UNIT_COST,
  type WriteBudgetDebitResult,
  type WriteCounterResult,
} from "./writeLimits.ts";

export type { YouTubePlaylistWritePort } from "./handler.ts";

const PLAYLISTS_INSERT_ENDPOINT = "https://www.googleapis.com/youtube/v3/playlists?part=snippet,status";
const PLAYLIST_CREATE_TIMEOUT_MS = 15_000;
const PLAYLIST_TITLE_MAX_CHARS = 150;
const PLAYLIST_DESCRIPTION_MAX_BYTES = 5_000;

export type YouTubePlaylistPrivacyStatus = "public" | "unlisted" | "private";

export interface ValidatedPlaylistCreateInput {
  title: string;
  description: string;
  privacyStatus: YouTubePlaylistPrivacyStatus;
}

export interface YouTubePlaylistWriteCompositionDeps {
  writeLimits: {
    checkPlaylistCreateCounter(userId: string): Promise<WriteCounterResult>;
    debitWriteBudget(units: number): Promise<WriteBudgetDebitResult>;
  };
  stillBound(input: {
    accountId: string;
    ownerId: string;
    channelId: string;
    accessToken: string;
  }): Promise<boolean>;
  tokens: {
    get(account: YouTubeResourceAccount, options: { force: boolean }): Promise<YouTubeTokenResult>;
  };
  fetchImpl: typeof fetch;
  timeoutMs?: number;
}

function isPlaylistPrivacyStatus(value: unknown): value is YouTubePlaylistPrivacyStatus {
  return value === "public" || value === "unlisted" || value === "private";
}

/**
 * Pure validation of `create_playlist` inputs per Spec §14.4:
 * - `title`: 1..150 characters after trim, no `<` or `>`, no `\r`, `\n`, or `\0`
 * - `description`: optional (defaults to `""`), 0..5000 UTF-8 bytes, no `<` or `>`, no `\0`
 * - `privacyStatus`: `"public" | "unlisted" | "private"`
 */
export function validatePlaylistCreateInput(input: {
  title: unknown;
  description?: unknown;
  privacyStatus: unknown;
}): { ok: true; value: ValidatedPlaylistCreateInput } | { ok: false; code: "invalid_request" } {
  if (typeof input.title !== "string") {
    return { ok: false, code: "invalid_request" };
  }
  if (/[\r\n\0<>]/.test(input.title)) {
    return { ok: false, code: "invalid_request" };
  }
  const trimmedTitle = input.title.trim();
  if (trimmedTitle.length < 1 || trimmedTitle.length > PLAYLIST_TITLE_MAX_CHARS) {
    return { ok: false, code: "invalid_request" };
  }

  const rawDescription = input.description === undefined ? "" : input.description;
  if (typeof rawDescription !== "string") {
    return { ok: false, code: "invalid_request" };
  }
  if (/[\0<>]/.test(rawDescription)) {
    return { ok: false, code: "invalid_request" };
  }
  const descriptionBytes = new TextEncoder().encode(rawDescription).byteLength;
  if (descriptionBytes > PLAYLIST_DESCRIPTION_MAX_BYTES) {
    return { ok: false, code: "invalid_request" };
  }

  if (!isPlaylistPrivacyStatus(input.privacyStatus)) {
    return { ok: false, code: "invalid_request" };
  }

  return {
    ok: true,
    value: {
      title: trimmedTitle,
      description: rawDescription,
      privacyStatus: input.privacyStatus,
    },
  };
}

function extractThumbnailUrl(thumbnails: unknown): string | null {
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

async function readErrorJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function classifyPlaylistCreateFailure(status: number, errorBody: unknown): YouTubeResourceErrorCode {
  if (status === 400) return "invalid_request";
  if (status === 401) return "reconnect_required";
  if (status === 403) {
    const errClass = classifyGoogleError(403, errorBody);
    if (errClass === "quota") return "quota_exceeded";
    if (errClass === "scope_missing") return "missing_scope";
    if (errClass === "unauthorized") return "reconnect_required";
    if (errClass === "not_found" || errClass === "forbidden") return "missing_scope";
    return "upstream_unavailable";
  }
  if (status === 404) return "not_found";
  if (status === 429) return "quota_exceeded";
  if (status >= 500) return "outcome_unknown";
  return "upstream_unavailable";
}

/**
 * Implements Spec §14.4 steps 2–8 for creating a YouTube playlist behind `YouTubePlaylistWritePort`.
 * Never retries the POST because a second call would create a duplicate playlist.
 */
export function createYouTubePlaylistWritePort(
  deps: YouTubePlaylistWriteCompositionDeps,
): YouTubePlaylistWritePort {
  const timeoutMs = deps.timeoutMs ?? PLAYLIST_CREATE_TIMEOUT_MS;

  return {
    async createPlaylist({ account, userId, title, description, privacyStatus }): Promise<
      | { ok: true; value: YouTubeCreatePlaylistData }
      | { ok: false; code: YouTubeResourceErrorCode; retryAfterSeconds?: number }
    > {
      // Step 2: manage_playlists capability check
      const caps = deriveYouTubeCapabilities({
        id: account.id,
        channelId: account.channelId,
        channelTitle: account.channelTitle,
        authProvider: account.authProvider,
        needsReauth: account.needsReauth,
        hasAccessToken: Boolean(account.accessToken),
        hasRefreshToken: Boolean(account.refreshToken),
        accountMetadata: account.accountMetadata,
      });
      const managePlaylists = caps.capabilities.manage_playlists;
      if (managePlaylists?.state === "unavailable") {
        return { ok: false, code: managePlaylists.reason };
      }
      if (managePlaylists?.state !== "available") {
        return { ok: false, code: "missing_scope" };
      }
      if (account.channelId === null) {
        return { ok: false, code: "reconnect_required" };
      }
      const boundChannelId = account.channelId;

      // Step 3: Validate fields — free
      const validated = validatePlaylistCreateInput({ title, description, privacyStatus });
      if (!validated.ok) {
        return validated;
      }

      // Step 4: Per-user daily playlist creation counter (5 / 24 h)
      const counter = await deps.writeLimits.checkPlaylistCreateCounter(userId);
      if (!counter.ok) {
        return {
          ok: false,
          code: counter.code,
          ...(counter.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: counter.retryAfterSeconds }
            : {}),
        };
      }

      // Step 5: Project write budget debit (50 units)
      const budget = await deps.writeLimits.debitWriteBudget(YOUTUBE_PLAYLIST_CREATE_UNIT_COST);
      if (!budget.ok) {
        return {
          ok: false,
          code: "quota_exceeded",
          ...(budget.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: budget.retryAfterSeconds }
            : {}),
        };
      }

      // Step 6: Token + stillBound
      const token = await deps.tokens.get(account, { force: false });
      if (!token.ok) {
        return { ok: false, code: token.code };
      }
      const bound = await deps.stillBound({
        accountId: account.id,
        ownerId: userId,
        channelId: boundChannelId,
        accessToken: token.accessToken,
      });
      if (!bound) {
        return { ok: false, code: "reconnect_required" };
      }

      // Step 7: Single POST to playlists.insert — never retried
      const body = JSON.stringify({
        snippet: {
          title: validated.value.title,
          description: validated.value.description,
        },
        status: {
          privacyStatus: validated.value.privacyStatus,
        },
      });

      let response: Response;
      try {
        response = await deps.fetchImpl(PLAYLISTS_INSERT_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token.accessToken}`,
            "Content-Type": "application/json",
          },
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return { ok: false, code: "outcome_unknown" };
      }

      // Step 8: Response classification
      if (response.status >= 300 && response.status < 400) {
        return { ok: false, code: "outcome_unknown" };
      }
      if (response.ok) {
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          return { ok: false, code: "outcome_unknown" };
        }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          return { ok: false, code: "outcome_unknown" };
        }
        const item = payload as Record<string, unknown>;
        if (typeof item.id !== "string" || !YOUTUBE_PLAYLIST_ID_PATTERN.test(item.id)) {
          return { ok: false, code: "outcome_unknown" };
        }
        const snippet = item.snippet && typeof item.snippet === "object" && !Array.isArray(item.snippet)
          ? (item.snippet as Record<string, unknown>)
          : null;
        if (!snippet || snippet.channelId !== boundChannelId) {
          return { ok: false, code: "outcome_unknown" };
        }
        const status = item.status && typeof item.status === "object" && !Array.isArray(item.status)
          ? (item.status as Record<string, unknown>)
          : null;

        return {
          ok: true,
          value: {
            playlist: {
              id: item.id,
              title: typeof snippet.title === "string" && snippet.title.length > 0
                ? snippet.title
                : validated.value.title,
              privacy_status: typeof status?.privacyStatus === "string"
                ? status.privacyStatus
                : validated.value.privacyStatus,
              thumbnail_url: extractThumbnailUrl(snippet.thumbnails),
            },
          },
        };
      }

      const errorBody = await readErrorJson(response);
      return { ok: false, code: classifyPlaylistCreateFailure(response.status, errorBody) };
    },
  };
}
