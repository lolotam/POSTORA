import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
}

// Allow-list of webhook event types we actually act on. Unknown events are
// silently 200'd (so TikTok stops retrying) but never branched on.
const ALLOWED_EVENT_TYPES = new Set<string>([
  "authorize",
  "deauthorize",
  "video.publish.complete",
  "post.publish.complete",
  "video.publish.failed",
  "post.publish.failed",
]);

// Safe `publish_id` shape — alphanumeric + a few separators, bounded length.
// TikTok publish IDs are large opaque tokens; tightening this prevents an
// attacker from smuggling SQL/URL fragments through the field.
const PUBLISH_ID_PATTERN = /^[A-Za-z0-9_\-:.]{1,128}$/;

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const method = req.method;
    const url = new URL(req.url);

    // Handle GET request for webhook verification
    if (method === 'GET') {
      const challenge = url.searchParams.get('challenge');
      if (challenge) {
        // P1-6: do not log the challenge value (treated as opaque secret material).
        return new Response(challenge, {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
        });
      }
      return new Response('OK', {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
      });
    }

    // Handle POST request for webhook events
    if (method === 'POST') {
      // P1-6 (interim): TikTok does not publish a single, stable, documented
      // HMAC signature format that covers all webhook product surfaces today.
      // Until the exact algorithm + secret format is confirmed against
      // TikTok developer docs for our specific product subscription, we
      // continue to require a static shared bearer (TIKTOK_WEBHOOK_SECRET)
      // configured in the TikTok developer console. We harden this further by:
      //   1) Reading the body as raw text (so a future HMAC pass can verify it).
      //   2) Failing closed if TIKTOK_WEBHOOK_SECRET is unset.
      //   3) Using a constant-time compare on the bearer.
      //   4) Validating the event type against an explicit allow-list.
      //   5) Restricting publish_id to a safe character pattern.
      //   6) Refusing to log webhook payload contents.
      // TODO(server): once TikTok's webhook signature scheme is confirmed
      // for the active product, replace the static bearer with HMAC verification
      // using the canonical secret. The raw-body read below is already in place.
      const webhookSecret = Deno.env.get('TIKTOK_WEBHOOK_SECRET');
      const authorization = req.headers.get('Authorization') ?? '';

      if (!webhookSecret) {
        // Fail closed: never accept the request when no shared secret is configured.
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (!constantTimeEqual(authorization, webhookSecret)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const rawBody = await req.text();

      // Defensive payload size cap — TikTok webhooks are tiny JSON blobs.
      if (rawBody.length > 64 * 1024) {
        return new Response(JSON.stringify({ error: 'Payload too large' }), {
          status: 413,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      let body: any;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const supabase = createClient(supabaseUrl, supabaseServiceKey);

      const eventType = typeof body?.event === 'string' ? body.event : '';

      // Silently accept (200) but do not act on unknown event types.
      if (!ALLOWED_EVENT_TYPES.has(eventType)) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // P1-6: never log full webhook payloads — they can carry user identifiers.
      console.log(`TikTok webhook event received: ${eventType}`);

      const publishIdRaw = typeof body?.publish_id === 'string' ? body.publish_id : '';
      const publishId = PUBLISH_ID_PATTERN.test(publishIdRaw) ? publishIdRaw : '';

      switch (eventType) {
        case 'authorize':
        case 'deauthorize':
          break;

        case 'video.publish.complete':
        case 'post.publish.complete':
          if (publishId) {
            await updatePlatformPostStatus(supabase, publishId, 'success', null, body);
          }
          break;

        case 'video.publish.failed':
        case 'post.publish.failed': {
          const failReason = body.fail_reason || body.error?.message || body.error_code || 'Unknown failure';
          if (publishId) {
            await updatePlatformPostStatus(supabase, publishId, 'failed', String(failReason), body);
          }
          break;
        }
      }

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response('Method not allowed', {
      status: 405,
      headers: corsHeaders,
    });

  } catch (error) {
    // P1-6: never echo the raw error to the client — it may quote part of the request.
    console.error('TikTok webhook error:', error instanceof Error ? error.message : 'unknown');
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// Helper function to update platform_posts based on TikTok publish_id
async function updatePlatformPostStatus(
  supabase: any,
  publishId: string,
  status: 'success' | 'failed',
  errorMessage: string | null,
  webhookData: any
) {
  try {
    // Find platform_post with this publish_id in response_data
    const { data: platformPosts, error: findError } = await supabase
      .from('platform_posts')
      .select('id, post_id, response_data')
      .eq('platform', 'tiktok')
      .or(`response_data->>tiktok_publish_id.eq.${publishId},response_data->>publish_id.eq.${publishId}`);

    if (findError) {
      console.error('Error finding platform_post:', findError);
      return;
    }

    if (!platformPosts || platformPosts.length === 0) {
      console.log('No platform_post found for publish_id:', publishId);
      return;
    }

    for (const platformPost of platformPosts) {
      console.log(`Updating platform_post ${platformPost.id} to status: ${status}`);
      
      const updateData: any = {
        status,
        posted_at: status === 'success' ? new Date().toISOString() : null,
        response_data: {
          ...platformPost.response_data,
          webhook_event: webhookData,
          final_status: status,
          updated_at: new Date().toISOString(),
        },
      };

      if (errorMessage) {
        updateData.error_message = errorMessage;
      }

      // If success and we have video_id, set the post URL
      if (status === 'success' && webhookData.video_id) {
        updateData.platform_post_id = webhookData.video_id;
        // We don't have username here, so URL will be built in frontend
      }

      const { error: updateError } = await supabase
        .from('platform_posts')
        .update(updateData)
        .eq('id', platformPost.id);

      if (updateError) {
        console.error('Error updating platform_post:', updateError);
        continue;
      }

      // Also update the parent post status
      await updateParentPostStatus(supabase, platformPost.post_id);
    }
  } catch (error) {
    console.error('Error in updatePlatformPostStatus:', error);
  }
}

// Update parent post status based on all platform_posts
async function updateParentPostStatus(supabase: any, postId: string) {
  try {
    const { data: allResults, error } = await supabase
      .from('platform_posts')
      .select('status')
      .eq('post_id', postId);

    if (error || !allResults) return;

    const statuses = allResults.map((r: any) => r.status);
    let newStatus = 'pending';

    if (statuses.every((s: string) => s === 'success')) {
      newStatus = 'completed';
    } else if (statuses.some((s: string) => s === 'failed')) {
      newStatus = 'failed';
    } else if (statuses.some((s: string) => s === 'success')) {
      newStatus = 'completed'; // Partial success
    }

    await supabase
      .from('posts')
      .update({ status: newStatus })
      .eq('id', postId);

  } catch (error) {
    console.error('Error updating parent post status:', error);
  }
}
