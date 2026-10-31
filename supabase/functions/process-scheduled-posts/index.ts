import { verifyCronAuth } from "../_shared/cron-auth.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

import {
  SocialAccount,
  refreshFacebookToken,
  refreshInstagramBusinessToken,
  refreshTikTokToken,
  refreshYouTubeToken,
  refreshPinterestToken
} from '../_shared/social-auth.ts';
import { metaRefreshStrategy } from '../_shared/refreshEligibility.ts';

/** The lease row this function holds while it runs; see migration 20261031100000. */
const LEASE_JOB = 'process-scheduled-posts';
/**
 * Longer than one edge worker can live (150 s, see process-post/deferredPublish.ts), so a run
 * never outlives its lease, and a run that dies without releasing blocks the next for at most this.
 */
const LEASE_TTL = '3 minutes';

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

  const __cronAuth = verifyCronAuth(req);
  if (!__cronAuth.ok) return __cronAuth.response;

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  // One run at a time: a run with several posts outlives the next minute's tick, and two
  // overlapping runs refresh the same tokens and call process-post for the same posts.
  // Fail open when the lease cannot be read: the status-guarded claim in process-post
  // still stops a double publish, and a scheduler that never runs would publish nothing.
  const leaseHolder = crypto.randomUUID();
  let holdsLease = false;
  try {
    const { data: acquired, error: leaseError } = await supabaseAdmin.rpc('acquire_cron_run_lease', {
      p_job: LEASE_JOB,
      p_holder: leaseHolder,
      p_ttl: LEASE_TTL,
    });
    if (leaseError) {
      console.error('Scheduler lease unavailable, running without it:', leaseError.message);
      await supabaseAdmin.from('system_logs').insert({
        level: 'warn',
        category: 'system',
        source: 'process-scheduled-posts',
        message: 'Scheduler lease unavailable; running without it',
        metadata: { error: leaseError.message },
      });
    } else if (acquired !== true) {
      console.log('Another scheduler run holds the lease; skipping this tick');
      await supabaseAdmin.from('system_logs').insert({
        level: 'info',
        category: 'post',
        source: 'process-scheduled-posts',
        message: 'Scheduler tick skipped: a previous run is still active',
        metadata: { event: 'run_skipped_lease_held' },
      });
      return new Response(
        JSON.stringify({ message: 'Previous run still active', processed: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } else {
      holdsLease = true;
    }
  } catch (leaseErr: unknown) {
    console.error('Scheduler lease check threw, running without it:', leaseErr instanceof Error ? leaseErr.message : String(leaseErr));
  }

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
                    case 'instagram': {
                      // Route by ig_auth_type, exactly as refresh-tokens does. This file
                      // used to send every Instagram account to the Facebook exchange —
                      // the same defect PR #66 fixed on the other path but never here, so
                      // Business Login accounts hit the wrong endpoint.
                      // The Meta adapters return a discriminated outcome; adapt back to
                      // the nullable shape at this boundary so the surrounding
                      // `if (refreshResult)` block (and the non-Meta adapters below)
                      // keep working unchanged. A failed refresh MUST land here as null:
                      // {ok:false} is truthy, and writing its undefined access_token
                      // over a working credential would destroy it right before publish.
                      const outcome = metaRefreshStrategy(account) === 'ig_refresh'
                        ? await refreshInstagramBusinessToken(account)
                        : await refreshFacebookToken(account);
                      refreshResult = outcome.ok
                        ? { access_token: outcome.access_token, expires_in: outcome.expires_in }
                        : null;
                      break;
                    }
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
            // The scheduled_at THIS run selected. process-post claims the row
            // only if it still carries it, so an unschedule or reschedule that
            // landed after the SELECT above -- from /v1 or the UI -- is honoured
            // instead of published over. See _shared/postProcessingClaim.ts.
            body: JSON.stringify({ post_id: post.id, expected_scheduled_at: post.scheduled_at })
          }
        );

        const processResult = await processResponse.json();

        if (processResponse.status === 409) {
          // Not a failure: the schedule changed under us, or an overlapping
          // scheduler run claimed the post first, and process-post declined.
          // The row keeps whatever the other write gave it.
          console.log(`Post ${post.id} skipped: rescheduled or already claimed by another run`, processResult);
          results.push({ postId: post.id, status: 'skipped', result: processResult });
          continue;
        }

        console.log(`Post ${post.id} processed:`, processResult);

        results.push({
          postId: post.id,
          status: 'processed',
          result: processResult
        });

      } catch (postError: unknown) {
        console.error(`Error processing post ${post.id}:`, postError);

        const errorMsg = postError instanceof Error ? postError.message : 'Unknown error';

        // Mark the post failed only while nobody holds it: still due at the scheduled_at this
        // run selected and still claimable. If process-post claimed it before the call failed
        // (a dropped connection while it publishes), it is `processing` and process-post or the
        // stale-processing sweeper settles it; a `completed` row must never become `failed`.
        const { data: markedFailed, error: markError } = await supabaseAdmin
          .from('posts')
          .update({ status: 'failed' })
          .eq('id', post.id)
          .eq('scheduled_at', post.scheduled_at)
          .in('status', ['pending', 'scheduled'])
          .select('id');
        if (markError) console.error(`Could not mark post ${post.id} failed:`, markError.message);
        const leftForOwner = !markError && (markedFailed ?? []).length === 0;

        // Log: per-post failure
        await supabaseAdmin.from('system_logs').insert({
          level: leftForOwner ? 'warn' : 'error',
          category: 'post',
          source: 'process-scheduled-posts',
          message: leftForOwner
            ? `Scheduler call failed; post left as is because it is no longer claimable: ${errorMsg}`
            : `Scheduled post failed: ${errorMsg}`,
          user_id: post.user_id,
          metadata: {
            post_id: post.id,
            platforms: post.platforms,
            error: errorMsg,
            marked_failed: !leftForOwner && !markError,
          },
        });

        results.push({
          postId: post.id,
          status: leftForOwner ? 'skipped' : 'failed',
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
  } finally {
    if (holdsLease) {
      // Best effort: a lease that is not released expires after LEASE_TTL.
      try {
        const { error: releaseError } = await supabaseAdmin.rpc('release_cron_run_lease', {
          p_job: LEASE_JOB,
          p_holder: leaseHolder,
        });
        if (releaseError) console.error('Scheduler lease release failed:', releaseError.message);
      } catch (releaseErr: unknown) {
        console.error('Scheduler lease release threw:', releaseErr instanceof Error ? releaseErr.message : String(releaseErr));
      }
    }
  }
});
