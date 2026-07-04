import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const GRAPH_API_VERSION = "v22.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const INSTAGRAM_GRAPH_API_BASE = `https://graph.instagram.com/${GRAPH_API_VERSION}`;

function isDirectInstagramAccount(account: { platform?: string; ig_auth_type?: string | null; account_metadata?: Record<string, unknown> | null }) {
  const meta = account.account_metadata || {};
  return account.platform === "instagram" && (
    account.ig_auth_type === "business_login" ||
    meta.flow === "direct" ||
    meta.source === "instagram_business_login" ||
    meta.token_type === "long_lived"
  );
}

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
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { action, social_account_id, comment_id, message, page_id, ig_user_id } = body;

    // Get access token for the social account
    let accessToken: string | null = null;
    let socialAccount: { access_token: string; platform: string; ig_auth_type?: string | null; account_metadata?: Record<string, unknown> | null } | null = null;
    if (social_account_id) {
      const { data: account } = await supabase
        .from("social_accounts")
        .select("access_token, platform, ig_auth_type, account_metadata")
        .eq("id", social_account_id)
        .eq("user_id", user.id)
        .single();

      if (!account?.access_token) {
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
        const url = `${GRAPH_API_BASE}/${page_id}/feed?fields=id,message,created_time,comments{id,from{id,name,picture},message,created_time,is_hidden,comment_count,parent}&limit=25&access_token=${accessToken}`;
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
        }
        result = raw;
        break;
      }

      case "reply_comment": {
        if (!comment_id || !message || !accessToken) {
          return new Response(JSON.stringify({ error: "comment_id, message, and social_account_id required" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const apiBase = socialAccount && isDirectInstagramAccount(socialAccount)
          ? INSTAGRAM_GRAPH_API_BASE
          : GRAPH_API_BASE;
        const url = `${apiBase}/${comment_id}/replies`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, access_token: accessToken }),
        });
        result = await res.json();
        break;
      }

      case "hide_comment": {
        if (!comment_id || !accessToken) {
          return new Response(JSON.stringify({ error: "comment_id and social_account_id required" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const isHidden = body.is_hidden !== undefined ? body.is_hidden : true;
        const apiBase = socialAccount && isDirectInstagramAccount(socialAccount)
          ? INSTAGRAM_GRAPH_API_BASE
          : GRAPH_API_BASE;
        const url = `${apiBase}/${comment_id}?is_hidden=${isHidden}&access_token=${encodeURIComponent(accessToken)}`;
        const res = await fetch(url, { method: "POST" });
        result = await res.json();
        break;
      }

      case "delete_comment": {
        if (!comment_id || !accessToken) {
          return new Response(JSON.stringify({ error: "comment_id and social_account_id required" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const apiBase = socialAccount && isDirectInstagramAccount(socialAccount)
          ? INSTAGRAM_GRAPH_API_BASE
          : GRAPH_API_BASE;
        const url = `${apiBase}/${comment_id}?access_token=${encodeURIComponent(accessToken)}`;
        const res = await fetch(url, { method: "DELETE" });
        result = await res.json();
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
