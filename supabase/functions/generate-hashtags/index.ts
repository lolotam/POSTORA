import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";
import { corsHeaders, handleCorsOptions, jsonResponse, errorResponse, unauthorizedResponse } from "../_shared/cors.ts";
import { resolveUserAiRoute, composeAiTiers, markUserKeyInvalid } from "../_shared/ai-user-routing.ts";
import { AI_CONNECTION_REQUIRED, AI_USER_KEY_INVALID } from "../_shared/ai-routing-errors.ts";
import { createLogger } from "../_shared/logging.ts";
import { callAiChain, logAiCall, resolveChatModelConfig, platformChatTiers } from "../_shared/ai-fallback.ts";
import { serviceRoleCallerUserId } from "../_shared/auth-helper.ts";

interface SubscriptionCheck {
  allowed: boolean;
  isAdmin: boolean;
  planSlug: string | null;
  reason?: string;
}

// Check if user has AI access based on their subscription (using admin client for reliability)
async function checkAIAccess(supabaseAdmin: any, userId: string): Promise<SubscriptionCheck> {
  // Check if user is admin (admins always have access)
  const { data: role } = await supabaseAdmin
    .from('user_roles')
    .select('role')
    .eq('user_id', userId)
    .eq('role', 'admin')
    .maybeSingle();

  if (role) {
    return { allowed: true, isAdmin: true, planSlug: 'admin' };
  }

  // Check user's active subscription using admin client (bypasses RLS)
  const { data: subscription, error: subError } = await supabaseAdmin
    .from('user_subscriptions')
    .select(`
      id,
      status,
      plan_id,
      subscription_plans!inner (
        slug,
        features
      )
    `)
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();

  console.log('Subscription lookup for user:', userId, 'result:', subscription, 'error:', subError);

  if (subError) {
    console.error('Error checking subscription:', subError);
    return { allowed: false, isAdmin: false, planSlug: null, reason: 'Error checking subscription' };
  }

  if (!subscription) {
    console.log('No active subscription found for user:', userId);
    return { allowed: false, isAdmin: false, planSlug: 'free', reason: 'AI features require a Pro or Business subscription' };
  }

  const planSlug = subscription.subscription_plans?.slug;
  const features = subscription.subscription_plans?.features || [];

  console.log('User plan:', planSlug, 'features:', features);

  // Pro and Business always have access
  if (planSlug === 'pro' || planSlug === 'business') {
    return { allowed: true, isAdmin: false, planSlug };
  }

  // Check if plan has AI features
  const hasAIFeature = Array.isArray(features) && features.some((f: string) => 
    typeof f === 'string' && (
      f.toLowerCase().includes('hashtag suggestion') || 
      f.toLowerCase().includes('ai feature')
    )
  );

  if (!hasAIFeature) {
    return { 
      allowed: false, 
      isAdmin: false, 
      planSlug, 
      reason: 'AI Hashtag Suggestions require a Pro or Business subscription' 
    };
  }

  return { allowed: true, isAdmin: false, planSlug };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return handleCorsOptions();
  }

  try {
    // Manual Auth Verification
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      console.error('Missing Authorization header');
      return unauthorizedResponse('Missing Authorization header');
    }

    const token = authHeader.replace('Bearer ', '');
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    // Create admin client for subscription checks (bypasses RLS)
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    let serviceUserId: string | null;
    try {
      serviceUserId = await serviceRoleCallerUserId(req);
    } catch {
      return unauthorizedResponse();
    }
    let user: { id: string };
    if (serviceUserId) {
      user = { id: serviceUserId };
    } else {
      const { data: { user: authUser }, error: userError } = await supabaseClient.auth.getUser(token);

      if (userError || !authUser) {
        console.error('Auth User Error:', userError);
        return unauthorizedResponse();
      }
      user = authUser;
    }

    console.log('User authenticated:', user.id);

    // Check subscription-based AI access using admin client (bypasses RLS)
    const accessCheck = await checkAIAccess(supabaseAdmin, user.id);
    console.log('AI access check:', accessCheck);

    if (!accessCheck.allowed) {
      return errorResponse(accessCheck.reason || 'AI features require a paid subscription', 403);
    }

    const { caption, platform, model } = await req.json();

    // Resolve chat-model config: user override → admin /admin/settings Chat → hardcoded last-resort
    const route = await resolveUserAiRoute(supabaseAdmin, user.id, 'chat');
    if (route.mode === 'user_only' && !route.userTier) {
      await logAiCall(supabaseAdmin, 'hashtag_generation', 'generate-hashtags', user.id, false, {
        response: new Response(null, { status: 409 }), tierUsed: 'primary', modelUsed: '', providerUsed: '', tiers: [],
      }, { error_code: AI_CONNECTION_REQUIRED });
      return jsonResponse({ error: AI_CONNECTION_REQUIRED, message: 'Connect an AI provider key or change your routing mode.' }, 409);
    }
    const chatCfg = await resolveChatModelConfig(supabaseAdmin, user.id);
    if (model) {
      console.warn('Client-supplied model param ignored — admin Chat config governs hashtag generation. Got:', model);
    }
    console.log('Hashtag chat model config:', chatCfg.source, chatCfg.primaryProvider, chatCfg.primaryModel, 'plan:', accessCheck.planSlug);

    const systemPrompt = `You are a social media expert who suggests relevant, trending hashtags.

Guidelines:
- Suggest 10-15 relevant hashtags
- Mix popular and niche hashtags for better reach
- Ensure hashtags are appropriate for the platform
- Include hashtags that are currently trending when relevant
- Format each hashtag with # prefix
- Return only the hashtags, one per line, no explanations

Platform-specific guidelines:
- Instagram: Mix of popular (1M+ posts) and niche (10K-100K posts) hashtags
- TikTok: Focus on trending and challenge-related hashtags
- Twitter/X: Use 2-3 trending hashtags max, keep it minimal
- Facebook: Use broad, descriptive hashtags
- LinkedIn: Use professional, industry-specific hashtags`;

    const userPrompt = `Generate relevant hashtags for this ${platform || 'social media'} post:

Caption: "${caption}"

Return only the hashtags, one per line.`;

    const requestBody = {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
    };

    // 3-tier AI call with fallback chain
    const aiResult = await callAiChain(supabaseAdmin, requestBody, composeAiTiers(route, platformChatTiers(chatCfg)));
    if (route.reason === 'user_key_missing') aiResult.fallbackReason = route.reason;
    for (const tier of aiResult.tiers) {
      if (tier.credentialSource === 'user' && tier.error === AI_USER_KEY_INVALID && route.fetchedAt) {
        await markUserKeyInvalid(supabaseAdmin, user.id, tier.provider, route.fetchedAt);
      }
    }

    const aiSuccess = aiResult.response.ok;

    // Log AI call to system_logs
    await logAiCall(supabaseAdmin, 'hashtag_generation', 'generate-hashtags', user.id, aiSuccess, aiResult, {
      platform,
    });

    if (aiResult.errorCode === AI_USER_KEY_INVALID) {
      return jsonResponse({ error: AI_USER_KEY_INVALID, message: 'Your saved API key was rejected by the provider. Update it or change your routing mode.' }, 409);
    }
    if (!aiSuccess) {
      const errorText = await aiResult.response.text();
      console.error('All AI tiers failed for hashtag generation:', errorText);
      throw new Error(`AI hashtag generation failed after all fallbacks`);
    }

    const data = await aiResult.response.json();
    const content = data.choices?.[0]?.message?.content || '';
    console.log(`Hashtags generated using ${aiResult.tierUsed} tier (${aiResult.modelUsed})`);

    // Parse hashtags from response
    const hashtags = content
      .split('\n')
      .map((line: string) => line.trim())
      .filter((line: string) => line.startsWith('#'))
      .slice(0, 15);

    console.log('Generated hashtags:', hashtags.length);

    // Log successful hashtag generation
    const logger = createLogger(supabaseAdmin, 'generate-hashtags', 'edge');
    await logger.info('Hashtags generated successfully', {
      platform,
      hashtag_count: hashtags.length,
      model: aiResult.modelUsed,
      provider: aiResult.providerUsed,
      tier: aiResult.tierUsed,
      config_source: chatCfg.source,
    }, user.id);

    return jsonResponse({ hashtags });

  } catch (error: unknown) {
    console.error('Error generating hashtags:', error);
    return errorResponse('Failed to generate hashtags. Please try again.');
  }
});
