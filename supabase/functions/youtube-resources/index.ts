import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import { checkUserRateLimit } from "../_shared/rate-limiter.ts";
import { uploadsPlaylistId } from "../_shared/youtubeComments.ts";
import { createSupabaseYouTubeRefreshStore, refreshYouTubeAccountToken } from "../_shared/youtubeTokenRefresh.ts";
import {
  createYouTubeResourcesHandler,
  type YouTubeResourceAccount,
  type YouTubeResourcesPorts,
} from "./handler.ts";
import { YOUTUBE_RESOURCE_QUOTA_POLICY } from "./contracts.ts";
import { toRateLimitDecision } from "./rateLimit.ts";
import { tokenResultFromOutcome } from "./tokens.ts";
import { createYouTubeReadClient } from "./youtubeReadClient.ts";
import { createYouTubeCategoryClient } from "./categoryClient.ts";
import { createConnectedEditPort, PUBLISHED_EDIT_WRITE_ENABLED } from "./editComposition.ts";
import { createYouTubeEditProvider } from "./editProvider.ts";

// A stalled PostgREST request must not hold the whole function: the account read and the
// awaited refusal-log insert both fail at this deadline and the handler answers
// internal_error or logs a warning. The audit insert is never retried.
const DB_REQUEST_TIMEOUT_MS = 8_000;

function fetchWithDeadline(input: Request | URL | string, init?: RequestInit): Promise<Response> {
  const deadline = AbortSignal.timeout(DB_REQUEST_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  return fetch(input, { ...init, signal });
}

const admin = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { global: { fetch: fetchWithDeadline } },
);

const refreshStore = createSupabaseYouTubeRefreshStore(admin);
const { per_user_burst: BURST, per_user_daily: DAILY } = YOUTUBE_RESOURCE_QUOTA_POLICY;

const ACCOUNT_COLUMNS =
  "id, user_id, platform_user_id, platform_username, auth_provider, needs_reauth, access_token, refresh_token, token_expires_at, account_metadata";

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toAccount(row: unknown): YouTubeResourceAccount | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  const id = text(record.id);
  const userId = text(record.user_id);
  if (!id || !userId) return null;
  return {
    id,
    userId,
    channelId: text(record.platform_user_id),
    channelTitle: text(record.platform_username),
    authProvider: text(record.auth_provider),
    needsReauth: record.needs_reauth === true,
    accessToken: text(record.access_token),
    refreshToken: text(record.refresh_token),
    tokenExpiresAt: text(record.token_expires_at),
    accountMetadata: record.account_metadata ?? null,
  };
}

const categoriesClient = createYouTubeCategoryClient({ fetchImpl: fetch });

const ports: YouTubeResourcesPorts = {
  // Tokens come only from the lease-based refresh helper: the handler never reaches
  // Google's token endpoint, and an on-demand read never records a transient failure
  // or requests the administrator recovery mode. snapshot carries the already-loaded row.
  tokens: {
    get: async (account, { force }) =>
      tokenResultFromOutcome(
        await refreshYouTubeAccountToken({
          accountId: account.id,
          snapshot: {
            access_token: account.accessToken,
            refresh_token: account.refreshToken,
            token_expires_at: account.tokenExpiresAt,
            needs_reauth: account.needsReauth,
          },
          force,
          recordTransientFailure: false,
          store: refreshStore,
        }),
      ),
  },
  youtube: createYouTubeReadClient({ fetchImpl: fetch, uploadsPlaylistIdFor: uploadsPlaylistId }),
  categories: categoriesClient,
  rateLimit: {
    check: async (userId) => {
      const burst = toRateLimitDecision(
        await checkUserRateLimit(admin, "youtube-resources:burst", userId, BURST.limit, BURST.window_seconds),
        BURST.window_seconds,
      );
      if (!burst.allowed) return burst;
      return toRateLimitDecision(
        await checkUserRateLimit(admin, "youtube-resources:day", userId, DAILY.limit, DAILY.window_seconds),
        DAILY.window_seconds,
      );
    },
  },
  auth: {
    // One argument on purpose: a body user_id would let a service-role bearer through,
    // and this endpoint only serves user JWT callers (spec section 3.2).
    authenticate: async (req) => ({ userId: (await authenticateCaller(req)).userId }),
  },
  accounts: {
    load: async ({ accountId, userId }) => {
      const { data, error } = await admin
        .from("social_accounts")
        .select(ACCOUNT_COLUMNS)
        .eq("id", accountId)
        .eq("user_id", userId)
        .eq("platform", "youtube")
        .eq("is_active", true)
        .maybeSingle();
      if (error) {
        // PostgREST error code only: enough to tell an outage from a constraint
        // error, never the message or any row data.
        console.error({
          event: "youtube_resources_db_error",
          op: "account_load",
          code: typeof error.code === "string" ? error.code : "unknown",
        });
        throw new Error("account_read_failed");
      }
      return toAccount(data);
    },
  },
  clock: { now: () => new Date() },
  ids: { requestId: () => crypto.randomUUID() },
  log: {
    refusal: async ({ operation, code, userId, accountId, requestId }) => {
      const { error } = await admin.from("system_logs").insert({
        level: "warn",
        category: "edge",
        source: "youtube-resources",
        message: "YouTube resource request refused",
        user_id: userId,
        metadata: { operation, code, account_id: accountId, request_id: requestId },
      });
      if (error) {
        console.error({
          event: "youtube_resources_db_error",
          op: "refusal_log",
          code: typeof error.code === "string" ? error.code : "unknown",
        });
        throw new Error("refusal_log_failed");
      }
    },
  },
};

// The production edit port is composed from the real domain logic but stays
// OFF until approved D1/D5 evidence exists. There is no runtime flag to flip.
ports.edit = createConnectedEditPort({
  enabled: PUBLISHED_EDIT_WRITE_ENABLED,
  provider: createYouTubeEditProvider({ fetchImpl: fetch }),
  categories: categoriesClient,
  tokens: ports.tokens,
  accounts: ports.accounts,
  clock: ports.clock,
});

Deno.serve(createYouTubeResourcesHandler(ports));
