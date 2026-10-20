import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { deleteComment, hideComment, replyToComment } from "../_shared/commentActions.ts";
import { isDirectInstagramAccount } from "../_shared/messengerCredentials.ts";
import {
  defaultYouTubeDeps,
  listChannelVideos,
  listThreads,
  videoTitles,
} from "../_shared/youtubeComments.ts";
import {
  errorTypeFor,
  groupThreadsByVideo,
} from "./youtubeCommentsView.ts";
import { serviceRoleCallerUserId } from "../_shared/auth-helper.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// n8n-api reads comments for an API-key user with the service role. Only these
// read actions accept that caller; replying, hiding and deleting stay on the
// user-JWT path (n8n-api has its own comment write routes).
const SERVICE_ROLE_ACTIONS = new Set(["get_page_comments", "get_ig_comments", "get_youtube_comments"]);

const GRAPH_API_VERSION = "v22.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const INSTAGRAM_GRAPH_API_BASE = `https://graph.instagram.com/${GRAPH_API_VERSION}`;

async function graphJson(url: string) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({ error: { message: res.statusText } }));
  if (!res.ok || data?.error) {
    const err = data?.error || {};
    if (err.code === 190) {
      return { error_type: "TOKEN_EXPIRED", error: "Instagram connection expired. Please reconnect your account." };
    }
    if (err.code === 10 || err.code === 200 || /permission|permissions|scope/i.test(err.message || "")) {
      return { error_type: "MISSING_SCOPE", error: err.message || "Missing Instagram comments permission." };
    }
    return { error_type: "GRAPH_ERROR", error: err.message || "Meta API request failed." };
  }
  return data;
}

async function collectPaged(firstUrl: string, maxPages = 4) {
  const rows: unknown[] = [];
  let nextUrl: string | null = firstUrl;
  let paging: unknown = null;

  for (let page = 0; nextUrl && page < maxPages; page += 1) {
    const data = await graphJson(nextUrl);
    if (data?.error_type) return data;
    if (Array.isArray(data?.data)) rows.push(...data.data);
    paging = data?.paging || null;
    nextUrl = data?.paging?.next || null;
  }

  return { data: rows, paging };
}

// Best-effort commenter avatars for Instagram: Meta gives businesses no direct
// way to get a commenter's photo (IG comments carry no picture field, and the
// profile-lookup API only unlocks for users who have messaged the business, not
// merely commented — confirmed against Meta's docs). If a commenter has also
// DM'd this account, messaging-api will already have cached their avatar in
// messaging_cache, so we reuse it for free instead of guessing at a live call
// that would fail for almost everyone.
function collectCommenterIds(mediaList: any[]): string[] {
  const ids = new Set<string>();
  for (const media of mediaList) {
    for (const comment of media?.comments?.data || []) {
      if (comment?.from?.id) ids.add(comment.from.id);
      for (const reply of comment?.replies?.data || []) {
        if (reply?.from?.id) ids.add(reply.from.id);
      }
    }
  }
  return Array.from(ids);
}

async function fetchDmOverlapAvatars(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  userId: string,
  commenterIds: string[]
): Promise<Map<string, string>> {
  const { data: cached } = await supabase
    .from("messaging_cache")
    .select("participant_id, participant_avatar")
    .eq("user_id", userId)
    .in("participant_id", commenterIds);

  return new Map(
    (cached || [])
      .filter((row: any) => row.participant_avatar)
      .map((row: any) => [row.participant_id as string, row.participant_avatar as string])
  );
}

function applyCommenterAvatars(mediaList: any[], avatarByParticipant: Map<string, string>): void {
  for (const media of mediaList) {
    for (const comment of media?.comments?.data || []) {
      comment.author_avatar = avatarByParticipant.get(comment?.from?.id) || null;
      for (const reply of comment?.replies?.data || []) {
        reply.author_avatar = avatarByParticipant.get(reply?.from?.id) || null;
      }
    }
  }
}

function json400(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Verify auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    let serviceUserId: string | null;
    try {
      serviceUserId = await serviceRoleCallerUserId(req);
    } catch {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    let user: { id: string };
    if (serviceUserId) {
      user = { id: serviceUserId };
    } else {
      const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !authUser) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      user = authUser;
    }

    const body = await req.json();
    const { action, social_account_id, comment_id, message, page_id, ig_user_id } = body;

    if (serviceUserId && !SERVICE_ROLE_ACTIONS.has(action)) {
      return new Response(JSON.stringify({ error: "This action is not available to service-role callers" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get access token for the social account
    let accessToken: string | null = null;
    let socialAccount: {
      id: string;
      user_id: string;
      access_token: string | null;
      refresh_token?: string | null;
      token_expires_at?: string | null;
      platform: string;
      platform_user_id?: string | null;
      auth_provider?: string | null;
      connection_id?: string | null;
      workspace_id?: string | null;
      ig_auth_type?: string | null;
      account_metadata?: Record<string, unknown> | null;
    } | null = null;
    if (social_account_id) {
      const { data: account } = await supabase
        .from("social_accounts")
        .select("id, user_id, access_token, refresh_token, token_expires_at, platform, platform_user_id, auth_provider, connection_id, workspace_id, ig_auth_type, account_metadata")
        .eq("id", social_account_id)
        .eq("user_id", user.id)
        .single();

      if (!account || (account.auth_provider !== "composio" && !account.access_token)) {
        return new Response(JSON.stringify({ error: "Social account not found or no access token" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      socialAccount = account;
      accessToken = account.access_token;
    }

    let result: unknown;

    switch (action) {
      case "get_page_comments": {
        if (!page_id || !accessToken) {
          return new Response(JSON.stringify({ error: "page_id and social_account_id required" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        // `.filter(stream)` is what makes replies visible at all. The comments edge
        // defaults to `toplevel`, which returns only root comments -- `parent` was
        // already being requested and always came back empty, so the reply a customer
        // wrote under their own thread never reached the client. `stream` returns the
        // whole tree flat, each reply carrying the `parent` the client nests by.
        const commentFields =
          "comments.filter(stream){id,from{id,name,picture},message,created_time,is_hidden,comment_count,parent}";
        const url = `${GRAPH_API_BASE}/${page_id}/feed?fields=${
          encodeURIComponent(`id,message,created_time,${commentFields}`)
        }&limit=25&access_token=${accessToken}`;
        const res = await fetch(url);
        result = await res.json();
        break;
      }

      case "get_ig_comments": {
        if (!ig_user_id || !accessToken) {
          return new Response(JSON.stringify({ error: "ig_user_id and social_account_id required" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        // Request like_count + comments_count on each media, plus replies under
        // each comment. Higher `limit` so active accounts surface more history.
        const apiBase = socialAccount && isDirectInstagramAccount(socialAccount)
          ? INSTAGRAM_GRAPH_API_BASE
          : GRAPH_API_BASE;
        const fields = [
          "id",
          "caption",
          "media_type",
          "permalink",
          "timestamp",
          "like_count",
          "comments_count",
          "comments.limit(50){id,from{id,username},text,timestamp,hidden,username,like_count,replies{id,from{id,username},text,timestamp,hidden,username,like_count}}",
        ].join(",");
        const url = `${apiBase}/${ig_user_id}/media?fields=${encodeURIComponent(fields)}&limit=50&access_token=${encodeURIComponent(accessToken)}`;
        const raw = await collectPaged(url, 4);
        // If the whole call failed, return the error as-is so the client can map it.
        if (raw?.error || raw?.error_type) {
          result = raw;
          break;
        }
        // Defensively normalize: never drop a media entry just because its
        // comments edge errored (Meta sometimes returns partial errors).
        if (Array.isArray(raw?.data)) {
          for (const media of raw.data) {
            if (media && media.comments && (media.comments as { error?: unknown }).error) {
              media.comments = { data: [] };
            }
          }
          const commenterIds = collectCommenterIds(raw.data);
          if (commenterIds.length > 0) {
            const avatarByParticipant = await fetchDmOverlapAvatars(supabase, user.id, commenterIds);
            if (avatarByParticipant.size > 0) applyCommenterAvatars(raw.data, avatarByParticipant);
          }
        }
        result = raw;
        break;
      }

      case "get_youtube_comments": {
        if (!socialAccount || socialAccount.platform !== "youtube") {
          return json400("a youtube social_account_id is required");
        }
        const deps = defaultYouTubeDeps();
        const threads = await listThreads(socialAccount, deps, {
          channelId: socialAccount.platform_user_id!,
          pageToken: body.page_token || undefined,
        });
        if (!threads.ok) {
          result = {
            error_type: errorTypeFor(threads.kind),
            error: threads.message,
          };
          break;
        }
        const titles = await videoTitles(
          socialAccount,
          deps,
          [...new Set(threads.value.items.map((thread) => thread.videoId))],
        );
        result = {
          videos: groupThreadsByVideo(
            threads.value.items,
            titles.ok ? titles.value : new Map(),
            socialAccount.platform_user_id ?? null,
          ),
          next_page_token: threads.value.nextPageToken,
        };
        break;
      }

      case "get_youtube_videos": {
        if (!socialAccount || socialAccount.platform !== "youtube") {
          return json400("a youtube social_account_id is required");
        }
        const videos = await listChannelVideos(
          socialAccount,
          defaultYouTubeDeps(),
          socialAccount.platform_user_id!,
        );
        result = videos.ok
          ? {
            videos: videos.value.map((video) => ({
              id: video.id,
              title: video.title,
              published_at: video.publishedAt,
            })),
          }
          : {
            error_type: errorTypeFor(videos.kind),
            error: videos.message,
          };
        break;
      }

      case "reply_comment": {
        if (!comment_id || !message || !socialAccount) {
          return new Response(JSON.stringify({ error: "comment_id, message, and social_account_id required" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const replyResult = await replyToComment(socialAccount!, comment_id, message);
        // Shared module returns { success, platform_comment_id?, error? }; the
        // client still expects the raw Graph JSON shape ({ id } on success,
        // Graph-style { error } on failure), so adapt before responding.
        result = replyResult.success
          ? { id: replyResult.platform_comment_id }
          : { error: { message: replyResult.error } };
        break;
      }

      case "hide_comment": {
        if (!comment_id || !socialAccount) {
          return new Response(JSON.stringify({ error: "comment_id and social_account_id required" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const hideResult = await hideComment(socialAccount!, comment_id, body.is_hidden !== undefined ? body.is_hidden : true);
        result = hideResult.success ? { success: true } : { error: { message: hideResult.error } };
        break;
      }

      case "delete_comment": {
        if (!comment_id || !socialAccount) {
          return new Response(JSON.stringify({ error: "comment_id and social_account_id required" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const deleteResult = await deleteComment(socialAccount!, comment_id);
        result = deleteResult.success ? { success: true } : { error: { message: deleteResult.error } };
        break;
      }

      default:
        return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Comment manager error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
