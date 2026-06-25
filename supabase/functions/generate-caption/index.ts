import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";
import { corsHeaders, handleCorsOptions, jsonResponse, errorResponse, unauthorizedResponse } from "../_shared/cors.ts";
import { createLogger } from "../_shared/logging.ts";
import { callAiWithFallback, logAiCall, resolveChatModelConfig } from "../_shared/ai-fallback.ts";

interface TierRateLimitConfig {
  maxRequestsPerHour: number;
  maxRequestsPerDay: number;
  isActive: boolean;
}

interface RateLimitResult {
  allowed: boolean;
  remainingHour: number;
  remainingDay: number;
  limitHour: number;
  limitDay: number;
  retryAfter?: number;
  blockReason?: 'hourly' | 'daily';
}

// Get user's subscription plan
async function getUserPlan(supabaseAdmin: any, userId: string): Promise<string> {
  try {
    const { data: subscription } = await supabaseAdmin
      .from('user_subscriptions')
      .select(`
        plan_id,
        status,
        subscription_plans!inner (slug)
      `)
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle();

    return subscription?.subscription_plans?.slug || 'free';
  } catch (err) {
    console.error('Failed to get user plan:', err);
    return 'free';
  }
}

// Fetch tier-based rate limit configuration from database
async function getTierRateLimitConfig(supabaseAdmin: any, userId: string, planSlug: string): Promise<TierRateLimitConfig> {
  const endpoint = 'generate-caption';
  
  try {
    // First check for user-specific override
    const { data: userOverride } = await supabaseAdmin
      .from('user_rate_limits')
      .select('max_requests, window_minutes, expires_at')
      .eq('user_id', userId)
      .eq('endpoint', endpoint)
      .maybeSingle();
    
    if (userOverride) {
      // Check if override is not expired
      if (!userOverride.expires_at || new Date(userOverride.expires_at) > new Date()) {
        // Convert window-based limit to hourly/daily
        const isHourly = userOverride.window_minutes <= 60;
        return {
          maxRequestsPerHour: isHourly ? userOverride.max_requests : Math.ceil(userOverride.max_requests / 24),
          maxRequestsPerDay: isHourly ? userOverride.max_requests * 24 : userOverride.max_requests,
          isActive: true,
        };
      }
    }
    
    // Fetch tier-based limits
    const { data: tierLimit } = await supabaseAdmin
      .from('tier_rate_limits')
      .select('max_requests_per_hour, max_requests_per_day, is_active')
      .eq('plan_slug', planSlug)
      .eq('endpoint', endpoint)
      .maybeSingle();
    
    if (tierLimit) {
      return {
        maxRequestsPerHour: tierLimit.max_requests_per_hour,
        maxRequestsPerDay: tierLimit.max_requests_per_day,
        isActive: tierLimit.is_active,
      };
    }
    
    // Fall back to global settings (for backwards compatibility)
    const { data: globalSetting } = await supabaseAdmin
      .from('rate_limit_settings')
      .select('max_requests, window_minutes, is_active')
      .eq('endpoint', endpoint)
      .maybeSingle();
    
    if (globalSetting) {
      return {
        maxRequestsPerHour: globalSetting.max_requests,
        maxRequestsPerDay: globalSetting.max_requests * 24,
        isActive: globalSetting.is_active,
      };
    }
    
    // Default fallback based on plan
    const defaults: Record<string, TierRateLimitConfig> = {
      free: { maxRequestsPerHour: 5, maxRequestsPerDay: 20, isActive: true },
      pro: { maxRequestsPerHour: 30, maxRequestsPerDay: 150, isActive: true },
      business: { maxRequestsPerHour: 100, maxRequestsPerDay: 500, isActive: true },
    };
    return defaults[planSlug] || defaults.free;
  } catch (err) {
    console.error('Failed to fetch rate limit config:', err);
    return { maxRequestsPerHour: 5, maxRequestsPerDay: 20, isActive: true };
  }
}

// Check rate limit for a user (both hourly and daily)
async function checkRateLimit(supabaseAdmin: any, userId: string, config: TierRateLimitConfig): Promise<RateLimitResult> {
  // If rate limiting is disabled, allow all requests
  if (!config.isActive) {
    return { 
      allowed: true, 
      remainingHour: config.maxRequestsPerHour, 
      remainingDay: config.maxRequestsPerDay,
      limitHour: config.maxRequestsPerHour,
      limitDay: config.maxRequestsPerDay,
    };
  }
  
  const endpoint = 'generate-caption';
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  
  try {
    // Count requests in the last hour
    const { count: hourCount, error: hourError } = await supabaseAdmin
      .from('api_logs')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('endpoint', endpoint)
      .gte('created_at', hourAgo.toISOString());
    
    // Count requests in the last day
    const { count: dayCount, error: dayError } = await supabaseAdmin
      .from('api_logs')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('endpoint', endpoint)
      .gte('created_at', dayAgo.toISOString());
    
    if (hourError || dayError) {
      console.error('Rate limit check error:', hourError || dayError);
      return { 
        allowed: true, 
        remainingHour: config.maxRequestsPerHour, 
        remainingDay: config.maxRequestsPerDay,
        limitHour: config.maxRequestsPerHour,
        limitDay: config.maxRequestsPerDay,
      };
    }
    
    const currentHourCount = hourCount || 0;
    const currentDayCount = dayCount || 0;
    const remainingHour = Math.max(0, config.maxRequestsPerHour - currentHourCount);
    const remainingDay = Math.max(0, config.maxRequestsPerDay - currentDayCount);
    
    // Check hourly limit first
    if (currentHourCount >= config.maxRequestsPerHour) {
      return {
        allowed: false,
        remainingHour: 0,
        remainingDay,
        limitHour: config.maxRequestsPerHour,
        limitDay: config.maxRequestsPerDay,
        retryAfter: 3600, // 1 hour
        blockReason: 'hourly',
      };
    }
    
    // Check daily limit
    if (currentDayCount >= config.maxRequestsPerDay) {
      return {
        allowed: false,
        remainingHour,
        remainingDay: 0,
        limitHour: config.maxRequestsPerHour,
        limitDay: config.maxRequestsPerDay,
        retryAfter: 86400, // 24 hours
        blockReason: 'daily',
      };
    }
    
    return {
      allowed: true,
      remainingHour,
      remainingDay,
      limitHour: config.maxRequestsPerHour,
      limitDay: config.maxRequestsPerDay,
    };
  } catch (err) {
    console.error('Rate limit error:', err);
    return { 
      allowed: true, 
      remainingHour: config.maxRequestsPerHour, 
      remainingDay: config.maxRequestsPerDay,
      limitHour: config.maxRequestsPerHour,
      limitDay: config.maxRequestsPerDay,
    };
  }
}

// Log API request for rate limiting
async function logApiRequest(supabaseAdmin: any, userId: string, statusCode: number): Promise<void> {
  try {
    await supabaseAdmin.from('api_logs').insert({
      user_id: userId,
      endpoint: 'generate-caption',
      method: 'POST',
      status_code: statusCode,
      ip_address: '0.0.0.0',
    });
  } catch (err) {
    console.error('Failed to log API request:', err);
  }
}

interface SubscriptionCheck {
  allowed: boolean;
  isAdmin: boolean;
  planSlug: string;
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
    return { allowed: false, isAdmin: false, planSlug: 'free', reason: 'Error checking subscription' };
  }

  if (!subscription) {
    console.log('No active subscription found for user:', userId);
    return { allowed: false, isAdmin: false, planSlug: 'free', reason: 'AI features require a Pro or Business subscription' };
  }

  const planSlug = subscription.subscription_plans?.slug || 'free';
  const features = subscription.subscription_plans?.features || [];

  console.log('User plan:', planSlug, 'features:', features);

  // Pro and Business always have access
  if (planSlug === 'pro' || planSlug === 'business') {
    return { allowed: true, isAdmin: false, planSlug };
  }

  // Check if plan has AI features in features array
  const hasAIFeature = Array.isArray(features) && features.some((f: string) => 
    typeof f === 'string' && (
      f.toLowerCase().includes('ai caption') || 
      f.toLowerCase().includes('ai feature')
    )
  );

  if (!hasAIFeature) {
    return { 
      allowed: false, 
      isAdmin: false, 
      planSlug, 
      reason: 'AI Captions require a Pro or Business subscription' 
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

    // Create admin client for rate limiting (bypasses RLS)
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser(token);

    if (userError || !user) {
      console.error('Auth User Error:', userError);
      return unauthorizedResponse();
    }

    console.log('User authenticated:', user.id);

    // Check subscription-based AI access using admin client (bypasses RLS)
    const accessCheck = await checkAIAccess(supabaseAdmin, user.id);
    console.log('AI access check:', accessCheck);

    if (!accessCheck.allowed) {
      return errorResponse(accessCheck.reason || 'AI features require a paid subscription', 403);
    }

    const planSlug = accessCheck.planSlug;

    // Admins bypass rate limiting entirely
    let rateLimitResult: RateLimitResult | null = null;
    if (!accessCheck.isAdmin) {
      // Get tier-based rate limit config
      const rateLimitConfig = await getTierRateLimitConfig(supabaseAdmin, user.id, planSlug);

      // Check rate limit BEFORE processing (per-user limit with hourly/daily)
      rateLimitResult = await checkRateLimit(supabaseAdmin, user.id, rateLimitConfig);
      if (!rateLimitResult.allowed) {
        const limitType = rateLimitResult.blockReason === 'daily' ? 'daily' : 'hourly';
        const limitValue = rateLimitResult.blockReason === 'daily' ? rateLimitResult.limitDay : rateLimitResult.limitHour;

        console.log('Rate limit exceeded for user:', user.id, 'type:', limitType, 'plan:', planSlug);
        return new Response(
          JSON.stringify({
            error: 'Rate limit exceeded',
            message: `You've reached the ${limitType} limit of ${limitValue} AI caption generations. ${limitType === 'hourly' ? 'Please wait an hour.' : 'Try again tomorrow.'}`,
            remainingHour: 0,
            remainingDay: rateLimitResult.remainingDay,
            retryAfter: rateLimitResult.retryAfter,
          }),
          {
            status: 429,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json',
              'X-RateLimit-Limit-Hour': String(rateLimitResult.limitHour),
              'X-RateLimit-Limit-Day': String(rateLimitResult.limitDay),
              'X-RateLimit-Remaining-Hour': '0',
              'X-RateLimit-Remaining-Day': String(rateLimitResult.remainingDay),
              'Retry-After': String(rateLimitResult.retryAfter),
            },
          }
        );
      }

      // Log this request for rate limiting
      await logApiRequest(supabaseAdmin, user.id, 200);
    } // end admin bypass

    const { context, platform, tone, model, language, requestType } = await req.json();

    // Handle brand_intelligence request type
    if (requestType === "brand_intelligence") {
      const langInstruction = language === "arabic" ? "Write everything in Arabic."
        : language === "both" ? "Write each item in both Arabic and English (Arabic first)."
        : "Write in English.";
      
      const biSystemPrompt = `You are an expert social media content strategist. Generate creative content inspired by (but not copying) reference content. ${langInstruction} Return ONLY valid JSON, no markdown code blocks.`;
      const biUserPrompt = `Reference content: "${(context || "").slice(0, 1000)}"
Tone: ${tone || "professional"} | Platform: ${platform || "instagram"}
Generate exactly this JSON structure:
{
  "captions": ["caption1", "caption2", ... 10 ready-to-post captions with hashtags],
  "imagePrompts": ["prompt1", "prompt2", ... 10 detailed image generation prompts],
  "videoPrompts": ["prompt1", "prompt2", ... 10 short-form video outlines with Hook + Main idea + CTA]
}`;

      const biRequestBody = {
        messages: [
          { role: "system", content: biSystemPrompt },
          { role: "user", content: biUserPrompt },
        ],
      };

      // Resolve chat-model config: user override → admin /admin/settings Chat → hardcoded last-resort
      const biCfg = await resolveChatModelConfig(supabaseAdmin, user.id);
      console.log('BI chat model config:', biCfg.source, biCfg.primaryProvider, biCfg.primaryModel);

      const biLogger = createLogger(supabaseAdmin, 'generate-caption', 'edge');
      try {
        const biAiResult = await callAiWithFallback(
          biRequestBody,
          biCfg.primaryProvider,
          biCfg.primaryModel,
          biCfg.fallbackProvider,
          biCfg.fallbackModel,
          biCfg.lastResortProvider,
          biCfg.lastResortModel,
        );
        const biAiSuccess = biAiResult.response.ok;

        await logAiCall(supabaseAdmin, 'brand_intelligence', 'generate-caption', user.id, biAiSuccess, biAiResult, {
          platform: platform || 'instagram',
          tone: tone || 'professional',
          language: language || 'english',
          feature: 'brand_intelligence',
        });

        if (!biAiSuccess) {
          const errText = await biAiResult.response.text();
          await biLogger.error('Brand intelligence AI generation failed', {
            feature: 'brand_intelligence',
            error_message: errText,
            model_used: biAiResult.modelUsed,
            tier_used: biAiResult.tierUsed,
          }, user.id);
          throw new Error('AI generation failed for brand intelligence');
        }

        const biData = await biAiResult.response.json();
        const biRaw = biData.choices?.[0]?.message?.content || '{}';
        
        let parsed;
        try {
          const cleaned = biRaw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          parsed = JSON.parse(cleaned);
        } catch {
          parsed = { captions: [biRaw], imagePrompts: [], videoPrompts: [] };
        }

        const result = {
          captions: parsed.captions || [],
          imagePrompts: parsed.imagePrompts || [],
          videoPrompts: parsed.videoPrompts || [],
        };

        await biLogger.info('Brand intelligence content generated', {
          feature: 'brand_intelligence',
          platform: platform || 'instagram',
          tone: tone || 'professional',
          language: language || 'english',
          captions_count: result.captions.length,
          image_prompts_count: result.imagePrompts.length,
          video_prompts_count: result.videoPrompts.length,
          model_used: biAiResult.modelUsed,
          provider_used: biAiResult.providerUsed,
          tier_used: biAiResult.tierUsed,
        }, user.id);

        return jsonResponse(result);
      } catch (biError: unknown) {
        const errMsg = biError instanceof Error ? biError.message : String(biError);
        await biLogger.error('Brand intelligence generation error', {
          feature: 'brand_intelligence',
          error_message: errMsg,
          error_stack: biError instanceof Error ? biError.stack : undefined,
        }, user.id);
        throw biError;
      }
    }

    // Handle YouTube-specific AI request types
    if (requestType === "youtube_title" || requestType === "youtube_description" || requestType === "youtube_tags") {
      const outputLang = language === "arabic" ? "Arabic" : "English";
      let ytSystemPrompt = "";
      let ytUserPrompt = "";

      if (requestType === "youtube_title") {
        ytSystemPrompt = `You are a YouTube SEO expert. Generate exactly 5 catchy, click-worthy YouTube video titles. Write ALL titles in ${outputLang}. ${language === "arabic" ? "Use natural Arabic script." : ""} Return ONLY valid JSON.`;
        ytUserPrompt = `Based on this context: "${(context || "").slice(0, 500)}"
Generate 5 unique YouTube video titles optimized for search and clicks.
Return JSON: {"suggestions": ["title1", "title2", "title3", "title4", "title5"]}`;
      } else if (requestType === "youtube_description") {
        ytSystemPrompt = `You are a YouTube SEO expert. Generate exactly 3 YouTube video descriptions. Each must be ~500 characters, well-organized with emojis, include placeholder links and social media placeholders. Write in ${outputLang}. ${language === "arabic" ? "Use natural Arabic script." : ""} Return ONLY valid JSON.`;
        ytUserPrompt = `Based on this context: "${(context || "").slice(0, 1000)}"
Generate 3 YouTube descriptions (~500 chars each) with:
- Engaging intro with emojis
- Key points/timestamps placeholder
- Call to action
- Placeholders: [YOUR LINK], [YOUR WEBSITE], [YOUR INSTAGRAM], [YOUR TWITTER], [YOUR TIKTOK]
- Relevant hashtags at the end
Return JSON: {"suggestions": ["desc1", "desc2", "desc3"]}`;
      } else {
        ytSystemPrompt = `You are a YouTube SEO expert. Generate exactly 5 sets of highly relevant YouTube tags. Write in ${outputLang}. Return ONLY valid JSON.`;
        ytUserPrompt = `Based on this context: "${(context || "").slice(0, 1000)}"
Generate 5 different comma-separated tag sets optimized for YouTube SEO.
Each set should have 5-8 relevant tags.
Return JSON: {"suggestions": ["tag1, tag2, tag3, tag4, tag5", "tagA, tagB, tagC, tagD, tagE", ...]}`;
      }

      const ytRequestBody = {
        messages: [
          { role: "system", content: ytSystemPrompt },
          { role: "user", content: ytUserPrompt },
        ],
        max_tokens: 4096,
        temperature: 0.8,
      };

      // Resolve chat-model config: user override → admin /admin/settings Chat → hardcoded last-resort
      const ytCfg = await resolveChatModelConfig(supabaseAdmin, user.id);
      console.log('YT chat model config:', ytCfg.source, ytCfg.primaryProvider, ytCfg.primaryModel);

      const ytLogger = createLogger(supabaseAdmin, 'generate-caption', 'edge');
      try {
        const ytAiResult = await callAiWithFallback(
          ytRequestBody,
          ytCfg.primaryProvider,
          ytCfg.primaryModel,
          ytCfg.fallbackProvider,
          ytCfg.fallbackModel,
          ytCfg.lastResortProvider,
          ytCfg.lastResortModel,
        );
        const ytAiSuccess = ytAiResult.response.ok;

        await logAiCall(supabaseAdmin, requestType, 'generate-caption', user.id, ytAiSuccess, ytAiResult, {
          feature: requestType,
          language: language || 'english',
        });

        if (!ytAiSuccess) {
          const errText = await ytAiResult.response.text();
          await ytLogger.error(`YouTube ${requestType} AI generation failed`, {
            feature: requestType,
            error_message: errText,
            model_used: ytAiResult.modelUsed,
            tier_used: ytAiResult.tierUsed,
          }, user.id);
          throw new Error('AI generation failed for YouTube content');
        }

        const ytData = await ytAiResult.response.json();
        const ytRaw = ytData.choices?.[0]?.message?.content || '{}';

        let ytParsed;
        try {
          let cleaned = ytRaw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          if (!cleaned.endsWith('}')) {
            const lastBracket = cleaned.lastIndexOf('"');
            if (lastBracket > 0) {
              cleaned = cleaned.substring(0, lastBracket + 1) + ']}';
            }
          }
          ytParsed = JSON.parse(cleaned);
        } catch {
          const matches = ytRaw.match(/"([^"]{10,})"/g);
          if (matches && matches.length > 0) {
            ytParsed = { suggestions: matches.map((m: string) => m.slice(1, -1)) };
          } else {
            ytParsed = { suggestions: ytRaw.trim() ? [ytRaw.trim()] : [] };
          }
        }

        const suggestions = ytParsed.suggestions || [];

        await ytLogger.info(`YouTube ${requestType} generated successfully`, {
          feature: requestType,
          language: language || 'english',
          suggestions_count: suggestions.length,
          model_used: ytAiResult.modelUsed,
          provider_used: ytAiResult.providerUsed,
          tier_used: ytAiResult.tierUsed,
        }, user.id);

        return jsonResponse({ suggestions });
      } catch (ytError: unknown) {
        const errMsg = ytError instanceof Error ? ytError.message : String(ytError);
        await ytLogger.error(`YouTube ${requestType} generation error`, {
          feature: requestType,
          error_message: errMsg,
          error_stack: ytError instanceof Error ? ytError.stack : undefined,
        }, user.id);
        throw ytError;
      }
    }

    // Resolve chat-model config: user override → admin /admin/settings Chat → hardcoded last-resort
    const chatCfg = await resolveChatModelConfig(supabaseAdmin, user.id);
    if (model) {
      console.warn('Client-supplied model param ignored — admin Chat config governs caption generation. Got:', model);
    }
    console.log('Caption chat model config:', chatCfg.source, chatCfg.primaryProvider, chatCfg.primaryModel);

    const outputLanguage = language === 'arabic' ? 'Arabic' : 'English';

    const systemPrompt = `You are a Senior Social Media Copywriter who creates engaging, viral captions for different platforms.

LANGUAGE RULE: You MUST write ALL captions entirely in ${outputLanguage}. ${language === 'arabic' ? 'Use natural Arabic script with right-to-left text flow. Do NOT mix Arabic with English words unless they are brand names.' : ''}

Guidelines:
- Keep captions concise and impactful
- Include relevant emojis naturally
- Add a call-to-action when appropriate
- Use hashtags sparingly and relevantly (3-5 max for Instagram, fewer for other platforms)
- Match the platform's style and character limits

Platform-specific guidelines:
- Instagram: Engaging, personal, story-driven (max 2200 chars)
- Facebook: Conversational, shareable (max 63,206 chars but shorter is better)
- TikTok: Trendy, punchy, hook-focused (max 4000 chars)
- Twitter/X: Concise, witty (max 280 chars)
- LinkedIn: Professional, value-driven (max 3000 chars)
- Pinterest: Inspiring, keyword-rich (max 500 chars)
- YouTube: Descriptive, SEO-friendly (max 5000 chars)
- Threads: Conversational, authentic (max 500 chars)
- Bluesky: Concise, community-focused (max 300 chars)

You must generate exactly 5 distinct caption variations. Each variation should use a different hook style:
1. Emotional / storytelling hook
2. Curiosity-driven / question hook
3. Bold statement / controversial take
4. Value-first / educational hook
5. Trendy / pop-culture reference

Separate each caption with exactly "---" on its own line. Do NOT number them. Do NOT add any explanations or labels. Return ONLY the 5 captions separated by ---.`;

    const userPrompt = `Generate 5 ${tone || 'engaging'} captions for ${platform || 'social media'} in ${outputLanguage}.

${context ? `Context/Topic: ${context}` : 'Create a general engaging post.'}

Return exactly 5 captions separated by --- on its own line. No numbering, no labels, no explanations.`;

    const requestBody = {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
    };

    // 3-tier AI call with fallback chain
    const aiResult = await callAiWithFallback(
      requestBody,
      chatCfg.primaryProvider,
      chatCfg.primaryModel,
      chatCfg.fallbackProvider,
      chatCfg.fallbackModel,
      chatCfg.lastResortProvider,
      chatCfg.lastResortModel,
    );

    const aiSuccess = aiResult.response.ok;

    // Log AI call to system_logs
    await logAiCall(supabaseAdmin, 'caption_generation', 'generate-caption', user.id, aiSuccess, aiResult, {
      platform,
      tone,
      language: language || 'english',
    });

    if (!aiSuccess) {
      const errorText = await aiResult.response.text();
      console.error('All AI tiers failed for caption generation:', errorText);
      throw new Error(`AI caption generation failed after all fallbacks`);
    }

    const data = await aiResult.response.json();
    const rawContent = data.choices?.[0]?.message?.content || '';
    console.log(`Caption generated using ${aiResult.tierUsed} tier (${aiResult.modelUsed})`);

    console.log('Generated captions raw:', rawContent.slice(0, 200) + '...');

    // Parse 5 captions separated by ---
    const captions = rawContent
      .split(/\n?---\n?/)
      .map((c: string) => c.trim())
      .filter((c: string) => c.length > 0);

    console.log('Parsed', captions.length, 'caption options');

    // Log successful caption generation
    const logger = createLogger(supabaseAdmin, 'generate-caption', 'edge');
    await logger.info('Caption generated successfully', {
      platform,
      tone,
      language: language || 'english',
      options_count: captions.length,
      model: aiResult.modelUsed,
      provider: aiResult.providerUsed,
      tier: aiResult.tierUsed,
      config_source: chatCfg.source,
    }, user.id);

    const responseHeaders: Record<string, string> = {
      ...corsHeaders,
      'Content-Type': 'application/json',
    };
    if (rateLimitResult) {
      responseHeaders['X-RateLimit-Limit-Hour'] = String(rateLimitResult.limitHour);
      responseHeaders['X-RateLimit-Limit-Day'] = String(rateLimitResult.limitDay);
      responseHeaders['X-RateLimit-Remaining-Hour'] = String(Math.max(0, rateLimitResult.remainingHour - 1));
      responseHeaders['X-RateLimit-Remaining-Day'] = String(Math.max(0, rateLimitResult.remainingDay - 1));
    }

    return new Response(
      JSON.stringify({ captions, caption: captions[0] || rawContent.trim() }),
      { headers: responseHeaders }
    );

  } catch (error: unknown) {
    console.error('Error generating caption:', error);
    try {
      const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
      );
      const errLogger = createLogger(supabaseAdmin, 'generate-caption', 'edge');
      await errLogger.error('Unhandled caption generation error', {
        feature: 'caption_generation',
        error_message: error instanceof Error ? error.message : String(error),
        error_stack: error instanceof Error ? error.stack : undefined,
      });
    } catch {}
    return errorResponse('Failed to generate caption. Please try again.');
  }
});
