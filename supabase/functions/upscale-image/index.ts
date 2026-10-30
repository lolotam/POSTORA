import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCorsOptions, jsonResponse, errorResponse, unauthorizedResponse } from "../_shared/cors.ts";
import {
  PROVIDER_UNAVAILABLE_CODE,
  UPSCALE_UNAVAILABLE_MESSAGE,
  resolveCloudinaryUsable,
  resolveUpscaleProvider,
} from "../_shared/aiImageProviders.ts";
import { runAtlasImageJob } from "../_shared/aiImageJob.ts";
import { logImageTool, readImageInput, toDataUri, toolFailureResponse } from "../_shared/aiImageIo.ts";
import { getOpeninaryConfig } from "../_shared/openinary.ts";

const CLOUDINARY_CLOUD_NAME = Deno.env.get('CLOUDINARY_CLOUD_NAME');
const CLOUDINARY_API_KEY = Deno.env.get('CLOUDINARY_API_KEY');
const CLOUDINARY_API_SECRET = Deno.env.get('CLOUDINARY_API_SECRET');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return handleCorsOptions();
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    let userId: string;

    // Check for API key first (for external API access)
    const apiKey = req.headers.get('x-api-key') || '';
    const authHeader = req.headers.get('authorization') || '';

    if (apiKey && apiKey.startsWith('postora-')) {
      // Validate API key and get user
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('id, email')
        .eq('api_key', apiKey)
        .single();

      if (profileError || !profile) {
        console.error('API key validation failed:', profileError);
        return unauthorizedResponse('Invalid API key');
      }
      userId = profile.id;
    } else if (authHeader.startsWith('Bearer ')) {
      // JWT auth from browser session
      const token = authHeader.replace('Bearer ', '');
      const supabaseWithAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${token}` } }
      });

      const { data: { user }, error: userError } = await supabaseWithAuth.auth.getUser();

      if (userError || !user) {
        console.error('JWT validation failed:', userError);
        return unauthorizedResponse('Invalid or expired session');
      }
      userId = user.id;
    } else {
      return unauthorizedResponse('Missing authentication');
    }

    const parsed = await readImageInput(req);
    if (!parsed.ok) return toolFailureResponse(parsed.status, 'INVALID_INPUT', parsed.message);
    const { input, fields } = parsed;

    const scale = Math.min(4, Math.max(1, Math.trunc(Number(fields.scale)) || 2)); // default 2x

    // Which provider serves this request follows the admin CDN policy, not env presence:
    // a disabled Cloudinary account keeps its credentials.
    const dbAdmin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
    const atlasApiKey = Deno.env.get('ATLASCLOUD_API_KEY') ?? '';
    const decision = resolveUpscaleProvider({
      requested: fields.platform,
      cloudinaryUsable: await resolveCloudinaryUsable(dbAdmin),
      atlasConfigured: atlasApiKey !== '',
    });
    if (!decision.ok) {
      logImageTool('error', 'ai_image_provider_unavailable', { operation: 'upscale', user_id: userId, reason: decision.reason });
      return toolFailureResponse(503, PROVIDER_UNAVAILABLE_CODE, decision.message);
    }
    if (decision.fellBackFromCloudinary) {
      logImageTool('warn', 'ai_image_provider_fallback', { operation: 'upscale', user_id: userId, from: 'cloudinary', to: 'atlascloud' });
    }
    console.log(`Upscale request - Provider: ${decision.provider}, Scale: ${scale}x`);

    const originalUrl = input.kind === 'url' ? input.url : 'base64_upload';

    if (decision.provider === 'atlascloud') {
      // Determine target resolution based on scale
      const targetResolution = scale <= 2 ? '2k' : '4k';
      console.log(`Starting AtlasCloud upscale: ${targetResolution}`);

      const job = await runAtlasImageJob({
        operation: 'upscale',
        userId,
        input,
        openinary: getOpeninaryConfig(),
        atlasApiKey,
        buildBody: (sourceUrl) => ({
          model: 'atlascloud/image-upscaler',
          image: sourceUrl,
          creativity: 2,
          output_format: 'jpeg',
          enable_sync_mode: false,
          target_resolution: targetResolution,
          enable_base64_output: false,
        }),
        area: 'upscaled',
        messages: {
          unavailable: UPSCALE_UNAVAILABLE_MESSAGE,
          busy: 'Upscaling is busy. Please wait a moment and try again.',
          timeout: 'Upscaling timed out. Please try again.',
          failed: 'Upscaling failed. Please try again.',
        },
        failureCode: 'UPSCALE_FAILED',
      });
      if (!job.ok) return toolFailureResponse(job.status, job.code, job.message);

      return jsonResponse({
        success: true,
        original_url: originalUrl,
        upscaled_url: job.resultUrl,
        prediction_id: job.predictionId,
        target_resolution: targetResolution,
        scale: scale,
        platform: 'atlascloud',
        stored_in: job.storedIn,
        ...(decision.fellBackFromCloudinary ? { requested_platform: 'cloudinary' } : {}),
      });
    }

    // Cloudinary upscaling: only reached while the admin policy still writes to Cloudinary.
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = `postora/${userId}/upscaled`;

    // Create signature for Cloudinary
    const signParams = `folder=${folder}&timestamp=${timestamp}${CLOUDINARY_API_SECRET}`;
    const encoder = new TextEncoder();
    const data = encoder.encode(signParams);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const signature = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    // Build upload form data
    const uploadFormData = new FormData();
    uploadFormData.append('api_key', CLOUDINARY_API_KEY ?? '');
    uploadFormData.append('timestamp', timestamp.toString());
    uploadFormData.append('signature', signature);
    uploadFormData.append('folder', folder);
    uploadFormData.append('file', input.kind === 'url' ? input.url : toDataUri(input));

    console.log(`Uploading to Cloudinary for ${scale}x upscaling...`);

    const cloudinaryResponse = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
      {
        method: 'POST',
        body: uploadFormData,
      }
    );

    if (!cloudinaryResponse.ok) {
      const errorText = await cloudinaryResponse.text();
      console.error('Cloudinary error:', errorText);
      return errorResponse(`Upscale upload failed: ${errorText}`, 500);
    }

    const cloudinaryData = await cloudinaryResponse.json();
    console.log('Upload successful:', cloudinaryData.public_id);

    // Generate the upscaled URL using Cloudinary's AI upscaling
    const upscaledUrl = cloudinaryData.secure_url.replace(
      '/upload/',
      `/upload/e_upscale,w_${cloudinaryData.width * scale},h_${cloudinaryData.height * scale}/`
    );

    // Also provide standard quality enhance option
    const enhancedUrl = cloudinaryData.secure_url.replace(
      '/upload/',
      '/upload/e_improve,e_sharpen/'
    );

    return jsonResponse({
      success: true,
      original_url: originalUrl,
      upscaled_url: upscaledUrl,
      enhanced_url: enhancedUrl,
      public_id: cloudinaryData.public_id,
      original_width: cloudinaryData.width,
      original_height: cloudinaryData.height,
      upscaled_width: cloudinaryData.width * scale,
      upscaled_height: cloudinaryData.height * scale,
      scale: scale,
      platform: 'cloudinary',
      format: cloudinaryData.format,
    });

  } catch (error) {
    console.error('Upscale image error:', error);
    return errorResponse(error instanceof Error ? error.message : 'Internal server error', 500);
  }
});
