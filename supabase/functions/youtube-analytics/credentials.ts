import {
  createSupabaseYouTubeRefreshStore,
  type YouTubeRefreshStore,
  type YouTubeStoredAccount,
} from "../_shared/youtubeTokenRefresh.ts";
import {
  ANALYTICS_PURPOSE_VERSION,
  YOUTUBE_ANALYTICS_REQUIRED_SCOPES,
  type YouTubeAnalyticsErrorCode,
} from "./contracts.ts";
import {
  decideYouTubeAnalytics,
  type YouTubeAnalyticsBinding,
  type YouTubeAnalyticsDecisionDenial,
  type YouTubeAnalyticsRpcRunner,
} from "./decision.ts";

export type BoundYouTubeAnalyticsRefreshStore = YouTubeRefreshStore & {
  lastDenial: YouTubeAnalyticsDecisionDenial | null;
};

const DECISION_REASONS = new Set<YouTubeAnalyticsErrorCode>([
  "invalid_request",
  "not_found",
  "connection_changed",
  "provider_unsupported",
  "not_enabled",
  "consent_required",
  "reconnect_required",
  "missing_scope",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function neutralAccount(accountId: string, needsReauth: boolean): YouTubeStoredAccount {
  return {
    id: accountId,
    access_token: null,
    refresh_token: null,
    token_expires_at: null,
    needs_reauth: needsReauth,
    is_active: true,
    auth_provider: "native",
  };
}

export function createBoundYouTubeAnalyticsRefreshStore(options: {
  rpc: YouTubeAnalyticsRpcRunner;
  binding: YouTubeAnalyticsBinding;
}): BoundYouTubeAnalyticsRefreshStore {
  const { rpc, binding } = options;
  const shared = createSupabaseYouTubeRefreshStore({ rpc });
  const store: BoundYouTubeAnalyticsRefreshStore = {
    lastDenial: null,

    async readAccount(accountId) {
      if (accountId !== binding.accountId) {
        store.lastDenial = { code: "connection_changed", binding };
        return null;
      }
      store.lastDenial = null;
      const decision = await decideYouTubeAnalytics(rpc, {
        ownerId: binding.ownerId,
        accountId,
        expected: binding,
        withCredentials: true,
      });
      if (decision.ok) {
        const credentials = decision.credentials!;
        return {
          id: accountId,
          access_token: credentials.accessToken,
          refresh_token: credentials.refreshToken,
          token_expires_at: credentials.tokenExpiresAt,
          needs_reauth: decision.binding.needsReauth,
          is_active: true,
          auth_provider: "native",
        };
      }
      store.lastDenial = { code: decision.code, ...(decision.binding ? { binding: decision.binding } : {}) };
      if (decision.code === "reconnect_required" && decision.binding?.needsReauth === true) {
        return neutralAccount(accountId, true);
      }
      return null;
    },

    async acquireLease(accountId, ttlSeconds) {
      if (accountId !== binding.accountId) {
        store.lastDenial = { code: "connection_changed", binding };
        return { ok: false, reason: "account_not_found" };
      }
      try {
        const { data: raw, error } = await rpc("youtube_analytics_stage5_acquire_lease", {
          p_owner_id: binding.ownerId,
          p_account_id: accountId,
          p_expected_channel: binding.channelId,
          p_expected_generation: binding.bindingGeneration,
          p_expected_incarnation: binding.bindingIncarnation,
          p_required_scopes: [...YOUTUBE_ANALYTICS_REQUIRED_SCOPES],
          p_purpose_version: binding.consent.version,
          p_ttl_seconds: ttlSeconds,
        });
        const data = record(raw);
        if (error || !data || typeof data.ok !== "boolean") {
          store.lastDenial = { code: "settings_unavailable" };
          return { ok: false, reason: "account_not_found" };
        }
        if (data.ok && typeof data.lease_token === "string" && data.lease_token.length > 0 &&
          typeof data.expires_at === "string") {
          return { ok: true, lease_token: data.lease_token, expires_at: data.expires_at };
        }
        if (!data.ok && data.reason === "lease_held") {
          return {
            ok: false,
            reason: "lease_held",
            expires_at: typeof data.expires_at === "string" ? data.expires_at : null,
          };
        }
        const code = typeof data.reason === "string" &&
            DECISION_REASONS.has(data.reason as YouTubeAnalyticsErrorCode)
          ? data.reason as YouTubeAnalyticsErrorCode
          : "settings_unavailable";
        store.lastDenial = { code };
        return { ok: false, reason: "account_not_found" };
      } catch {
        store.lastDenial = { code: "settings_unavailable" };
        return { ok: false, reason: "account_not_found" };
      }
    },

    async storeTokenWithLease(input) {
      if (input.accountId !== binding.accountId) {
        store.lastDenial = { code: "connection_changed", binding };
        return { ok: false, reason: "connection_changed" };
      }
      try {
        const { data: raw, error } = await rpc("youtube_analytics_stage5_store_token", {
          p_owner_id: binding.ownerId,
          p_account_id: input.accountId,
          p_expected_channel: binding.channelId,
          p_expected_generation: binding.bindingGeneration,
          p_expected_incarnation: binding.bindingIncarnation,
          p_lease_token: input.leaseToken,
          p_new_access_token: input.accessToken,
          p_new_token_expires_at: input.tokenExpiresAt,
          p_new_refresh_token: input.refreshToken,
        });
        const data = record(raw);
        if (error || !data || typeof data.ok !== "boolean") {
          store.lastDenial = { code: "settings_unavailable" };
          return { ok: false, reason: "store_failed" };
        }
        if (data.ok) return { ok: true };
        const reason = typeof data.reason === "string" ? data.reason : "store_failed";
        if (DECISION_REASONS.has(reason as YouTubeAnalyticsErrorCode)) {
          store.lastDenial = { code: reason as YouTubeAnalyticsErrorCode };
        }
        return { ok: false, reason };
      } catch {
        store.lastDenial = { code: "settings_unavailable" };
        return { ok: false, reason: "store_failed" };
      }
    },

    recordFailureWithLease() {
      throw new Error("recordFailureWithLease must never be called in healthNeutral mode");
    },

    async releaseLease(accountId, leaseToken) {
      if (accountId !== binding.accountId) return false;
      return await shared.releaseLease(accountId, leaseToken);
    },
  };
  return store;
}
