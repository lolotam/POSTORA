import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import { pacificDateString } from "../_shared/pacificDay.ts";
import {
  createSupabaseYouTubeRefreshStore,
  refreshYouTubeAccountToken,
  type YouTubeRefreshOutcome,
} from "../_shared/youtubeTokenRefresh.ts";
import { parseStrictRateLimitDecision } from "../youtube-resources/writeLimits.ts";
import { createYouTubeBenchmarkReadClient } from "./benchmarkReadClient.ts";
import {
  YOUTUBE_BENCHMARK_BUDGET_WINDOW_SECONDS,
  YOUTUBE_BENCHMARK_DAILY_BUDGET_UNITS,
  YOUTUBE_BENCHMARK_PER_USER_BURST,
  YOUTUBE_BENCHMARK_PER_USER_DAILY,
} from "./contracts.ts";
import {
  createYouTubeBenchmarkHandler,
  parseStrictBenchmarkBudgetDecision,
  type YouTubeBenchmarkAccount,
  type YouTubeBenchmarkPorts,
  type YouTubeBenchmarkRateLimitResult,
  type YouTubeBenchmarkTokenResult,
} from "./handler.ts";

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

const ACCOUNT_COLUMNS =
  "id, user_id, platform_user_id, platform_username, auth_provider, needs_reauth, access_token, refresh_token, token_expires_at, account_metadata";

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toAccount(row: unknown): YouTubeBenchmarkAccount | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  const id = nonEmptyText(record.id);
  const userId = nonEmptyText(record.user_id);
  if (!id || !userId) return null;
  return {
    id,
    userId,
    channelId: nonEmptyText(record.platform_user_id),
    channelTitle: nonEmptyText(record.platform_username),
    authProvider: nonEmptyText(record.auth_provider),
    needsReauth: record.needs_reauth === true,
    accessToken: nonEmptyText(record.access_token),
    refreshToken: nonEmptyText(record.refresh_token),
    tokenExpiresAt: nonEmptyText(record.token_expires_at),
    accountMetadata: record.account_metadata ?? null,
  };
}

function toTokenResult(outcome: YouTubeRefreshOutcome): YouTubeBenchmarkTokenResult {
  if (outcome.ok) {
    return { ok: true, accessToken: outcome.accessToken, minted: outcome.status === "refreshed" };
  }
  if (
    outcome.status === "needs_reauth" ||
    outcome.reason === "no_refresh_token" ||
    outcome.reason === "refresh_refused"
  ) {
    return { ok: false, code: "reconnect_required" };
  }
  return { ok: false, code: "upstream_unavailable" };
}

async function checkUserCounter(
  endpoint: string,
  userId: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<YouTubeBenchmarkRateLimitResult> {
  try {
    const { data, error } = await admin.rpc("check_rate_limit", {
      p_endpoint: endpoint,
      p_identifier: `user:${userId}`,
      p_max_requests: maxRequests,
      p_window_seconds: windowSeconds,
    });
    if (error) return { ok: false, code: "upstream_unavailable" };
    const parsed = parseStrictRateLimitDecision(data, maxRequests);
    if (!parsed) return { ok: false, code: "upstream_unavailable" };
    if (!parsed.allowed) {
      return {
        ok: true,
        allowed: false,
        retryAfterSeconds: Math.max(1, parsed.retryAfterSeconds),
      };
    }
    return { ok: true, allowed: true };
  } catch {
    return { ok: false, code: "upstream_unavailable" };
  }
}

const ports: YouTubeBenchmarkPorts = {
  auth: {
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
        console.error({
          event: "youtube_benchmark_db_error",
          op: "account_load",
          code: typeof error.code === "string" ? error.code : "unknown",
        });
        throw new Error("account_read_failed");
      }
      return toAccount(data);
    },
  },
  tokens: {
    get: async (account, { force }) =>
      toTokenResult(
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
  rateLimits: {
    checkUser: async (userId) => {
      const burst = await checkUserCounter(
        "youtube-channel-benchmark:burst",
        userId,
        YOUTUBE_BENCHMARK_PER_USER_BURST.limit,
        YOUTUBE_BENCHMARK_PER_USER_BURST.window_seconds,
      );
      if (!burst.ok || !burst.allowed) return burst;
      return await checkUserCounter(
        "youtube-channel-benchmark:day",
        userId,
        YOUTUBE_BENCHMARK_PER_USER_DAILY.limit,
        YOUTUBE_BENCHMARK_PER_USER_DAILY.window_seconds,
      );
    },
  },
  budget: {
    debit: async (units) => {
      try {
        const key = `youtube-channel-benchmark:budget:data:${pacificDateString(new Date())}`;
        const { data, error } = await admin.rpc("check_weighted_rate_limit", {
          p_key: key,
          p_cost: units,
          p_max: YOUTUBE_BENCHMARK_DAILY_BUDGET_UNITS,
          p_window_seconds: YOUTUBE_BENCHMARK_BUDGET_WINDOW_SECONDS,
        });
        if (error) return { allowed: false, code: "upstream_unavailable" };
        const parsed = parseStrictBenchmarkBudgetDecision(data, units);
        if (!parsed) return { allowed: false, code: "upstream_unavailable" };
        if (!parsed.allowed) return { allowed: false, code: "quota_exceeded" };
        return { allowed: true };
      } catch {
        return { allowed: false, code: "upstream_unavailable" };
      }
    },
  },
  read: createYouTubeBenchmarkReadClient({ fetchImpl: fetch }),
  audit: {
    logRefusal: async ({ code, userId, accountId, requestId }) => {
      const { error } = await admin.from("system_logs").insert({
        level: "warn",
        category: "edge",
        source: "youtube-channel-benchmark",
        message: "YouTube channel benchmark request refused",
        user_id: userId,
        metadata: { code, account_id: accountId, request_id: requestId },
      });
      if (error) {
        console.error({
          event: "youtube_benchmark_db_error",
          op: "refusal_log",
          code: typeof error.code === "string" ? error.code : "unknown",
        });
        throw new Error("refusal_log_failed");
      }
    },
  },
  clock: { now: () => new Date() },
  ids: { requestId: () => crypto.randomUUID() },
};

Deno.serve(createYouTubeBenchmarkHandler(ports));
