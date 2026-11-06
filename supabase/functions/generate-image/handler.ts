import { buildEnqueueArgs, kickAiImageWorker } from "./asyncJob.ts";
import { runInBackground } from "../_shared/background.ts";
import { describeImageFailure } from "./imageFailure.ts";
import { defaultImageRunDeps, runImageGeneration } from "./runImageGeneration.ts";
import { UNBOUNDED } from "./callBudget.ts";
import { corsHeaders, handleCorsOptions, jsonResponse, errorResponse, unauthorizedResponse } from "../_shared/cors.ts";
import { validateRequestBody, validationErrorResponse } from "../_shared/validate.ts";
import { z } from "npm:zod@3.23.8";
import { collectReferences } from "../_shared/image-references.ts";

// A reference image reaches us either as a `data:` URL — the dialog reads
// uploads with FileReader.readAsDataURL — or as an https URL from the media
// library and stock pickers. Both routinely run to hundreds of kilobytes, so
// the cap is on the decoded size we are willing to forward to a provider, not
// on something URL-shaped.
const MAX_REFERENCE_URL_CHARS = 4_000_000;

const ReferenceImageSchema = z.object({
  url: z.string().min(1).max(MAX_REFERENCE_URL_CHARS),
  // Free-form rather than an enum: the prompt builder already has a default
  // branch for an unrecognised type, so a new UI option must not 400 the call.
  type: z.string().max(40).optional(),
  priority: z.number().int().positive().max(20).optional(),
});

const GenerateImageSchema = z.object({
  async: z.boolean().optional(),
  prompt: z.string().min(1).max(5000),
  model: z.string().max(100).optional(),
  aspectRatio: z.string().max(20).optional(),
  quality: z.string().max(20).optional(),
  referenceImage: z.string().min(1).max(MAX_REFERENCE_URL_CHARS).optional(),
  referenceImages: z.array(ReferenceImageSchema).max(5).optional(),
}).passthrough();



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

export interface GenerateImageHandlerDeps {
  admin: any;                                   // service-role client
  userClient(authHeader: string): any;           // anon client carrying the caller's JWT
  serviceRoleCallerUserId(req: Request): Promise<string | null>;
}
export async function handleGenerateImageRequest(req: Request, deps: GenerateImageHandlerDeps): Promise<Response> {
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
    const supabaseClient = deps.userClient(authHeader);

    // Create admin client for rate limiting (bypasses RLS)
    const supabaseAdmin = deps.admin;

    let serviceUserId: string | null;
    try {
      serviceUserId = await deps.serviceRoleCallerUserId(req);
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
    const { async: wantsAsync, prompt, model: requestedModel, aspectRatio, quality, referenceImage, referenceImages } = validation.data;

    const references = collectReferences(referenceImage, referenceImages);

    if (wantsAsync === true) {
      const { data: jobId, error: queueError } = await supabaseAdmin.rpc('enqueue_ai_image_job',
        buildEnqueueArgs(user.id, { prompt, requestedModel, aspectRatio, quality }, references));
      if (queueError || typeof jobId !== 'string') throw queueError ?? new Error('could not queue the image job');
      await runInBackground('kick ai-image-worker', () =>
        kickAiImageWorker(fetch, Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''));
      return new Response(JSON.stringify({ success: true, jobId, status: 'queued' }), {
        status: 202,
        headers: {
          ...corsHeaders, 'Content-Type': 'application/json',
          'X-RateLimit-Limit-Hour': String(rateLimitResult.limitHour),
          'X-RateLimit-Limit-Day': String(rateLimitResult.limitDay),
          'X-RateLimit-Remaining-Hour': String(Math.max(0, rateLimitResult.remainingHour - 1)),
          'X-RateLimit-Remaining-Day': String(Math.max(0, rateLimitResult.remainingDay - 1)),
        },
      });
    }

    const run = await runImageGeneration(
      defaultImageRunDeps(supabaseAdmin, {
        onDispatch: async () => true,
        recordHiggsfieldSuccess: async (row) => {
          const { error: jobError } = await supabaseAdmin.from('ai_generation_jobs').insert({
            user_id: row.userId, provider: 'higgsfield', model_id: row.m.model_id, modality: 'image',
            credential_source: row.credentialSource, status: 'succeeded', result_url: row.url,
            params: { prompt: row.rawPrompt, ...row.params, reservation: row.reserved },
          });
          if (jobError) throw jobError;
        },
      }),
      { userId: user.id, prompt, requestedModel, aspectRatio, quality, references, budget: UNBOUNDED() },
    );
    if (run.kind === 'refused') return errorResponse(run.message, run.status);
    if (run.kind === 'outcome_unknown') {
      return jsonResponse({ success: false, error_code: 'ai_outcome_unknown',
        message: 'The image provider did not confirm the result. Check your Higgsfield history before trying again.' }, 200);
    }
    if (run.kind !== 'succeeded') throw new Error(run.kind === 'failed' ? run.message : 'lease lost');
    const { imageUrl, description, usedModel, attemptErrors } = run;

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
          has_reference_image: references.length > 0,
          reference_image_count: references.length,
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
      const supabaseAdmin = deps.admin;
      const authHeader = req.headers.get('Authorization');
      const token = authHeader?.replace('Bearer ', '') || '';
      const supabaseClient = deps.userClient(`Bearer ${token}`);
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
    const { code: error_code, message } = describeImageFailure(errMsg);

    return jsonResponse({ success: false, error_code, message }, 200);
  }
}
