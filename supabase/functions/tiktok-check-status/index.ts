// TikTok status check. Owner-scoped. Settles terminal provider states through
// applyTikTokPublishOutcome rather than writing platform_posts directly.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import { fetchWithTimeout } from "../_shared/request-timeout.ts";
import { applyTikTokPublishOutcome } from "../_shared/tiktokPublishOutcome.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TIKTOK_STATUS_URL = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";
const TIKTOK_TIMEOUT_MS = 10_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type TokenMatch = {
  accessToken: string;
  username: string | null;
  userOpenId: string | null;
};

function tokenFromAccount(account: {
  access_token?: string | null;
  platform_username?: string | null;
  platform_user_id?: string | null;
} | null): TokenMatch | null {
  if (!account?.access_token) return null;
  return {
    accessToken: account.access_token,
    username: account.platform_username ?? null,
    userOpenId: account.platform_user_id ?? null,
  };
}

async function tokenByPublishKey(
  supabase: SupabaseClient,
  column: "response_data->>tiktok_publish_id" | "response_data->>publish_id",
  publishId: string,
  callerUserId: string | null,
): Promise<TokenMatch | null> {
  let query = supabase
    .from("platform_posts")
    .select(
      "social_account_id, social_accounts!inner(access_token, platform_username, platform_user_id), posts!inner(user_id)",
    )
    .eq(column, publishId)
    .eq("platform", "tiktok");
  if (callerUserId) query = query.eq("posts.user_id", callerUserId);

  const { data, error } = await query.limit(1);
  if (error) throw new Error("tiktok_status_read_failed");
  const row = Array.isArray(data) ? data[0] as {
    social_accounts?: {
      access_token?: string | null;
      platform_username?: string | null;
      platform_user_id?: string | null;
    } | Array<{
      access_token?: string | null;
      platform_username?: string | null;
      platform_user_id?: string | null;
    }>;
  } | undefined : undefined;
  if (!row) return null;
  const joined = row.social_accounts;
  const account = Array.isArray(joined) ? joined[0] : joined;
  return tokenFromAccount(account ?? null);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (!req.headers.get("Authorization")?.startsWith("Bearer ")) {
    return json({ success: false, error: "Unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    let publish_id: string | undefined;
    let account_id: string | undefined;
    let bodyUserId: string | undefined;
    try {
      const text = await req.text();
      const parsed = text ? JSON.parse(text) : {};
      publish_id = parsed.publish_id;
      account_id = parsed.account_id;
      bodyUserId = typeof parsed.user_id === "string" ? parsed.user_id : undefined;
    } catch {
      return json({ success: false, error: "Malformed JSON body", code: "INVALID_JSON" }, 400);
    }

    let caller;
    try {
      caller = await authenticateCaller(req, bodyUserId);
    } catch {
      return json({ success: false, error: "Unauthorized" }, 401);
    }
    const callerUserId = caller.isServiceRole ? null : caller.userId;

    if (!publish_id) {
      return json({ success: false, error: "Missing publish_id", code: "MISSING_PUBLISH_ID" }, 400);
    }

    console.log(`[TikTok Status] Checking status for publish_id: ${publish_id}`);

    let match: TokenMatch | null = null;
    if (account_id) {
      let accountQuery = supabase
        .from("social_accounts")
        .select("access_token, platform_username, platform_user_id")
        .eq("id", account_id)
        .eq("platform", "tiktok");
      if (callerUserId) accountQuery = accountQuery.eq("user_id", callerUserId);
      const { data: account, error: accountError } = await accountQuery.maybeSingle();
      if (accountError) throw new Error("tiktok_status_account_read_failed");
      match = tokenFromAccount(account);
    }

    if (!match) {
      match = await tokenByPublishKey(
        supabase,
        "response_data->>tiktok_publish_id",
        publish_id,
        callerUserId,
      );
    }
    if (!match) {
      match = await tokenByPublishKey(
        supabase,
        "response_data->>publish_id",
        publish_id,
        callerUserId,
      );
    }

    if (!match) {
      console.error("[TikTok Status] No access token found");
      return json({
        success: false,
        error: "No access token found",
        status: "unknown",
      });
    }

    const response = await fetchWithTimeout(
      TIKTOK_STATUS_URL,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${match.accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify({ publish_id }),
      },
      TIKTOK_TIMEOUT_MS,
    );

    const responseText = await response.text();
    let data: {
      error?: { code?: string | number; message?: string };
      data?: {
        status?: string;
        publicaly_available_post_id?: unknown;
        post_id?: unknown;
        fail_reason?: string | null;
      };
    };
    try {
      data = JSON.parse(responseText);
    } catch {
      console.error("[TikTok Status] Failed to parse response");
      return json({
        success: false,
        error: "Failed to parse TikTok response",
        status: "unknown",
      });
    }

    if (data.error?.code) {
      console.error("[TikTok Status] API error code:", String(data.error.code));
      if (data.error.code === "access_token_invalid" || data.error.code === 10002) {
        return json({
          success: false,
          error: "TikTok session expired. Please reconnect your account.",
          status: "FAILED",
          fail_reason: "Access token expired",
        });
      }
      return json({
        success: false,
        error: data.error.message || "TikTok API error",
        status: "unknown",
      });
    }

    const statusData = data.data || {};
    const status = statusData.status || "unknown";
    const publicIds = statusData.publicaly_available_post_id;
    const firstPublicId = Array.isArray(publicIds) ? publicIds[0] : null;
    const postId = (typeof firstPublicId === "string" ? firstPublicId : null) ||
      (typeof statusData.post_id === "string" ? statusData.post_id : null);
    const failReason = statusData.fail_reason || null;

    console.log(`[TikTok Status] Status: ${status}, FailReason: ${failReason ?? ""}`);

    if (postId && status === "PUBLISH_COMPLETE") {
      await applyTikTokPublishOutcome(supabase, {
        publishId: publish_id,
        userOpenId: match.userOpenId,
        outcome: { kind: "published", providerPostId: postId },
      });
    }

    if (status === "FAILED") {
      await applyTikTokPublishOutcome(supabase, {
        publishId: publish_id,
        userOpenId: match.userOpenId,
        outcome: { kind: "failed", reason: failReason || "Unknown error" },
      });
    }

    return json({
      success: true,
      status,
      post_id: postId,
      fail_reason: failReason,
      username: match.username,
    });
  } catch (error) {
    console.error(
      "[TikTok Status] Error:",
      error instanceof Error ? error.message : "unknown",
    );
    return json({
      success: false,
      error: "Internal error",
      status: "unknown",
    }, 500);
  }
});
