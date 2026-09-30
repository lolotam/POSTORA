import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TIKTOK_ERROR_MESSAGES: Record<string, string> = {
  unaudited_client_can_only_post_to_private_accounts: "Your TikTok app is in sandbox mode. Please set privacy to \"Only me\" (SELF_ONLY).",
  token_not_authorized_for_scope: "Missing permissions — please reconnect your TikTok account.",
  invalid_file_upload: "The video file is invalid or corrupted. Please try a different file.",
  rate_limit_exceeded: "Too many requests — please try again in a few minutes.",
  spam_risk_too_many_posts: "TikTok has flagged a posting limit — please wait and retry later.",
  invalid_params: "Invalid parameters sent to TikTok. Please check your settings and try again.",
  access_token_invalid: "Your TikTok session has expired — please reconnect your account.",
  scope_not_authorized: "Your TikTok app doesn't have the required permissions for this action.",
  user_has_no_post_permission: "This TikTok account does not have permission to post.",
};

function getUserMessage(errorCode: string, rawMessage: string): string {
  return TIKTOK_ERROR_MESSAGES[errorCode] || rawMessage || "An unknown TikTok error occurred.";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized", user_message: "You must be logged in." }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authError || !user) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized", user_message: "Session expired — please log in again." }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const body = await req.json();
    const { action, social_account_id } = body;

    if (action === "publish" || action === "schedule") {
      return new Response(JSON.stringify({
        success: false,
        error: "deprecated",
        error_code: "deprecated",
        user_message: "Publishing moved to the TikTok review workspace. Reload the page.",
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { data: account, error: accountError } = await supabase
      .from("social_accounts")
      .select("*")
      .eq("id", social_account_id)
      .eq("user_id", user.id)
      .eq("platform", "tiktok")
      .eq("is_active", true)
      .single();

    if (accountError || !account) {
      return new Response(JSON.stringify({ success: false, error: "TikTok account not found", user_message: "TikTok account not found or not connected. Please reconnect." }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const accessToken = account.access_token;

    if (action === "status") {
      return await handleStatus(body, accessToken, corsHeaders);
    } else {
      return new Response(JSON.stringify({ success: false, error: "Invalid action", user_message: "Invalid action specified." }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  } catch (error) {
    console.error("tiktok-demo-publish error:", error instanceof Error ? error.message : "unknown");
    const message = error instanceof Error ? error.message : "Internal server error";
    return new Response(JSON.stringify({ success: false, error: message, user_message: "Something went wrong. Please try again." }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

async function handleStatus(body: any, accessToken: string, headers: Record<string, string>) {
  const { publish_id } = body;

  if (!publish_id) {
    return new Response(JSON.stringify({ success: false, error: "publish_id is required", user_message: "Please enter a Publish ID." }), { status: 200, headers: { ...headers, "Content-Type": "application/json" } });
  }

  const statusResponse = await fetch("https://open.tiktokapis.com/v2/post/publish/status/fetch/", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({ publish_id }),
  });

  const statusData = await statusResponse.json();
  console.log("TikTok status response:", JSON.stringify(statusData));

  if (statusData.error?.code !== "ok" && statusData.error?.code) {
    const errorCode = statusData.error.code;
    const rawMessage = statusData.error.message || "Failed to fetch status";
    return new Response(JSON.stringify({
      success: false,
      error: rawMessage,
      error_code: errorCode,
      user_message: getUserMessage(errorCode, rawMessage),
    }), { status: 200, headers: { ...headers, "Content-Type": "application/json" } });
  }

  return new Response(JSON.stringify({
    success: true,
    status: statusData.data?.status,
    publicaly_available_post_id: statusData.data?.publicaly_available_post_id,
    fail_reason: statusData.data?.fail_reason,
    uploaded_bytes: statusData.data?.uploaded_bytes,
  }), { status: 200, headers: { ...headers, "Content-Type": "application/json" } });
}
