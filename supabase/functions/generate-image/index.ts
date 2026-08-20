import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";
import { corsHeaders, handleCorsOptions, jsonResponse, errorResponse, unauthorizedResponse } from "../_shared/cors.ts";
import { validateRequestBody, validationErrorResponse } from "../_shared/validate.ts";
import { z } from "npm:zod@3.23.8";
import { HiggsfieldAuthError, resolveHiggsfieldCredential } from "../_shared/higgsfield-oauth.ts";
import { HiggsfieldMcpClient, findOutputUrl } from "../_shared/higgsfield-mcp.ts";
import { checkByoGenerationLimits } from "../_shared/higgsfield-rate-limit.ts";
import { mergeModelSpec, sanitizeParams, missingRequiredParams, resolveAspectRatio, defaultParamsFor } from "../_shared/higgsfield-model-spec.ts";

const GenerateImageSchema = z.object({
  prompt: z.string().min(1).max(5000),
  model: z.string().max(100).optional(),
  aspectRatio: z.string().max(20).optional(),
  quality: z.string().max(20).optional(),
  referenceImage: z.string().max(500).optional(),
  referenceImages: z.array(z.string().max(500)).max(5).optional(),
}).passthrough();

// =====================================================================
// Image model resolution — reads from admin dashboard settings:
//   system_settings.default_ai_model_image           (primary)
//   system_settings.default_ai_model_image_fallback  (fallback)
//   + final hardcoded fallback: Imagen via GOOGLE_AI_STUDIO_KEY.
// No Lovable AI Gateway dependency. Each provider is called directly
// with its own api_key (env var first, provider_api_keys table second).
// =====================================================================

interface ResolvedModel {
  provider_code: string;
  model_id: string;
  api_endpoint: string;
  api_key_env_var: string;
  api_type: string; // 'openai' | 'google' | ...
  source: 'requested' | 'primary' | 'fallback' | 'fallback_2' | 'hardcoded';
  /** Administrator-set knobs for this model, from ai_models.admin_params. */
  admin_params: Record<string, string | number | boolean>;
}

// Last resort when no configured model can run. Must be a model the key can
// actually call: imagen-4.0-generate-001 was 404ing because Imagen is not
// offered on this account and does not support generateContent anyway, which
// left the chain with no working floor. gemini-2.5-flash-image is available and
// was this app's own previous default.
const HARDCODED_FALLBACK: ResolvedModel = {
  provider_code: 'gemini',
  model_id: 'gemini-2.5-flash-image',
  api_endpoint: 'https://generativelanguage.googleapis.com/v1beta',
  api_key_env_var: 'GOOGLE_AI_STUDIO_KEY',
  api_type: 'google',
  source: 'hardcoded',
  admin_params: {},
};

async function lookupModelByProviderAndId(
  supabaseAdmin: any,
  provider_code: string,
  model_id: string,
  source: ResolvedModel['source'],
): Promise<ResolvedModel | null> {
  const { data } = await supabaseAdmin
    .from('ai_models')
    .select('model_id, admin_params, ai_providers!inner(provider_code, api_endpoint, api_key_env_var, api_type, is_active)')
    .eq('model_id', model_id)
    .eq('ai_providers.provider_code', provider_code)
    .eq('is_active', true)
    .maybeSingle();
  if (!data?.ai_providers || !data.ai_providers.is_active) return null;
  return {
    provider_code: data.ai_providers.provider_code,
    model_id: data.model_id,
    api_endpoint: data.ai_providers.api_endpoint,
    api_key_env_var: data.ai_providers.api_key_env_var,
    api_type: data.ai_providers.api_type,
    source,
    admin_params: (data.admin_params ?? {}) as Record<string, string | number | boolean>,
  };
}

async function getSystemSettingModel(
  supabaseAdmin: any,
  key: string,
  source: ResolvedModel['source'],
): Promise<ResolvedModel | null> {
  const { data } = await supabaseAdmin.from('system_settings').select('value').eq('key', key).maybeSingle();
  const v = data?.value;
  if (!v?.provider_code || !v?.model_id) return null;
  return lookupModelByProviderAndId(supabaseAdmin, v.provider_code, v.model_id, source);
}

async function resolveModelChain(supabaseAdmin: any, requestedModelId?: string): Promise<ResolvedModel[]> {
  const chain: ResolvedModel[] = [];
  const seen = new Set<string>();
  const push = (m: ResolvedModel | null) => {
    if (!m) return;
    const k = `${m.provider_code}::${m.model_id}`;
    if (seen.has(k)) return;
    seen.add(k);
    chain.push(m);
  };

  // 1. Requested model (frontend dropdown picked something explicit)
  if (requestedModelId) {
    const { data } = await supabaseAdmin
      .from('ai_models')
      .select('model_id, admin_params, ai_providers!inner(provider_code, api_endpoint, api_key_env_var, api_type, is_active)')
      .eq('model_id', requestedModelId)
      .eq('is_active', true)
      .maybeSingle();
    if (data?.ai_providers?.is_active) {
      push({
        provider_code: data.ai_providers.provider_code,
        model_id: data.model_id,
        api_endpoint: data.ai_providers.api_endpoint,
        api_key_env_var: data.ai_providers.api_key_env_var,
        api_type: data.ai_providers.api_type,
        source: 'requested',
        admin_params: (data.admin_params ?? {}) as Record<string, string | number | boolean>,
      });
    }
  }

  // 2. Admin primary
  push(await getSystemSettingModel(supabaseAdmin, 'default_ai_model_image', 'primary'));
  // 3. Admin fallback
  push(await getSystemSettingModel(supabaseAdmin, 'default_ai_model_image_fallback', 'fallback'));
  // 4. Admin second fallback
  push(await getSystemSettingModel(supabaseAdmin, 'default_ai_model_image_fallback_2', 'fallback_2'));
  // 5. Hardcoded last-resort
  push(HARDCODED_FALLBACK);

  return chain;
}

async function getProviderApiKey(supabaseAdmin: any, m: ResolvedModel): Promise<string | null> {
  const fromEnv = Deno.env.get(m.api_key_env_var);
  if (fromEnv) return fromEnv;
  const { data } = await supabaseAdmin
    .from('provider_api_keys')
    .select('api_key')
    .eq('provider_code', m.provider_code)
    .maybeSingle();
  return data?.api_key || null;
}

// ── Provider dispatchers ──────────────────────────────────────────────
// Each returns { imageUrl, description } or throws.

const OPENAI_SIZE_MAP: Record<string, string> = {
  '1:1': '1024x1024',
  '16:9': '1536x1024',
  '9:16': '1024x1536',
  '4:5': '1024x1280',
  '4:3': '1280x1024',
  '2:3': '1024x1536',
  '3:2': '1536x1024',
};

async function callOpenAIImages(m: ResolvedModel, apiKey: string, prompt: string, aspectRatio: string) {
  const size = OPENAI_SIZE_MAP[aspectRatio] || '1024x1024';
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 230_000);
  try {
    const resp = await fetch(`${m.api_endpoint.replace(/\/$/, '')}/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m.model_id, prompt, size, n: 1, quality: 'low' }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`OpenAI ${resp.status}: ${text.slice(0, 300)}`);
    }
    const data = await resp.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) throw new Error(`OpenAI returned no image: ${JSON.stringify(data).slice(0, 200)}`);
    return { imageUrl: `data:image/png;base64,${b64}`, description: 'Image generated successfully' };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callGoogleGenerateContent(m: ResolvedModel, apiKey: string, prompt: string, aspectRatio: string) {
  const body: any = {
    contents: [{ parts: [{ text: prompt }] }],
  };
  // Image-capable Gemini models accept imageConfig under generationConfig
  if (m.model_id.includes('image') && aspectRatio && aspectRatio !== 'free') {
    body.generationConfig = {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio },
    };
  }
  const resp = await fetch(`${m.api_endpoint.replace(/\/$/, '')}/models/${m.model_id}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Google ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = await resp.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p: any) => p.inline_data?.mime_type?.startsWith('image/') || p.inlineData?.mimeType?.startsWith('image/'));
  if (!imagePart) {
    throw new Error(`Google returned no image: ${JSON.stringify(data).slice(0, 200)}`);
  }
  const inline = imagePart.inline_data || imagePart.inlineData;
  const mime = inline.mime_type || inline.mimeType;
  const b64 = inline.data;
  const textPart = parts.find((p: any) => p.text);
  return { imageUrl: `data:${mime};base64,${b64}`, description: textPart?.text || 'Image generated successfully' };
}

async function generateWithModel(
  m: ResolvedModel,
  apiKey: string,
  prompt: string,
  aspectRatio: string,
): Promise<{ imageUrl: string; description: string }> {
  if (m.api_type === 'openai' || m.provider_code === 'openai') {
    return callOpenAIImages(m, apiKey, prompt, aspectRatio);
  }
  if (m.api_type === 'google' || m.provider_code === 'gemini') {
    return callGoogleGenerateContent(m, apiKey, prompt, aspectRatio);
  }
  throw new Error(`Unsupported provider api_type='${m.api_type}' (provider=${m.provider_code})`);
}

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
  const endpoint = 'generate-image';
  
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
    
    // Default fallback based on plan
    const defaults: Record<string, TierRateLimitConfig> = {
      free: { maxRequestsPerHour: 2, maxRequestsPerDay: 10, isActive: true },
      pro: { maxRequestsPerHour: 15, maxRequestsPerDay: 75, isActive: true },
      business: { maxRequestsPerHour: 50, maxRequestsPerDay: 250, isActive: true },
    };
    return defaults[planSlug] || defaults.free;
  } catch (err) {
    console.error('Failed to fetch rate limit config:', err);
    return { maxRequestsPerHour: 2, maxRequestsPerDay: 10, isActive: true };
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
  
  const endpoint = 'generate-image';
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
      endpoint: 'generate-image',
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

// Check if user has AI access based on their subscription
async function checkAIAccess(supabase: any, userId: string): Promise<SubscriptionCheck> {
  // Check if user is admin (admins always have access)
  const { data: role } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', userId)
    .eq('role', 'admin')
    .maybeSingle();

  if (role) {
    return { allowed: true, isAdmin: true, planSlug: 'admin' };
  }

  // Check user's active subscription
  const { data: subscription, error: subError } = await supabase
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

  if (subError) {
    console.error('Error checking subscription:', subError);
    return { allowed: false, isAdmin: false, planSlug: 'free', reason: 'Error checking subscription' };
  }

  if (!subscription) {
    return { allowed: false, isAdmin: false, planSlug: 'free', reason: 'AI Image Generation requires a Pro or Business subscription' };
  }

  const planSlug = subscription.subscription_plans?.slug || 'free';

  // Only Pro and Business plans have AI image generation
  if (planSlug !== 'pro' && planSlug !== 'business') {
    return { 
      allowed: false, 
      isAdmin: false, 
      planSlug, 
      reason: 'AI Image Generation requires a Pro or Business subscription' 
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

    // Check subscription-based AI access
    const accessCheck = await checkAIAccess(supabaseClient, user.id);
    console.log('AI access check:', accessCheck);

    if (!accessCheck.allowed) {
      return errorResponse(accessCheck.reason || 'AI features require a paid subscription', 403);
    }

    // Get tier-based rate limit config
    const planSlug = accessCheck.isAdmin ? 'business' : accessCheck.planSlug;
    const rateLimitConfig = await getTierRateLimitConfig(supabaseAdmin, user.id, planSlug);
    
    // Check rate limit BEFORE processing (per-user limit with hourly/daily)
    const rateLimitResult = await checkRateLimit(supabaseAdmin, user.id, rateLimitConfig);
    if (!rateLimitResult.allowed) {
      const limitType = rateLimitResult.blockReason === 'daily' ? 'daily' : 'hourly';
      const limitValue = rateLimitResult.blockReason === 'daily' ? rateLimitResult.limitDay : rateLimitResult.limitHour;
      
      console.log('Rate limit exceeded for user:', user.id, 'type:', limitType, 'plan:', planSlug);
      return new Response(
        JSON.stringify({
          error: 'Rate limit exceeded',
          message: `You've reached the ${limitType} limit of ${limitValue} AI image generations. ${limitType === 'hourly' ? 'Please wait an hour.' : 'Try again tomorrow.'}`,
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

    const rawBody = await req.json();
    const validation = validateRequestBody(GenerateImageSchema, rawBody);
    if (!validation.success) {
      return validationErrorResponse(validation, corsHeaders);
    }
    const { prompt, model: requestedModel, aspectRatio, quality, referenceImage, referenceImages } = validation.data;

    // Build prompt with reference image context if available
    let referenceContext = '';
    if (referenceImages && referenceImages.length > 0) {
      const refDescriptions = referenceImages.map((ref: { type: string; priority: number }) => {
        switch (ref.type) {
          case 'style':
            return `Style reference (priority ${ref.priority}): Use the artistic style, colors, and mood from this image`;
          case 'content':
            return `Content reference (priority ${ref.priority}): Use the subject matter and composition from this image`;
          case 'image-to-image':
            return `Image-to-image (priority ${ref.priority}): Transform this image according to the prompt while preserving its core structure`;
          default:
            return `Reference (priority ${ref.priority}): Use this as inspiration`;
        }
      });
      referenceContext = `

Reference images are provided in order of influence (first = most important):
${refDescriptions.join('\n')}

Apply the references according to their types - style references affect visual aesthetics, content references guide subject matter, and image-to-image references should be transformed.`;
    }

    const fullPrompt = `Generate a high-quality image based on this description: ${prompt}.${referenceContext}
    
Style requirements:
- Professional, polished look suitable for social media
- High resolution and clear details
- Aspect ratio: ${aspectRatio}
- Quality level: ${quality}

Make the image visually striking and engaging.`;

    // Resolve full chain from admin settings
    const chain = await resolveModelChain(supabaseAdmin, requestedModel);
    console.log('[generate-image] resolved model chain:', chain.map(c => `${c.source}:${c.provider_code}/${c.model_id}`).join(' → '));

    let imageUrl = '';
    let description = '';
    let usedModel: ResolvedModel | null = null;
    const attemptErrors: string[] = [];

    for (const m of chain) {
      if (m.provider_code === 'higgsfield' || m.api_type === 'higgsfield') {
        const cred = await resolveHiggsfieldCredential(supabaseAdmin, user.id);
        if (cred.source === 'byo') {
          const byoLimit = await checkByoGenerationLimits(supabaseAdmin, user.id);
          if (!byoLimit.allowed) return errorResponse(byoLimit.error, 429);
        }
        let reserved = false;
        if (cred.source === 'platform') {
          const { data } = await supabaseAdmin.rpc('reserve_ai_generation_quota', { p_user_id: user.id });
          const quota = Array.isArray(data) ? data[0] : data;
          if (!quota?.allowed) return errorResponse('Daily AI generation limit reached', 402);
          reserved = true;
        }
        try {
          const { data: catalog } = await supabaseAdmin.from('ai_models').select('metadata').eq('model_id', m.model_id).maybeSingle();
          const spec = mergeModelSpec(m.model_id, catalog?.metadata, 'image');
          // Spec defaults are the floor, the administrator overrides them, and the
          // user's aspect ratio is applied last. sanitizeParams then drops anything
          // this model does not declare, so falling through to a model with
          // different knobs cannot send it a parameter it will reject.
          const params = sanitizeParams(spec, {
            ...defaultParamsFor(spec),
            ...m.admin_params,
            ...(aspectRatio ? { aspect_ratio: resolveAspectRatio(spec, aspectRatio) || aspectRatio } : {}),
          });
          const missing = missingRequiredParams(spec, params);
          if (missing.length) {
            // Skip this candidate, do not abort the chain. A model the
            // administrator has not finished configuring must not take the whole
            // run down with it — the next tier may well be ready.
            throw new Error(`needs ${missing.join(', ')} — set it in Admin › AI Configuration`);
          }
          const payload = await HiggsfieldMcpClient.fromCredential(cred, supabaseAdmin).callTool('generate_image', { params: { model: m.model_id, prompt: fullPrompt, ...params } });
          const generatedUrl = findOutputUrl(payload);
          if (!generatedUrl) throw new Error('Higgsfield returned no image URL');
          const { data: job, error: jobError } = await supabaseAdmin.from('ai_generation_jobs').insert({ user_id: user.id, provider: 'higgsfield', model_id: m.model_id, modality: 'image', credential_source: cred.source, status: 'succeeded', result_url: generatedUrl, params: { prompt, ...params, reservation: reserved } }).select('id').single();
          if (jobError) throw jobError;
          imageUrl = generatedUrl; description = `Generated with Higgsfield ${m.model_id}`; usedModel = m;
          break;
        } catch (err: any) {
          if (reserved) await supabaseAdmin.rpc('release_ai_generation_quota', { p_user_id: user.id });
          // Record and move to the next candidate. Rethrowing here aborted the
          // entire chain, which defeated the point of having fallbacks.
          const msg = `[${m.source}] ${m.provider_code}/${m.model_id}: ${err?.message || String(err)}`;
          console.error(msg);
          attemptErrors.push(msg);
          continue;
        }
      }
      const apiKey = await getProviderApiKey(supabaseAdmin, m);
      if (!apiKey) {
        const msg = `[${m.source}] ${m.provider_code}/${m.model_id}: missing ${m.api_key_env_var}`;
        console.warn(msg);
        attemptErrors.push(msg);
        continue;
      }
      try {
        console.log(`[generate-image] attempt ${m.source} ${m.provider_code}/${m.model_id}`);
        const result = await generateWithModel(m, apiKey, fullPrompt, aspectRatio);
        imageUrl = result.imageUrl;
        description = result.description;
        usedModel = m;
        break;
      } catch (err: any) {
        const msg = `[${m.source}] ${m.provider_code}/${m.model_id}: ${err?.message || String(err)}`;
        console.error(msg);
        attemptErrors.push(msg);
      }
    }

    if (!usedModel) {
      throw new Error(`All image providers failed. Attempts: ${attemptErrors.join(' | ')}`);
    }

    console.log('Image generated successfully with model:', `${usedModel.provider_code}/${usedModel.model_id}`, 'source:', usedModel.source);

    // Log successful image generation to system_logs
    try {
      await supabaseAdmin.from('system_logs').insert({
        level: 'info',
        category: 'ai',
        source: 'generate-image',
        message: `Image generated using ${usedModel.provider_code}/${usedModel.model_id} (${usedModel.source})`,
        user_id: user.id,
        metadata: {
          feature: 'image_generation',
          model_used: usedModel.model_id,
          provider_code: usedModel.provider_code,
          api_type: usedModel.api_type,
          chain_source: usedModel.source,
          attempt_errors: attemptErrors,
          prompt: prompt?.substring(0, 500),
          aspect_ratio: aspectRatio,
          quality: quality,
          has_reference_image: !!referenceImage,
          reference_image_count: referenceImages?.length || 0,
          plan: planSlug,
          success: true,
        },
      });
    } catch (logErr) {
      console.error('Failed to log image generation:', logErr);
    }


    return new Response(
      JSON.stringify({ imageUrl, description }),
      {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'X-RateLimit-Limit-Hour': String(rateLimitResult.limitHour),
          'X-RateLimit-Limit-Day': String(rateLimitResult.limitDay),
          'X-RateLimit-Remaining-Hour': String(Math.max(0, rateLimitResult.remainingHour - 1)),
          'X-RateLimit-Remaining-Day': String(Math.max(0, rateLimitResult.remainingDay - 1)),
        },
      }
    );

  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('Error generating image:', errMsg);

    // Log failed image generation to system_logs
    try {
      const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
      );
      const authHeader = req.headers.get('Authorization');
      const token = authHeader?.replace('Bearer ', '') || '';
      const supabaseClient = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_ANON_KEY') ?? '',
        { global: { headers: { Authorization: `Bearer ${token}` } } }
      );
      const { data: { user: errUser } } = await supabaseClient.auth.getUser(token);
      if (errUser) {
        await supabaseAdmin.from('system_logs').insert({
          level: 'error',
          category: 'ai',
          source: 'generate-image',
          message: `Image generation failed: ${errMsg}`,
          user_id: errUser.id,
          metadata: {
            feature: 'image_generation',
            error: errMsg,
            success: false,
          },
        });
      }
    } catch (logErr) {
      console.error('Failed to log image generation error:', logErr);
    }

    // Map known failures to readable codes and ALWAYS return CORS headers.
    const lower = errMsg.toLowerCase();
    let error_code = 'ai_error';
    // Default: surface the real internal error so admins can debug instead of
    // a generic "temporarily unavailable" message.
    let message = `Image generation failed: ${errMsg}`;

    if (lower.includes('all image providers failed') || lower.includes('missing ')) {
      error_code = 'ai_not_configured';
      message = `Image generation is not configured. Set the provider API key (e.g. OPENAI_API_KEY or GOOGLE_AI_STUDIO_KEY) for the model selected in admin settings. ${errMsg}`;
    } else if (lower.includes('unsupported provider')) {
      error_code = 'ai_provider_unsupported';
      message = `The configured image provider is not supported by this function. ${errMsg}`;
    } else if (lower.includes('credits')) {
      error_code = 'ai_credits_exhausted';
      message = 'AI credits exhausted. Please add credits to continue.';
    } else if (lower.includes('rate limit')) {
      error_code = 'ai_rate_limited';
      message = 'Too many requests. Please wait a moment and try again.';
    } else if (lower.includes('did not return an image') || lower.includes('no image')) {
      error_code = 'ai_no_image';
      // keep detailed errMsg so user/admin sees model + provider reason
      message = `The model could not generate an image. ${errMsg}`;
    } else if (lower.includes('empty response')) {
      error_code = 'ai_gateway_empty';
      message = `The AI gateway returned an empty response. ${errMsg}`;
    } else if (lower.includes('gateway') || lower.includes('google api')) {
      error_code = 'ai_gateway_error';
      message = `AI provider error: ${errMsg}`;
    }

    return jsonResponse({ success: false, error_code, message }, 200);
  }
});
