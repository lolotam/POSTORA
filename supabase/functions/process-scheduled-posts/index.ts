import { verifyCronAuth } from "../_shared/cron-auth.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

import {
  SocialAccount,
  refreshFacebookToken,
  refreshTikTokToken,
  refreshYouTubeToken,
  refreshPinterestToken
} from '../_shared/social-auth.ts';

// Returns true if token expires in less than N minutes or is already expired
function isTokenExpiring(expiresAt: string | null, platform?: string): boolean {
  if (!expiresAt) return true;
  const expiry = new Date(expiresAt).getTime();
  const now = new Date().getTime();
  const windowMs = platform === 'youtube' ? 30 * 60 * 1000 : 15 * 60 * 1000;
  return expiry - now < windowMs;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  try {
    console.log('Processing scheduled posts...');

    const now = new Date().toISOString();

    const { data: scheduledPosts, error: fetchError } = await supabaseAdmin
      .from('posts')
      .select('id, user_id, caption, platforms, media_file_ids, scheduled_at, metadata')
      .in('status', ['pending', 'scheduled'])
      .not('scheduled_at', 'is', null)
      .lte('scheduled_at', now);

    if (fetchError) {
      console.error('Error fetching scheduled posts:', fetchError);
      throw fetchError;
    }

    const postCount = scheduledPosts?.length || 0;
    console.log(`Found ${postCount} scheduled posts to process`);

    // Log: scheduler started (only when there are posts to process)
    if (postCount > 0) {
      await supabaseAdmin.from('system_logs').insert({
        level: 'info',
        category: 'post',
        source: 'process-scheduled-posts',
        message: `Scheduler run: found ${postCount} pending scheduled post(s)`,
        metadata: { posts_found: postCount, run_at: now },
      });
    }

    if (!scheduledPosts || scheduledPosts.length === 0) {
      return new Response(
        JSON.stringify({ message: 'No scheduled posts to process', processed: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const results = [];

    for (const post of scheduledPosts) {
      try {
        console.log(`Processing scheduled post: ${post.id}`);

        // Check for expiring tokens before processing
        if (post.platforms && Array.isArray(post.platforms) && post.platforms.length > 0) {
          // Use selected_account_ids from metadata to only refresh relevant accounts
          const selectedAccountIds = post.metadata?.selected_account_ids;
          let accountQuery = supabaseAdmin
            .from('social_accounts')
            .select('*')
            .eq('user_id', post.user_id);

          if (selectedAccountIds && Array.isArray(selectedAccountIds) && selectedAccountIds.length > 0) {
            accountQuery = accountQuery.in('id', selectedAccountIds);
            console.log(`[JIT-SCHEDULED] Filtering token refresh to selected accounts: ${selectedAccountIds.join(', ')} (post: ${post.id})`);
          } else {
            accountQuery = accountQuery.in('platform', post.platforms);
            console.log(`[JIT-SCHEDULED] No selected_account_ids in metadata, falling back to platform filter (post: ${post.id})`);
          }

          const { data: accounts } = await accountQuery;

          if (accounts) {
            for (const account of accounts as SocialAccount[]) {
              if (isTokenExpiring(account.token_expires_at, account.platform)) {
                console.log(`[JIT-SCHEDULED] Token expiring for ${account.platform} (User: ${account.user_id}, post: ${post.id}), refreshing...`);
                let refreshResult = null;

                try {
                  switch (account.platform) {
                    case 'facebook':
                    case 'instagram':
                      refreshResult = await refreshFacebookToken(account);
                      break;
                    case 'tiktok':
                      refreshResult = await refreshTikTokToken(account);
                      break;
                    case 'youtube':
                      refreshResult = await refreshYouTubeToken(account);
                      break;
                    case 'pinterest':
                      refreshResult = await refreshPinterestToken(account);
                      break;
                  }
                } catch (refreshError) {
                  console.warn(`[JIT-SCHEDULED] Token refresh threw error for ${account.platform} (post: ${post.id}), will attempt publish with existing token:`, refreshError.message || refreshError);
                  refreshResult = null;
                }

                if (refreshResult) {
                  const expiresAt = new Date();
                  expiresAt.setSeconds(expiresAt.getSeconds() + refreshResult.expires_in);

                  const updates: any = {
                    access_token: refreshResult.access_token,
                    token_expires_at: expiresAt.toISOString(),
                    updated_at: new Date().toISOString()
                  };

                  if ('refresh_token' in refreshResult && refreshResult.refresh_token) {
                    updates.refresh_token = refreshResult.refresh_token;
                  }

                  await supabaseAdmin
                    .from('social_accounts')
                    .update(updates)
                    .eq('id', account.id);

                  console.log(`[JIT-SCHEDULED] Refreshed token for ${account.platform} (post: ${post.id})`);
                } else {
                  console.error(`[JIT-SCHEDULED] Failed to refresh token for ${account.platform} (post: ${post.id})`);

                  // Log: token refresh failure
                  await supabaseAdmin.from('system_logs').insert({
                    level: 'warn',
                    category: 'token',
                    source: 'process-scheduled-posts',
                    message: `Token refresh failed for ${account.platform} — will attempt publish with existing token`,
                    user_id: post.user_id,
                    metadata: {
                      post_id: post.id,
                      platform: account.platform,
                      account_id: account.id,
                    },
                  });
                }
              }
            }
          }
        }

        // Call the process-post function
        const processResponse = await fetch(
          `${Deno.env.get('SUPABASE_URL')}/functions/v1/process-post`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`
            },
            body: JSON.stringify({ post_id: post.id })
          }
        );

        const processResult = await processResponse.json();
        console.log(`Post ${post.id} processed:`, processResult);

        results.push({
          postId: post.id,
          status: 'processed',
          result: processResult
        });

      } catch (postError: unknown) {
        console.error(`Error processing post ${post.id}:`, postError);

        // Mark the post as failed
        await supabaseAdmin
          .from('posts')
          .update({ status: 'failed' })
          .eq('id', post.id);

        const errorMsg = postError instanceof Error ? postError.message : 'Unknown error';

        // Log: per-post failure
        await supabaseAdmin.from('system_logs').insert({
          level: 'error',
          category: 'post',
          source: 'process-scheduled-posts',
          message: `Scheduled post failed: ${errorMsg}`,
          user_id: post.user_id,
          metadata: {
            post_id: post.id,
            platforms: post.platforms,
            error: errorMsg,
          },
        });

        results.push({
          postId: post.id,
          status: 'failed',
          error: errorMsg
        });
      }
    }

    const successCount = results.filter(r => r.status === 'processed').length;
    const failCount = results.filter(r => r.status === 'failed').length;

    console.log('Scheduled posts processing complete:', results);

    // Log: completion summary
    await supabaseAdmin.from('system_logs').insert({
      level: failCount > 0 ? 'warn' : 'info',
      category: 'post',
      source: 'process-scheduled-posts',
      message: `Scheduler complete: ${successCount} processed, ${failCount} failed out of ${results.length} total`,
      metadata: {
        total: results.length,
        success: successCount,
        failed: failCount,
        post_ids: results.map(r => r.postId),
      },
    });

    return new Response(
      JSON.stringify({
        message: 'Scheduled posts processed',
        processed: results.length,
        results
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    console.error('Error in process-scheduled-posts:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';

    // Log: top-level crash
    await supabaseAdmin.from('system_logs').insert({
      level: 'error',
      category: 'system',
      source: 'process-scheduled-posts',
      message: `Scheduler crashed: ${message}`,
      metadata: { error: message },
    });

    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
