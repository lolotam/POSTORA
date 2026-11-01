import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createLogger } from "../_shared/logging.ts";
import type { ViewerCandidate } from "../_shared/instagramDiscoveryViewer.ts";
import { CredentialStoreError } from "../_shared/facebookUserCredentialStore.ts";
import { normalizeCompetitorHandle } from "../competitor-snapshot-sync/graphProvider.ts";
import { discoveryCacheKey, discoveryMedia, discoveryProfile, InstagramDiscoveryError, resolveDiscoveryAuthority, scrapeInstagramOfficial, scrapeInstagramOwn } from "./instagramDiscovery.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function calculateEngagementScore(likes = 0, comments = 0, shares = 0, views = 0): number {
  return Math.round((likes * 1) + (comments * 2) + (shares * 1.5) + (views * 0.1));
}

// ─── Instagram: Official Business Discovery API ───
// ─── Instagram: Apify fallback ───
async function scrapeInstagramApify(username: string, apifyToken: string, actorId = "apify~instagram-scraper", maxPosts = 50) {
  const url = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${apifyToken}&timeout=60`;
  const res = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(60_000),
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      directUrls: [`https://www.instagram.com/${username}/`],
      resultsType: "posts",
      resultsLimit: maxPosts,
      addParentData: true,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Apify error ${res.status}: ${errText}`);
  }
  const items = await res.json();
  if (!items?.length) throw new Error("Profile not found or no posts");
  const p = items[0];
  return {
    profile: discoveryProfile({ id: p.ownerId ?? username, username, name: p.ownerFullName,
      biography: p.biography, profile_picture_url: p.profilePicUrl, followers_count: p.followersCount,
      follows_count: p.followingCount, media_count: p.postsCount, is_verified: p.verified, website: p.externalUrl }, username, "apify"),
    posts: items.map((item: Record<string, unknown>) => discoveryMedia({
      id: item.id || item.shortCode, media_type: item.type === "Video" ? "VIDEO" : item.type === "Sidecar" ? "CAROUSEL_ALBUM" : "IMAGE",
      media_product_type: item.productType === "clips" || item.productType === "reels" ? "REELS" : "FEED",
      thumbnail_url: item.displayUrl, media_url: item.videoUrl || item.displayUrl, caption: item.caption,
      like_count: item.likesCount, comments_count: item.commentsCount, view_count: item.videoViewCount,
      timestamp: item.timestamp, permalink: `https://www.instagram.com/p/${item.shortCode}/`,
    })),
  };
}

// ─── Facebook: App Access Token (public pages) ───
async function scrapeFacebook(pageIdentifier: string, appId: string, appSecret: string, maxPosts = 50) {
  const appAccessToken = `${appId}|${appSecret}`;
  const baseUrl = "https://graph.facebook.com/v22.0";

  const pageFields = "id,name,username,about,fan_count,picture{url},cover,website,verification_status";
  const pageRes = await fetch(
    `${baseUrl}/${encodeURIComponent(pageIdentifier)}?fields=${pageFields}&access_token=${appAccessToken}`
  );
  if (!pageRes.ok) {
    const errText = await pageRes.text();
    throw new Error(`Facebook page not found (${pageRes.status}): ${errText}`);
  }
  const pageData = await pageRes.json();
  if (pageData.error) throw new Error(pageData.error.message);

  const postFields = "id,message,story,full_picture,created_time,permalink_url," +
    "attachments{type,subattachments{type,media_type,media},media_type,media{source},description}," +
    "likes.summary(true),comments.summary(true),shares,reactions.summary(true)";
  const postsRes = await fetch(
    `${baseUrl}/${pageData.id}/posts?fields=${postFields}&limit=${maxPosts}&access_token=${appAccessToken}`
  );
  if (!postsRes.ok) {
    const errText = await postsRes.text();
    throw new Error(`Facebook posts fetch failed (${postsRes.status}): ${errText}`);
  }
  const postsData = await postsRes.json();
  if (postsData.error) throw new Error(postsData.error.message);

  const posts = (postsData.data || []).map((post: any) => {
    const likes = post.likes?.summary?.total_count || 0;
    const comments = post.comments?.summary?.total_count || 0;
    const shares = post.shares?.count || 0;
    const reactions = post.reactions?.summary?.total_count || 0;

    let mediaType = "IMAGE";
    const attachmentType = post.attachments?.data?.[0]?.type || "";
    const attachmentMediaType = post.attachments?.data?.[0]?.media_type || "";
    const subattachments = post.attachments?.data?.[0]?.subattachments?.data;
    const description = post.attachments?.data?.[0]?.description || "";
    const storyText = post.story || "";

    if (subattachments && subattachments.length > 1) {
      mediaType = "CAROUSEL";
    } else if (
      attachmentType.includes("video") ||
      attachmentMediaType === "video" ||
      (attachmentType === "share" && attachmentMediaType === "video")
    ) {
      if (storyText.toLowerCase().includes("reel") || description.toLowerCase().includes("reel")) {
        mediaType = "REEL";
      } else {
        mediaType = "VIDEO";
      }
    } else if (attachmentType.includes("album")) {
      mediaType = "CAROUSEL";
    } else if (!post.full_picture && !attachmentType) {
      mediaType = "TEXT";
    }

    return {
      id: post.id,
      mediaType,
      thumbnailUrl: post.full_picture || "",
      mediaUrl: post.full_picture || "",
      caption: post.message || post.story || "",
      likesCount: reactions || likes,
      commentsCount: comments,
      videoViewCount: 0,
      sharesCount: shares,
      savesCount: 0,
      engagementScore: calculateEngagementScore(reactions || likes, comments, shares, 0),
      timestamp: post.created_time,
      permalink: post.permalink_url || `https://www.facebook.com/${post.id}`,
    };
  });

  // Try fetching Reels separately and merge
  const existingIds = new Set(posts.map((p: any) => p.id));
  try {
    const reelsRes = await fetch(
      `${baseUrl}/${pageData.id}/video_reels?fields=id,description,created_time,` +
      `thumbnails,permalink_url,likes.summary(true),comments.summary(true),shares` +
      `&limit=25&access_token=${appAccessToken}`
    );
    if (reelsRes.ok) {
      const reelsData = await reelsRes.json();
      for (const reel of (reelsData.data || [])) {
        if (existingIds.has(reel.id)) continue;
        const rLikes = reel.likes?.summary?.total_count || 0;
        const rComments = reel.comments?.summary?.total_count || 0;
        const rShares = reel.shares?.count || 0;
        const thumbnail = reel.thumbnails?.data?.[0]?.uri || "";
        posts.push({
          id: reel.id,
          mediaType: "REEL",
          thumbnailUrl: thumbnail,
          mediaUrl: thumbnail,
          caption: reel.description || "",
          likesCount: rLikes,
          commentsCount: rComments,
          videoViewCount: 0,
          sharesCount: rShares,
          savesCount: 0,
          engagementScore: calculateEngagementScore(rLikes, rComments, rShares, 0),
          timestamp: reel.created_time,
          permalink: reel.permalink_url || `https://www.facebook.com/${reel.id}`,
        });
      }
    }
  } catch (_e) {
    // Reels endpoint may not be available with app token — silently skip
  }

  return {
    profile: {
      id: pageData.id,
      username: pageData.username || pageIdentifier,
      fullName: pageData.name,
      bio: pageData.about || "",
      avatarUrl: pageData.picture?.data?.url || "",
      followersCount: pageData.fan_count || 0,
      followingCount: 0,
      postsCount: posts.length,
      isVerified: pageData.verification_status === "blue_verified" || pageData.verification_status === "gray_verified",
      website: pageData.website || null,
      platform: "facebook",
    },
    posts,
  };
}

// ─── TikTok: Apify only ───
async function scrapeTikTok(username: string, apifyToken: string, actorId = "clockworks~free-tiktok-scraper", maxPosts = 50) {
  const cleanUsername = username.replace("@", "");
  const apifyUrl = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${apifyToken}&timeout=90`;

  const res = await fetch(apifyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      profiles: [cleanUsername],
      resultsPerPage: maxPosts,
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`TikTok scraping failed (${res.status}): ${errText}`);
  }
  const items = await res.json();
  if (!items?.length) throw new Error("TikTok profile not found or has no posts");

  const firstItem = items[0];
  const channel = firstItem.channel || firstItem.authorMeta || {};

  const posts = items.map((item: any) => {
    const views = item.views || item.playCount || 0;
    const likes = item.likes || item.diggCount || 0;
    const comments = item.comments || item.commentCount || 0;
    const shares = item.shares || item.shareCount || 0;
    const bookmarks = item.bookmarks || item.collectCount || 0;

    return {
      id: item.id,
      mediaType: "REEL",
      thumbnailUrl: item.video?.cover || item.covers?.default || item.thumbnail || "",
      mediaUrl: item.video?.playAddr || item.webVideoUrl || "",
      caption: item.title || item.text || "",
      likesCount: likes,
      commentsCount: comments,
      videoViewCount: views,
      sharesCount: shares,
      savesCount: bookmarks,
      bookmarksCount: bookmarks,
      hashtags: (item.hashtags || []).map((h: any) => h.name || h),
      songTitle: item.music?.title || item.musicMeta?.musicName || "",
      duration: item.video?.duration || item.videoMeta?.duration || 0,
      engagementScore: calculateEngagementScore(likes, comments, shares, views),
      timestamp: item.createTime
        ? new Date(item.createTime * 1000).toISOString()
        : item.uploadedAt || new Date().toISOString(),
      permalink: item.webVideoUrl || `https://www.tiktok.com/@${cleanUsername}`,
    };
  });

  return {
    profile: {
      id: channel.id || cleanUsername,
      username: channel.name || cleanUsername,
      fullName: channel.nickName || channel.name || cleanUsername,
      bio: channel.signature || channel.bio || "",
      avatarUrl: channel.avatar || channel.avatarThumb || "",
      followersCount: channel.fans || channel.followerCount || 0,
      followingCount: channel.following || channel.followingCount || 0,
      postsCount: channel.video || channel.videoCount || items.length,
      isVerified: channel.verified || false,
      totalHearts: channel.heart || channel.heartCount || 0,
      website: channel.bioLink?.link || null,
      platform: "tiktok",
    },
    posts,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const logger = createLogger(supabaseAdmin, "brand-scrape", "edge");

  let userId: string | undefined;
  let platform = "instagram";
  let cleanUsername = "";

  try {
    if (req.method !== "POST") {
      await logger.warn("Discovery request refused", { error_code: "METHOD_NOT_ALLOWED" });
      return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });
    }
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      await logger.warn("Discovery request refused", { error_code: "UNAUTHORIZED" });
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user } } = await supabaseAdmin.auth.getUser(token);
    if (!user) {
      await logger.warn("Discovery request refused", { error_code: "UNAUTHORIZED" });
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    userId = user.id;

    let body;
    try { body = await req.json(); } catch { throw new InstagramDiscoveryError("INVALID_DISCOVERY_REQUEST", "Invalid discovery request.", 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new InstagramDiscoveryError("INVALID_DISCOVERY_REQUEST", "Invalid discovery request.", 400);
    const { username, offset = 0 } = body;
    platform = body.platform || "instagram";

    if (typeof username !== "string" || !username.trim()) {
      await logger.warn("Discovery request refused", { error_code: "INVALID_DISCOVERY_REQUEST" }, userId);
      return new Response(JSON.stringify({ error: "username required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    cleanUsername = username.replace("@", "").toLowerCase().trim();
    if (platform === "instagram" && (!normalizeCompetitorHandle(cleanUsername) || !Number.isInteger(offset) || offset < 0 || offset > 100)) {
      throw new InstagramDiscoveryError("INVALID_DISCOVERY_REQUEST", "Invalid Instagram discovery request.", 400);
    }
    let cacheKey = `${platform}:${cleanUsername}`;

    // Log scrape started
    await logger.info(`Scrape started for ${platform}:${cleanUsername}`, {
      platform,
      username: cleanUsername,
      offset,
    }, userId);

    // Read Apify actor endpoints + max posts from app_settings BEFORE cache check
    const { data: actorSettings, error: settingsError } = await supabaseAdmin
      .from("app_settings")
      .select("key, value")
      .in("key", ["apify_actor_instagram", "apify_actor_tiktok", "apify_actor_facebook", "apify_actor_threads", "brand_scrape_max_posts", "apify_enabled"]);

    const getActorId = (key: string, fallback: string): string => {
      const setting = (actorSettings || []).find((s: any) => s.key === key);
      if (!setting) return fallback;
      try {
        const parsed = typeof setting.value === "string" ? JSON.parse(setting.value) : setting.value;
        return String(parsed).replace("/", "~") || fallback;
      } catch { return fallback; }
    };

    // Read max posts limit from settings
    let maxPosts = 50;
    try {
      const maxPostsSetting = (actorSettings || []).find((s: any) => s.key === "brand_scrape_max_posts");
      if (maxPostsSetting?.value) {
        const parsed = typeof maxPostsSetting.value === "string" ? JSON.parse(maxPostsSetting.value) : maxPostsSetting.value;
        maxPosts = Math.max(1, Math.min(100, Number(parsed) || 50));
      }
    } catch { /* optional enrichment; scraping continues without it */ }

    // Read apify_enabled toggle
    let isApifyEnabled = platform !== "instagram"; // Preserve other platforms' legacy default.
    try {
      const apifyEnabledSetting = (actorSettings || []).find((s: any) => s.key === "apify_enabled");
      if (apifyEnabledSetting && apifyEnabledSetting.value !== undefined) {
        const parsed = typeof apifyEnabledSetting.value === "string" ? JSON.parse(apifyEnabledSetting.value) : apifyEnabledSetting.value;
        isApifyEnabled = parsed === true || (platform !== "instagram" && parsed === "true");
      }
    } catch { /* optional enrichment; scraping continues without it */ }

    console.log(`maxPosts setting resolved to: ${maxPosts}, apify_enabled: ${isApifyEnabled}`);

    let discoveryContext: Awaited<ReturnType<typeof resolveDiscoveryAuthority>> | null = null;
    if (platform === "instagram") {
      if (settingsError) throw new InstagramDiscoveryError("DISCOVERY_UNAVAILABLE", "Instagram discovery is unavailable.", 503);
      const { data: accounts, error: accountError } = await supabaseAdmin.from("social_accounts")
        .select("id,user_id,platform,platform_user_id,platform_username,access_token,is_active,needs_reauth,ig_auth_type,connected_at")
        .eq("user_id", user.id).eq("platform", "instagram").eq("is_active", true).limit(101);
      if (accountError || !Array.isArray(accounts) || accounts.length > 100) {
        throw new InstagramDiscoveryError("DISCOVERY_UNAVAILABLE", "Instagram discovery is unavailable.", 503);
      }
      const authorityDeadline = AbortSignal.timeout(10_000);
      discoveryContext = await resolveDiscoveryAuthority({ rpc: async (name, args) => await supabaseAdmin.rpc(name, args).abortSignal(authorityDeadline),
        accounts: accounts as ViewerCandidate[], userId: user.id, username: cleanUsername });
      cacheKey = await discoveryCacheKey(user.id, cleanUsername, `${discoveryContext.cacheIdentity}:${isApifyEnabled}`);
    }

    // Check cache
    const { data: cached, error: cacheError } = await supabaseAdmin
      .from("brand_scrape_cache")
      .select("response_data, expires_at")
      .eq("cache_key", cacheKey)
      .maybeSingle();
    if (platform === "instagram" && cacheError) throw new InstagramDiscoveryError("DISCOVERY_UNAVAILABLE", "Instagram discovery cache is unavailable.", 503);

    if (cached && new Date(cached.expires_at) > new Date()) {
      const cachedData = cached.response_data as any;
      // Trim cached posts to current maxPosts setting
      const allPosts = (cachedData.posts || []).slice(0, maxPosts);

      await logger.info(`Cache hit for ${platform}:${cleanUsername} (trimmed to ${allPosts.length}/${maxPosts})`, {
        platform,
        username: cleanUsername,
        posts_count: allPosts.length,
        max_posts_setting: maxPosts,
        strategy: "cache",
      }, userId);

      // Save to history on cache hits too
      try {
        const { error: historyError } = await supabaseAdmin.from("brand_scrape_sessions").insert({
          user_id: user.id,
          platform,
          username: cleanUsername,
          profile_data: cachedData.profile,
          posts_data: allPosts,
          total_posts_fetched: allPosts.length,
          strategy_used: "cache",
          api_endpoint: "brand_scrape_cache",
          scraped_at: new Date().toISOString(),
        });
        if (platform === "instagram" && historyError) throw new InstagramDiscoveryError("DISCOVERY_UNAVAILABLE", "Instagram discovery history could not be saved.", 503);
      } catch (histErr) {
        if (platform === "instagram") throw histErr;
        console.error("Failed to save cache-hit session:", histErr);
      }

      return new Response(JSON.stringify({
        ...cachedData,
        posts: allPosts.slice(offset, offset + 10),
        totalPosts: allPosts.length,
        hasMore: allPosts.length > offset + 10,
        fromCache: true,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let result: any;
    let strategyUsed = "unknown";
    let apiEndpoint = "";

    // ─── Platform Routing ───

    // ─── Threads ───
    // Threads is now handled exclusively by the dedicated `threads-discovery`
    // edge function (called from the Analyze and Discovery panels via
    // useThreadsLiveDiscovery / ThreadsDiscoveryPanel). The legacy inline
    // Threads branch here — including the hardcoded "pending Meta approval /
    // Apify disabled" message and the Instagram/Apify fallback — has been
    // removed. If `brand-scrape` is ever invoked with platform === "threads"
    // (older clients, n8n, etc.), return a structured pointer to the new
    // function so callers can migrate without seeing stale gating UI.
    if (platform === "threads") {
      await logger.info(`brand-scrape received threads request — redirecting caller to threads-discovery`, {
        platform,
        username: cleanUsername,
        strategy: "deprecated_threads_branch",
      }, userId);

      return new Response(JSON.stringify({
        ok: false,
        reason: "deprecated_endpoint",
        message: "Threads analysis has moved to the live `threads-discovery` edge function. Update the client to call supabase.functions.invoke('threads-discovery', { body: { username } }).",
        profile: null,
        posts: [],
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── Instagram ───
    if (!result && platform === "instagram") {
      const authority = discoveryContext?.authority;
      let reconnectWarning: string | null = null;
      try {
        if (!authority) throw new InstagramDiscoveryError(discoveryContext?.refusalCode ?? "IG_RECONNECT_REQUIRED", "Reconnect Instagram to enable official competitor data.");
        if (authority.source === "official") {
          result = await scrapeInstagramOfficial({ username: cleanUsername, viewerIgUserId: authority.account.platform_user_id,
            accessToken: authority.token, maxPosts, apiVersion: Deno.env.get("FACEBOOK_GRAPH_API_VERSION") });
          apiEndpoint = "graph.facebook.com/business_discovery";
        } else {
          result = await scrapeInstagramOwn({ username: cleanUsername, igUserId: authority.account.platform_user_id, accessToken: authority.token, maxPosts });
          apiEndpoint = "graph.instagram.com/media";
        }
        strategyUsed = authority.source;
      } catch (error) {
        if (!(error instanceof InstagramDiscoveryError)) throw error;
        await logger.warn("Instagram discovery refused official data", { platform, username: cleanUsername, error_code: error.code }, userId);
        if (!isApifyEnabled) throw error;
        const apifyToken = Deno.env.get("APIFY_API_TOKEN");
        if (!apifyToken) throw error;
        const actorId = getActorId("apify_actor_instagram", "apify~instagram-scraper");
        result = await scrapeInstagramApify(cleanUsername, apifyToken, actorId, maxPosts);
        strategyUsed = "apify";
        apiEndpoint = actorId;
        if (error.code === "IG_INSIGHTS_SCOPE_MISSING" || error.code === "IG_RECONNECT_REQUIRED") reconnectWarning = error.code;
      }
      result.source = strategyUsed;
      result.profile.source = strategyUsed;
      if (reconnectWarning) result.warning = { code: reconnectWarning, message: "Reconnect Instagram to enable official competitor data." };

    } else if (platform === "facebook") {
      const fbAppId = Deno.env.get("FACEBOOK_APP_ID");
      const fbAppSecret = Deno.env.get("FACEBOOK_APP_SECRET");
      if (!fbAppId || !fbAppSecret) {
        throw new Error("Facebook app credentials not configured. Contact support.");
      }
      result = await scrapeFacebook(cleanUsername, fbAppId, fbAppSecret, maxPosts);
      strategyUsed = "official";
      apiEndpoint = "graph.facebook.com";
      await logger.info(`Facebook scrape succeeded for ${cleanUsername}`, {
        platform, username: cleanUsername, strategy: "official", posts_count: result.posts.length,
      }, userId);

    } else if (platform === "tiktok") {
      if (!isApifyEnabled) {
        throw new Error("TikTok scraping requires Apify which is currently disabled by admin. Please ask an admin to enable Apify in settings.");
      }
      const apifyToken = Deno.env.get("APIFY_API_TOKEN");
      if (!apifyToken) {
        throw new Error("TikTok scraping requires APIFY_API_TOKEN. Contact support.");
      }
      const actorId = getActorId("apify_actor_tiktok", "clockworks~free-tiktok-scraper");
      result = await scrapeTikTok(cleanUsername, apifyToken, actorId, maxPosts);
      strategyUsed = "apify";
      apiEndpoint = actorId;
      await logger.info(`TikTok scrape succeeded for ${cleanUsername}`, {
        platform, username: cleanUsername, strategy: "apify", actor_id: actorId, posts_count: result.posts.length,
      }, userId);

    } else {
      throw new Error(`Platform '${platform}' is not supported`);
    }

    // Sort by engagement
    result.posts.sort((a: { id: string; engagementScore: number | null }, b: { id: string; engagementScore: number | null }) =>
      a.engagementScore === null ? (b.engagementScore === null ? a.id.localeCompare(b.id) : 1) :
      b.engagementScore === null ? -1 : b.engagementScore - a.engagementScore || a.id.localeCompare(b.id));
    result.posts = result.posts.slice(0, maxPosts);

    // Cache
    const { data: ttlSetting } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", "brand_scrape_cache_ttl_minutes")
      .single();

    let ttlMinutes = 60;
    try {
      if (ttlSetting?.value) {
        const parsed = typeof ttlSetting.value === "string" ? JSON.parse(ttlSetting.value) : ttlSetting.value;
        ttlMinutes = Number(parsed) || 60;
      }
    } catch { /* optional enrichment; scraping continues without it */ }

    const { error: cacheWriteError } = await supabaseAdmin.from("brand_scrape_cache").upsert({
      cache_key: cacheKey,
      platform,
      username: cleanUsername,
      response_data: result,
      expires_at: new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString(),
    }, { onConflict: "cache_key" });

    if (platform === "instagram" && cacheWriteError) throw new InstagramDiscoveryError("DISCOVERY_UNAVAILABLE", "Instagram discovery could not be saved.", 503);

    // Log session with actual strategy used
    const { error: historyWriteError } = await supabaseAdmin.from("brand_scrape_sessions").insert({
      user_id: user.id,
      platform,
      username: cleanUsername,
      profile_data: result.profile,
      posts_data: result.posts,
      total_posts_fetched: result.posts.length,
      strategy_used: strategyUsed,
      api_endpoint: apiEndpoint,
      scraped_at: new Date().toISOString(),
    });

    if (platform === "instagram" && historyWriteError) throw new InstagramDiscoveryError("DISCOVERY_UNAVAILABLE", "Instagram discovery history could not be saved.", 503);

    // Log final success
    await logger.info(`Scrape completed for ${platform}:${cleanUsername}`, {
      platform,
      username: cleanUsername,
      posts_count: result.posts.length,
      cache_ttl_minutes: ttlMinutes,
    }, userId);

    return new Response(JSON.stringify({
      ...result,
      posts: result.posts.slice(offset, offset + 10),
      totalPosts: result.posts.length,
      hasMore: result.posts.length > offset + 10,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error("Unknown error");
    const discoveryFailure = error instanceof InstagramDiscoveryError ? error :
      platform === "instagram" ? new InstagramDiscoveryError("DISCOVERY_UNAVAILABLE", "Instagram discovery is unavailable.", error instanceof CredentialStoreError ? 503 : 502) : null;
    const errorMessage = discoveryFailure?.message ?? err.message ?? "Unknown error";
    const errorStack = platform === "instagram" ? "" : err.stack || "";

    // Log detailed error to system_logs with actor_id if applicable
    const actorSettings2 = await supabaseAdmin
      .from("app_settings").select("key, value")
      .in("key", ["apify_actor_instagram", "apify_actor_tiktok"]);
    const relevantActorKey = platform === "tiktok" ? "apify_actor_tiktok" : "apify_actor_instagram";
    const actorSetting = (actorSettings2?.data || []).find((s: any) => s.key === relevantActorKey);
    let failedActorId: string | undefined;
    try {
      if (actorSetting?.value) {
        const p = typeof actorSetting.value === "string" ? JSON.parse(actorSetting.value) : actorSetting.value;
        failedActorId = String(p).replace("/", "~");
      }
    } catch { /* optional enrichment; scraping continues without it */ }

    await logger.error(`Scrape failed for ${platform}:${cleanUsername}`, {
      platform,
      username: cleanUsername,
      error_message: errorMessage,
      error_stack: errorStack,
      raw_details: {
        name: err.name,
        message: errorMessage,
        stack: errorStack,
        actor_id: failedActorId || undefined,
      },
    }, userId);

    return new Response(JSON.stringify({ error: errorMessage, ...(discoveryFailure ? { error_code: discoveryFailure.code } : {}) }), {
      status: discoveryFailure?.status ?? 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
