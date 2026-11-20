import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import {
  createYouTubeResourcesHandler,
  type YouTubeResourceAccount,
  type YouTubeResourcesPorts,
} from "./handler.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

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

const ports: YouTubeResourcesPorts = {
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
      if (error) throw new Error("account_read_failed");
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
      if (error) throw new Error("refusal_log_failed");
    },
  },
};

Deno.serve(createYouTubeResourcesHandler(ports));
