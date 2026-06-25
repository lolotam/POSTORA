import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";
import { corsHeaders, handleCorsOptions, jsonResponse, errorResponse, unauthorizedResponse } from "../_shared/cors.ts";

// Model mapping for different APIs
const MODEL_CONFIG: Record<string, { api: 'lovable' | 'google', model: string }> = {
  'google/gemini-2.5-flash-image': { api: 'lovable', model: 'google/gemini-2.5-flash-image' },
  'google/gemini-3-pro-image-preview': { api: 'lovable', model: 'google/gemini-3-pro-image-preview' },
  'imagen-4.0-generate-001': { api: 'google', model: 'imagen-4.0-generate-001' },
  'imagen-4.0-ultra-generate-001': { api: 'google', model: 'imagen-4.0-ultra-generate-001' },
};

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

    const { prompt, model = 'google/gemini-2.5-flash-image', aspectRatio, quality, referenceImage, referenceImages } = await req.json();

    const modelConfig = MODEL_CONFIG[model] || MODEL_CONFIG['google/gemini-2.5-flash-image'];
    console.log('Generating image with model:', modelConfig.model, 'API:', modelConfig.api, 'plan:', planSlug);

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

    // Construct the prompt with style requirements
    const fullPrompt = `Generate a high-quality image based on this description: ${prompt}.${referenceContext}
    
Style requirements:
- Professional, polished look suitable for social media
- High resolution and clear details
- Aspect ratio: ${aspectRatio}
- Quality level: ${quality}

Make the image visually striking and engaging.`;

    let imageUrl: string;
    let description: string;

    if (modelConfig.api === 'lovable') {
      // Use Lovable AI Gateway for Gemini models
      const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
      if (!LOVABLE_API_KEY) {
        throw new Error('LOVABLE_API_KEY is not configured');
      }

      // Build message content with multiple reference images if available
      let messageContent: any;
      if (referenceImages && referenceImages.length > 0) {
        // Include all reference images in order of priority
        messageContent = [
          { type: 'text', text: fullPrompt },
          ...referenceImages.map((ref: { url: string }) => ({
            type: 'image_url',
            image_url: { url: ref.url }
          }))
        ];
      } else if (referenceImage) {
        messageContent = [
          { type: 'text', text: fullPrompt },
          { type: 'image_url', image_url: { url: referenceImage } }
        ];
      } else {
        messageContent = fullPrompt;
      }

      const messages: any[] = [{
        role: 'user',
        content: messageContent
      }];

      // Build request body with proper aspect ratio configuration
      const requestBody: any = {
        model: modelConfig.model,
        messages,
        modalities: ['image', 'text'],
      };

      // Add generationConfig with imageConfig for aspect ratio support
      // This follows the Google Gemini API format for proper aspect ratio handling
      if (aspectRatio && aspectRatio !== 'free') {
        requestBody.generationConfig = {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: {
            aspectRatio: aspectRatio, // e.g., "16:9", "1:1", "9:16", "4:3", "3:4"
          },
        };
      }

      console.log('Sending request with config:', JSON.stringify(requestBody).slice(0, 500));

      const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${LOVABLE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        if (response.status === 429) {
          return errorResponse('Rate limit exceeded. Please try again later.', 429);
        }
        if (response.status === 402) {
          return errorResponse('AI credits exhausted. Please add credits to continue.', 402);
        }
        const errorText = await response.text();
        console.error('Lovable AI gateway error:', response.status, errorText);
        // Surface real upstream status + sanitized snippet so we can debug
        const snippet = errorText.replace(/Bearer\s+[A-Za-z0-9._\-]+/g, 'Bearer ***').slice(0, 300);
        throw new Error(`AI gateway error ${response.status} (model=${modelConfig.model}): ${snippet}`);
      }

      const responseText = await response.text();
      if (!responseText || responseText.trim() === '') {
        console.error('Empty response from AI gateway');
        throw new Error(`AI gateway returned an empty response (model=${modelConfig.model}). Please try again.`);
      }
      
      let data;
      try {
        data = JSON.parse(responseText);
      } catch (parseErr) {
        console.error('Failed to parse AI response:', responseText.slice(0, 500));
        throw new Error(`AI gateway returned invalid response (model=${modelConfig.model}): ${responseText.slice(0, 200)}`);
      }
      
      // Extract image from Lovable AI response
      const responseMessage = data.choices?.[0]?.message;
      const images = responseMessage?.images || [];
      
      if (images.length === 0) {
        console.error('No image in Lovable AI response:', JSON.stringify(data).slice(0, 500));
        const apiErr = data?.error?.message || data?.error?.code || '';
        throw new Error(`The model did not return an image (model=${modelConfig.model})${apiErr ? `: ${apiErr}` : ''}.`);
      }

      imageUrl = images[0]?.image_url?.url || '';
      description = responseMessage?.content || 'Image generated successfully';

    } else {
      // Use Google Generative Language API directly for Imagen models
      const API_KEY = Deno.env.get('GOOGLE_API_KEY') || Deno.env.get('GOOGLE_AI_STUDIO_KEY');
      if (!API_KEY) {
        throw new Error('GOOGLE_API_KEY is not configured for Imagen models');
      }

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelConfig.model}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': API_KEY,
        },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: fullPrompt }]
          }]
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Google API error:', response.status, errorText);
        throw new Error('Failed to generate image. Please try again.');
      }

      const data = await response.json();

      // Parse Google API response to find image data
      const parts = data.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find((p: any) => p.inline_data && p.inline_data.mime_type.startsWith('image/'));
      const textPart = parts.find((p: any) => p.text);

      if (!imagePart) {
        console.error('No image found in Google API response:', JSON.stringify(data).slice(0, 500));
        throw new Error('Failed to generate image. The model did not return an image.');
      }

      const base64Image = imagePart.inline_data.data;
      const mimeType = imagePart.inline_data.mime_type;
      imageUrl = `data:${mimeType};base64,${base64Image}`;
      description = textPart ? textPart.text : 'Image generated successfully';
    }

    console.log('Image generated successfully with model:', modelConfig.model);

    // Log successful image generation to system_logs
    try {
      await supabaseAdmin.from('system_logs').insert({
        level: 'info',
        category: 'ai',
        source: 'generate-image',
        message: `Image generated using ${modelConfig.model}`,
        user_id: user.id,
        metadata: {
          feature: 'image_generation',
          model_used: modelConfig.model,
          api_type: modelConfig.api,
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
    let message = 'The AI service is temporarily unavailable. Please try again later or use a different model.';

    if (lower.includes('credits')) {
      error_code = 'ai_credits_exhausted';
      message = 'AI credits exhausted. Please add credits to continue.';
    } else if (lower.includes('rate limit')) {
      error_code = 'ai_rate_limited';
      message = 'Too many requests. Please wait a moment and try again.';
    } else if (lower.includes('did not return an image') || lower.includes('no image')) {
      error_code = 'ai_no_image';
      message = 'The model could not generate an image for this prompt. Try a different prompt or model.';
    } else if (lower.includes('empty response')) {
      error_code = 'ai_gateway_empty';
      message = 'The AI service returned an empty response. Please try again.';
    } else if (lower.includes('gateway') || lower.includes('google api') || lower.includes('failed to generate')) {
      error_code = 'ai_gateway_error';
      message = 'The AI provider returned an error. Please try a different model or try again.';
    } else if (lower.includes('lovable_api_key') || lower.includes('google_api_key')) {
      error_code = 'ai_not_configured';
      message = 'AI image generation is not configured. Please contact support.';
    }

    return jsonResponse({ success: false, error_code, message }, 200);
  }
});
