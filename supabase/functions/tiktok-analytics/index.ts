// TikTok Analytics edge function — pulls connected account stats + videos via official API
// Uses scopes: user.info.basic, user.info.profile, user.info.stats, video.list

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { serviceRoleCallerUserId } from "../_shared/auth-helper.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TIKTOK_CLIENT_KEY = Deno.env.get("TIKTOK_CLIENT_KEY")!;
const TIKTOK_CLIENT_SECRET = Deno.env.get("TIKTOK_CLIENT_SECRET")!;

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min — TikTok cover_image_url signed URLs expire fast

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

function calculateEngagementScore(likes = 0, comments = 0, shares = 0, views = 0): number {
  return Math.round(likes * 1 + comments * 2 + shares * 1.5 + views * 0.1);
}

async function refreshTikTokToken(admin: ReturnType<typeof createClient>, accountId: string, refreshToken: string) {
  const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: TIKTOK_CLIENT_KEY,
      client_secret: TIKTOK_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (data.error || !data.access_token) {
    throw new Error(`token_refresh_failed: ${data.error_description || data.error || "unknown"}`);
  }
  const newExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  await admin
    .from("social_accounts")
    .update({
      access_token: data.access_token,
      refresh_token: data.refresh_token || refreshToken,
      token_expires_at: newExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", accountId);
  return data.access_token as string;
}

async function fetchProfile(accessToken: string) {
  const fields = "open_id,union_id,avatar_url,avatar_url_100,display_name,bio_description,profile_deep_link,is_verified,follower_count,following_count,likes_count,video_count";
  const res = await fetch(`https://open.tiktokapis.com/v2/user/info/?fields=${fields}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (data.error?.code && data.error.code !== "ok") {
    return { error: data.error };
  }
  return { user: data.data?.user };
}

async function fetchVideos(accessToken: string, cursor?: string) {
  const fields = "id,title,video_description,duration,cover_image_url,embed_link,share_url,view_count,like_count,comment_count,share_count,create_time";
  const body: Record<string, unknown> = { max_count: 20 };
  if (cursor) body.cursor = Number(cursor);
  const res = await fetch(`https://open.tiktokapis.com/v2/video/list/?fields=${fields}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error?.code && data.error.code !== "ok") {
    return { error: data.error };
  }
  return {
    videos: data.data?.videos || [],
    cursor: data.data?.cursor,
    has_more: data.data?.has_more || false,
  };
}

function mapTikTokError(err: { code?: string; message?: string }): string {
  const code = (err.code || "").toLowerCase();
  const msg = (err.message || "").toLowerCase();
  if (code.includes("scope_not_authorized") || msg.includes("scope")) return "scope_missing";
  if (code.includes("access_token_invalid") || code.includes("token_expired") || msg.includes("token")) return "token_expired";
  if (msg.includes("sandbox") || msg.includes("not in the test users")) return "sandbox_user_not_added";
  if (code.includes("rate_limit")) return "rate_limited";
  return "tiktok_api_error";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json({ success: false, error: "Unauthorized" }, 401);
    }

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.replace("Bearer ", "");
    let serviceUserId: string | null;
    try {
      serviceUserId = await serviceRoleCallerUserId(req);
    } catch {
      return json({ success: false, error: "Unauthorized" }, 401);
    }
    let userId: string;
    if (serviceUserId) {
      userId = serviceUserId;
    } else {
      const { data: claims, error: claimsErr } = await userClient.auth.getClaims(token);
      if (claimsErr || !claims?.claims) {
        return json({ success: false, error: "Unauthorized" }, 401);
      }
      userId = claims.claims.sub as string;
    }

    const body = await req.json().catch(() => ({}));
    const { social_account_id, cursor: reqCursor } = body as {
      social_account_id?: string;
      cursor?: string;
    };

    if (!social_account_id) {
      return json({ success: false, error: "social_account_id is required" }, 400);
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Load account, verify ownership (admins bypass via service role lookup)
    const { data: account, error: accErr } = await admin
      .from("social_accounts")
      .select("id, user_id, platform, platform_username, access_token, refresh_token, token_expires_at, avatar_url, account_metadata")
      .eq("id", social_account_id)
      .maybeSingle();

    if (accErr || !account) {
      return json({ success: false, error: "Account not found" }, 404);
    }
    if (account.platform !== "tiktok") {
      return json({ success: false, error: "Account is not a TikTok account" }, 400);
    }

    // Authorization: account must belong to caller OR caller is admin
    if (account.user_id !== userId) {
      const { data: roleRow } = await admin
        .from("user_roles")
        .select("role")
        .eq("user_id", userId)
        .eq("role", "admin")
        .maybeSingle();
      if (!roleRow) {
        return json({ success: false, error: "Forbidden" }, 403);
      }
    }

    // Cache check (only for first page)
    const cacheKey = reqCursor ? `cursor:${reqCursor}` : "page1";
    if (!reqCursor) {
      const { data: cached } = await admin
        .from("tiktok_api_analytics_cache")
        .select("profile_data, posts_data, cursor, has_more, expires_at")
        .eq("social_account_id", social_account_id)
        .eq("cache_key", cacheKey)
        .maybeSingle();
      if (cached && new Date(cached.expires_at).getTime() > Date.now()) {
        return json({
          success: true,
          cached: true,
          profile: cached.profile_data,
          posts: cached.posts_data,
          totalPosts: Array.isArray(cached.posts_data) ? cached.posts_data.length : 0,
          hasMore: cached.has_more,
          cursor: cached.cursor,
        });
      }
    }

    // Token: refresh if expired/about to expire (5 min buffer)
    let accessToken = account.access_token as string;
    const expiresAt = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0;
    if (!accessToken || expiresAt < Date.now() + 5 * 60 * 1000) {
      if (!account.refresh_token) {
        return json({ success: false, error_code: "token_expired", error: "Token expired and no refresh token. Please reconnect TikTok." });
      }
      try {
        accessToken = await refreshTikTokToken(admin, account.id, account.refresh_token as string);
      } catch (e) {
        return json({ success: false, error_code: "token_expired", error: (e as Error).message });
      }
    }

    // Fetch profile (only on first page)
    let profile: any = null;
    if (!reqCursor) {
      const profileRes = await fetchProfile(accessToken);
      if ("error" in profileRes && profileRes.error) {
        const code = mapTikTokError(profileRes.error);
        return json({ success: false, error_code: code, error: profileRes.error.message || "TikTok API error", details: profileRes.error });
      }
      const u = profileRes.user;
      profile = {
        id: u?.open_id || account.id,
        username: account.platform_username || u?.display_name || "",
        fullName: u?.display_name || account.platform_username || "",
        bio: u?.bio_description || "",
        avatarUrl: u?.avatar_url_100 || u?.avatar_url || account.avatar_url || "",
        followersCount: u?.follower_count || 0,
        followingCount: u?.following_count || 0,
        postsCount: u?.video_count || 0,
        isVerified: !!u?.is_verified,
        website: u?.profile_deep_link || null,
        platform: "tiktok",
        totalHearts: u?.likes_count || 0,
      };
    }

    // Fetch videos
    const videosRes = await fetchVideos(accessToken, reqCursor);
    if ("error" in videosRes && videosRes.error) {
      const code = mapTikTokError(videosRes.error);
      return json({ success: false, error_code: code, error: videosRes.error.message || "TikTok API error", details: videosRes.error });
    }

    const posts = (videosRes.videos || []).map((v: any) => ({
      id: String(v.id),
      mediaType: "VIDEO",
      thumbnailUrl: v.cover_image_url || "",
      mediaUrl: v.embed_link || v.share_url || "",
      caption: v.title || v.video_description || "",
      likesCount: v.like_count || 0,
      commentsCount: v.comment_count || 0,
      videoViewCount: v.view_count || 0,
      sharesCount: v.share_count || 0,
      savesCount: 0,
      engagementScore: calculateEngagementScore(v.like_count, v.comment_count, v.share_count, v.view_count),
      timestamp: v.create_time ? new Date(v.create_time * 1000).toISOString() : new Date().toISOString(),
      permalink: v.share_url || v.embed_link || "",
      duration: v.duration || 0,
    }));

    const result = {
      success: true,
      profile,
      posts,
      totalPosts: posts.length,
      hasMore: videosRes.has_more || false,
      cursor: videosRes.cursor ? String(videosRes.cursor) : undefined,
    };

    // Cache first page only
    if (!reqCursor && profile) {
      await admin
        .from("tiktok_api_analytics_cache")
        .upsert(
          {
            user_id: account.user_id,
            social_account_id,
            cache_key: cacheKey,
            profile_data: profile,
            posts_data: posts,
            cursor: result.cursor || null,
            has_more: result.hasMore,
            expires_at: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
            updated_at: new Date().toISOString(),
          },
          { onConflict: "social_account_id,cache_key" },
        );
    }

    return json(result);
  } catch (e) {
    console.error("[tiktok-analytics] error:", e);
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
