import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createLogger } from "../_shared/logging.ts";
import { pickBusinessDiscoveryViewer, type ViewerCandidate } from "../_shared/instagramDiscoveryViewer.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function calculateEngagementScore(likes = 0, comments = 0, shares = 0, views = 0): number {
  return Math.round((likes * 1) + (comments * 2) + (shares * 1.5) + (views * 0.1));
}

// ─── Instagram: Official Business Discovery API ───
async function scrapeInstagramOfficial(username: string, viewerIgUserId: string, accessToken: string, maxPosts = 50) {
  const fields = `id,username,name,biography,followers_count,media_count,profile_picture_url,website,media.limit(${maxPosts}){id,media_type,media_url,thumbnail_url,timestamp,like_count,comments_count,video_view_count,permalink,caption}`;
  // Token-in-query is the documented Meta Graph API pattern here; destination hosts
  // are hardcoded constants (no SSRF), so this is an accepted log-exposure tradeoff.
  const url = `https://graph.facebook.com/v22.0/${viewerIgUserId}?fields=business_discovery.fields(${fields})&username=${username}&access_token=${accessToken}`;
  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Instagram API ${res.status}: ${errText}`);
  }
  const data = await res.json();
  if (!data.business_discovery) throw new Error("Not a business/creator profile or username not found");
  const bd = data.business_discovery;
  return {
    profile: {
      id: bd.id,
      username: bd.username,
      fullName: bd.name || bd.username,
      bio: bd.biography || "",
      avatarUrl: bd.profile_picture_url || "",
      followersCount: bd.followers_count || 0,
      followingCount: 0,
      postsCount: bd.media_count || 0,
      isVerified: false,
      website: bd.website || null,
      platform: "instagram",
    },
    posts: (bd.media?.data || []).map((p: any) => ({
      id: p.id,
      mediaType: p.media_type === "VIDEO" ? "REEL" : p.media_type === "CAROUSEL_ALBUM" ? "CAROUSEL" : "IMAGE",
      thumbnailUrl: p.thumbnail_url || p.media_url || "",
      mediaUrl: p.media_url || "",
      caption: p.caption || "",
      likesCount: p.like_count || 0,
      commentsCount: p.comments_count || 0,
      videoViewCount: p.video_view_count || 0,
      sharesCount: 0,
      savesCount: 0,
      engagementScore: calculateEngagementScore(p.like_count, p.comments_count, 0, p.video_view_count),
      timestamp: p.timestamp,
      permalink: p.permalink,
    })),
  };
}

// ─── Instagram: Graph API (Business Login / own account) ───
async function scrapeInstagramGraphAPI(username: string, igUserId: string, accessToken: string, maxPosts = 50) {
  const fields = "id,media_type,media_url,thumbnail_url,timestamp,like_count,comments_count,permalink,caption";
  const url = `https://graph.instagram.com/v22.0/${igUserId}/media?fields=${fields}&limit=${maxPosts}&access_token=${accessToken}`;
  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Instagram Graph API ${res.status}: ${errText}`);
  }
  const data = await res.json();
  if (!data.data?.length) throw new Error("No posts found via Graph API");

  // Fetch profile info
  const profileRes = await fetch(`https://graph.instagram.com/v22.0/${igUserId}?fields=id,username,name,biography,followers_count,follows_count,media_count,profile_picture_url,website&access_token=${accessToken}`);
  const profileData = profileRes.ok ? await profileRes.json() : {};

  return {
    profile: {
      id: profileData.id || igUserId,
      username: profileData.username || username,
      fullName: profileData.name || profileData.username || username,
      bio: profileData.biography || "",
      avatarUrl: profileData.profile_picture_url || "",
      followersCount: profileData.followers_count || 0,
      followingCount: profileData.follows_count || 0,
      postsCount: profileData.media_count || 0,
      isVerified: false,
      website: profileData.website || null,
      platform: "instagram",
    },
    posts: (data.data || []).map((p: any) => ({
      id: p.id,
      mediaType: p.media_type === "VIDEO" ? "REEL" : p.media_type === "CAROUSEL_ALBUM" ? "CAROUSEL" : "IMAGE",
      thumbnailUrl: p.thumbnail_url || p.media_url || "",
      mediaUrl: p.media_url || "",
      caption: p.caption || "",
      likesCount: p.like_count || 0,
      commentsCount: p.comments_count || 0,
      videoViewCount: 0,
      sharesCount: 0,
      savesCount: 0,
      engagementScore: calculateEngagementScore(p.like_count, p.comments_count, 0, 0),
      timestamp: p.timestamp,
      permalink: p.permalink,
    })),
  };
}

// ─── Instagram: Apify fallback ───
async function scrapeInstagramApify(username: string, apifyToken: string, actorId = "apify~instagram-scraper", maxPosts = 50) {
  const url = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${apifyToken}&timeout=60`;
  const res = await fetch(url, {
    method: "POST",
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
    profile: {
      id: p.ownerId || username,
      username,
      fullName: p.ownerFullName || username,
      bio: p.biography || "",
      avatarUrl: p.profilePicUrl || "",
      followersCount: p.followersCount || 0,
      followingCount: p.followingCount || 0,
      postsCount: p.postsCount || 0,
      isVerified: p.verified || false,
      website: p.externalUrl || null,
      platform: "instagram",
    },
    posts: items.map((item: any) => ({
      id: item.id || item.shortCode,
      mediaType: item.type === "Video" ? "REEL" : item.type === "Sidecar" ? "CAROUSEL" : "IMAGE",
      thumbnailUrl: item.displayUrl || "",
      mediaUrl: item.videoUrl || item.displayUrl || "",
      caption: item.caption || "",
      likesCount: item.likesCount || 0,
      commentsCount: item.commentsCount || 0,
      videoViewCount: item.videoViewCount || 0,
      sharesCount: 0,
      savesCount: 0,
      engagementScore: calculateEngagementScore(item.likesCount, item.commentsCount, 0, item.videoViewCount),
      timestamp: item.timestamp,
      permalink: `https://www.instagram.com/p/${item.shortCode}/`,
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
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user } } = await supabaseAdmin.auth.getUser(token);
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    userId = user.id;

    const body = await req.json();
    const { username, offset = 0 } = body;
    platform = body.platform || "instagram";

    if (!username) {
      return new Response(JSON.stringify({ error: "username required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    cleanUsername = username.replace("@", "").toLowerCase().trim();
    const cacheKey = `${platform}:${cleanUsername}`;

    // Log scrape started
    await logger.info(`Scrape started for ${platform}:${cleanUsername}`, {
      platform,
      username: cleanUsername,
      offset,
    }, userId);

    // Read Apify actor endpoints + max posts from app_settings BEFORE cache check
    const { data: actorSettings } = await supabaseAdmin
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
    let isApifyEnabled = true; // default true for backward compat
    try {
      const apifyEnabledSetting = (actorSettings || []).find((s: any) => s.key === "apify_enabled");
      if (apifyEnabledSetting?.value) {
        const parsed = typeof apifyEnabledSetting.value === "string" ? JSON.parse(apifyEnabledSetting.value) : apifyEnabledSetting.value;
        isApifyEnabled = parsed === true || parsed === "true";
      }
    } catch { /* optional enrichment; scraping continues without it */ }

    console.log(`maxPosts setting resolved to: ${maxPosts}, apify_enabled: ${isApifyEnabled}`);

    // Check cache
    const { data: cached } = await supabaseAdmin
      .from("brand_scrape_cache")
      .select("response_data, expires_at")
      .eq("cache_key", cacheKey)
      .single();

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
        await supabaseAdmin.from("brand_scrape_sessions").insert({
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
      } catch (histErr) {
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

    // ─── Instagram (and Threads fallback) ───
    if (!result && (platform === "instagram" || platform === "threads")) {
      // Canonical viewer selection (spec §R0.1) for Business Discovery API
      const { data: userAccounts } = await supabaseAdmin
        .from("social_accounts")
        .select("id, user_id, platform, platform_user_id, access_token, is_active, needs_reauth, ig_auth_type, account_metadata, connected_at")
        .eq("user_id", user.id)
        .eq("platform", "instagram")
        .eq("is_active", true);

      const fbPageAccount = pickBusinessDiscoveryViewer((userAccounts || []) as ViewerCandidate[]);

      if (fbPageAccount?.access_token && fbPageAccount?.platform_user_id) {
        try {
          result = await scrapeInstagramOfficial(cleanUsername, fbPageAccount.platform_user_id, fbPageAccount.access_token, maxPosts);
          strategyUsed = "official";
          apiEndpoint = "graph.facebook.com/business_discovery";
          await logger.info(`Official API succeeded for ${platform}:${cleanUsername}`, {
            platform, username: cleanUsername, strategy: "official", ig_auth_type: "facebook_page", posts_count: result.posts.length,
          }, userId);
        } catch (officialErr) {
          const errMsg = (officialErr as Error).message;
          const isTokenInvalid = errMsg.includes("190") || errMsg.includes("Invalid OAuth") || errMsg.includes("Cannot parse access token");
          await logger.warn(`Official API failed for ${platform}:${cleanUsername}${isTokenInvalid ? " (OAuthException 190)" : ""}`, {
            platform, username: cleanUsername, strategy: "official_failed", error_message: errMsg,
            ig_auth_type: "facebook_page", is_oauth_190: isTokenInvalid,
          }, userId);

          if (!isApifyEnabled) {
            throw new Error("Official Meta API failed and Apify scraping is disabled by admin. Please reconnect your Instagram Business account or ask an admin to enable Apify in settings.");
          }
          const apifyToken = Deno.env.get("APIFY_API_TOKEN");
          if (!apifyToken) {
            throw new Error("Could not fetch profile via Business Discovery. Connect an Instagram Business account or contact support.");
          }
          const actorId = getActorId("apify_actor_instagram", "apify~instagram-scraper");
          result = await scrapeInstagramApify(cleanUsername, apifyToken, actorId, maxPosts);
          strategyUsed = "apify";
          apiEndpoint = actorId;
        }
      } else {
        const { data: bizLoginAccount } = await supabaseAdmin
          .from("social_accounts")
          .select("platform_user_id, access_token, platform_username, ig_auth_type")
          .eq("user_id", user.id)
          .eq("platform", "instagram")
          .eq("is_active", true)
          .eq("ig_auth_type", "business_login")
          .limit(1)
          .single();

        const ownUsername = (bizLoginAccount?.platform_username || "").replace("@", "").toLowerCase().trim();
        const isOwnAccount = bizLoginAccount?.access_token && ownUsername === cleanUsername;

        if (isOwnAccount) {
          try {
            result = await scrapeInstagramGraphAPI(cleanUsername, bizLoginAccount.platform_user_id, bizLoginAccount.access_token, maxPosts);
            strategyUsed = "official";
            apiEndpoint = "graph.instagram.com/media";
          } catch (graphErr) {
            const errMsg = (graphErr as Error).message;
            await logger.warn(`Graph API failed for ${platform}:${cleanUsername}`, {
              platform, username: cleanUsername, strategy: "graph_api_failed", error_message: errMsg,
            }, userId);

            if (!isApifyEnabled) {
              throw new Error("Instagram Graph API failed and Apify scraping is disabled by admin.");
            }
            const apifyToken = Deno.env.get("APIFY_API_TOKEN");
            if (!apifyToken) throw new Error("Could not fetch your profile via Graph API. Contact support.");
            const actorId = getActorId("apify_actor_instagram", "apify~instagram-scraper");
            result = await scrapeInstagramApify(cleanUsername, apifyToken, actorId, maxPosts);
            strategyUsed = "apify";
            apiEndpoint = actorId;
          }
        } else {
          if (!isApifyEnabled) {
            throw new Error("No official API available for this account and Apify scraping is disabled by admin. Please connect an Instagram Business account or ask an admin to enable Apify.");
          }
          const apifyToken = Deno.env.get("APIFY_API_TOKEN");
          if (!apifyToken) {
            throw new Error("Connect an Instagram Business account to use Brand Intelligence, or contact support.");
          }
          const actorId = getActorId("apify_actor_instagram", "apify~instagram-scraper");
          result = await scrapeInstagramApify(cleanUsername, apifyToken, actorId, maxPosts);
          strategyUsed = "apify";
          apiEndpoint = actorId;
        }
      }
      if (platform === "threads") {
        result.profile.platform = "threads";
      }


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
    result.posts.sort((a: any, b: any) => b.engagementScore - a.engagementScore);
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

    await supabaseAdmin.from("brand_scrape_cache").upsert({
      cache_key: cacheKey,
      platform,
      username: cleanUsername,
      response_data: result,
      expires_at: new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString(),
    }, { onConflict: "cache_key" });

    // Log session with actual strategy used
    await supabaseAdmin.from("brand_scrape_sessions").insert({
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
    const err = error as Error;
    const errorMessage = err.message || "Unknown error";
    const errorStack = err.stack || "";

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

    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
