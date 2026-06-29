// ═══════════════════════════════════════════════════════════════════════════
// TikTok Status Check Edge Function
// Polls TikTok's /v2/post/publish/status/fetch/ endpoint
// ═══════════════════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    // Parse body safely. Empty / malformed JSON previously crashed this
    // handler with "Unexpected end of JSON input".
    let publish_id: string | undefined;
    let account_id: string | undefined;
    try {
      const text = await req.text();
      const parsed = text ? JSON.parse(text) : {};
      publish_id = parsed.publish_id;
      account_id = parsed.account_id;
    } catch {
      return new Response(
        JSON.stringify({ success: false, error: "Malformed JSON body", code: "INVALID_JSON" }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!publish_id) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing publish_id", code: "MISSING_PUBLISH_ID" }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[TikTok Status] Checking status for publish_id: ${publish_id}, account_id: ${account_id}`);

    // Get access token from social_accounts if account_id provided
    let accessToken: string | null = null;
    let username: string | null = null;

    if (account_id) {
      const { data: account, error: accountError } = await supabase
        .from('social_accounts')
        .select('access_token, platform_username')
        .eq('id', account_id)
        .eq('platform', 'tiktok')
        .single();

      if (accountError) {
        console.error('[TikTok Status] Error fetching account:', accountError);
      } else if (account) {
        accessToken = account.access_token;
        username = account.platform_username;
      }
    }

    // If no account_id or couldn't get token, try to find by publish_id in platform_posts
    if (!accessToken) {
      const { data: platformPost, error: ppError } = await supabase
        .from('platform_posts')
        .select(`
          social_account_id,
          social_accounts!inner(access_token, platform_username)
        `)
        .or(`response_data->>tiktok_publish_id.eq.${publish_id},response_data->>publish_id.eq.${publish_id}`)
        .eq('platform', 'tiktok')
        .single();

      if (!ppError && platformPost && (platformPost as any).social_accounts) {
        accessToken = (platformPost as any).social_accounts.access_token;
        username = (platformPost as any).social_accounts.platform_username;
      }
    }

    if (!accessToken) {
      console.error('[TikTok Status] No access token found');
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: "No access token found",
          status: "unknown"
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Call TikTok's status API
    const response = await fetch(
      'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify({ publish_id }),
      }
    );

    const responseText = await response.text();
    console.log(`[TikTok Status] API Response: ${responseText}`);

    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      console.error('[TikTok Status] Failed to parse response:', responseText);
      return new Response(
        JSON.stringify({
          success: false,
          error: "Failed to parse TikTok response",
          status: "unknown",
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Handle TikTok API errors
    if (data.error?.code) {
      console.error('[TikTok Status] API Error:', data.error);
      
      // Check if token needs refresh
      if (data.error.code === 'access_token_invalid' || data.error.code === 10002) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "TikTok session expired. Please reconnect your account.",
            status: "FAILED",
            fail_reason: "Access token expired",
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({
          success: false,
          error: data.error.message || "TikTok API error",
          status: "unknown",
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Extract status info
    const statusData = data.data || {};
    const status = statusData.status || "unknown";
    const postId = statusData.publicaly_available_post_id?.[0] || statusData.post_id || null;
    const failReason = statusData.fail_reason || null;

    console.log(`[TikTok Status] Status: ${status}, PostId: ${postId}, FailReason: ${failReason}`);

    // If we have a post ID, update the database
    if (postId && status === "PUBLISH_COMPLETE") {
      const postUrl = username 
        ? `https://www.tiktok.com/@${username.replace('@', '')}/video/${postId}`
        : null;

      // Update platform_posts
      const { error: updateError } = await supabase
        .from('platform_posts')
        .update({
          status: 'success',
          platform_post_id: postId,
          platform_post_url: postUrl,
          posted_at: new Date().toISOString(),
          response_data: {
            status: 'PUBLISH_COMPLETE',
            post_id: postId,
            checked_at: new Date().toISOString(),
          },
        })
        .or(`response_data->>tiktok_publish_id.eq.${publish_id},response_data->>publish_id.eq.${publish_id}`)
        .eq('platform', 'tiktok');

      if (updateError) {
        console.error('[TikTok Status] Error updating platform_posts:', updateError);
      }
    }

    // Handle failure status
    if (status === "FAILED") {
      await supabase
        .from('platform_posts')
        .update({
          status: 'failed',
          error_message: failReason || 'Unknown error',
          response_data: {
            status: 'FAILED',
            fail_reason: failReason,
            checked_at: new Date().toISOString(),
          },
        })
        .or(`response_data->>tiktok_publish_id.eq.${publish_id},response_data->>publish_id.eq.${publish_id}`)
        .eq('platform', 'tiktok');
    }

    return new Response(
      JSON.stringify({
        success: true,
        status,
        post_id: postId,
        fail_reason: failReason,
        username,
        raw_response: data,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[TikTok Status] Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: errorMessage,
        status: "unknown",
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
