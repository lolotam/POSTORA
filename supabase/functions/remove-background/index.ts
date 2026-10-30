import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCorsOptions, jsonResponse, errorResponse, unauthorizedResponse } from "../_shared/cors.ts";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import {
  BACKGROUND_REMOVAL_UNAVAILABLE_MESSAGE,
  resolveBackgroundRemovalProvider,
  resolveCloudinaryUsable,
} from "../_shared/aiImageProviders.ts";
import { imageInputFrom, parseToolRequest, pngSize, resumeTokenOf, toDataUri } from "../_shared/aiImageIo.ts";
import {
  invalidInput,
  providerUnavailable,
  readRouteEnv,
  resumeAtlasRoute,
  startAtlasRoute,
  type AtlasRoute,
} from "../_shared/aiImageAtlasRoute.ts";

const CLOUDINARY_CLOUD_NAME = Deno.env.get('CLOUDINARY_CLOUD_NAME');
const CLOUDINARY_API_KEY = Deno.env.get('CLOUDINARY_API_KEY');
const CLOUDINARY_API_SECRET = Deno.env.get('CLOUDINARY_API_SECRET');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

/** AtlasCloud background-removal model; an env override means a deprecation is not a deploy. */
const DEFAULT_ATLAS_BG_REMOVAL_MODEL = 'midjourney/v8.2/remove-background';

const ROUTE: AtlasRoute = {
  source: 'remove-background',
  operation: 'background_removal',
  area: 'processed',
  failureCode: 'BACKGROUND_REMOVAL_FAILED',
  wantOutputDetails: true,
  messages: {
    unavailable: BACKGROUND_REMOVAL_UNAVAILABLE_MESSAGE,
    busy: 'Background removal is busy. Please wait a moment and try again.',
    timeout: 'Background removal timed out. Please try again.',
    failed: 'Background removal failed. Please try again.',
  },
  completedBody: (job) => {
    const size = job.output ? pngSize(job.output.bytes) : null;
    return {
      success: true,
      original_url: job.meta.original_url ?? null,
      processed_url: job.resultUrl,
      public_id: job.storedPath,
      width: size?.width ?? null,
      height: size?.height ?? null,
      format: job.output?.extension ?? null,
      bytes: job.output?.bytes.length ?? null,
      platform: 'atlascloud',
      stored_in: job.storedIn,
    };
  },
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return handleCorsOptions();
  }

  try {
    const startedAt = Date.now();
    // Get API key from headers
    const apiKey = req.headers.get('x-api-key') ||
                   req.headers.get('authorization')?.replace(/^(Bearer |Apikey )/i, '') || '';

    let userId: string;

    if (apiKey.startsWith('postora-')) {
      // Validate API key and get user
      const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
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
    } else if (req.headers.get('authorization')?.startsWith('Bearer ')) {
      // Browser session (the app's own image tools)
      try {
        userId = (await authenticateCaller(req)).userId;
      } catch {
        return unauthorizedResponse('Invalid or expired session');
      }
    } else {
      return unauthorizedResponse('Invalid or missing API key');
    }

    // Which provider serves this request follows the admin CDN policy, not env presence:
    // a disabled Cloudinary account keeps its credentials.
    const dbAdmin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
    const caller = { db: dbAdmin, userId, startedAt };

    const body = await parseToolRequest(req);
    if (!body.ok) return await invalidInput(ROUTE, caller, body.status, body.message);

    // A follow-up for a job that was still running when the first request had to answer.
    const resumeToken = resumeTokenOf(body.fields);
    if (resumeToken) return await resumeAtlasRoute(ROUTE, caller, readRouteEnv(), resumeToken);

    const parsed = await imageInputFrom(body);
    if (!parsed.ok) return await invalidInput(ROUTE, caller, parsed.status, parsed.message);
    const { input } = parsed;

    const env = readRouteEnv();
    const decision = resolveBackgroundRemovalProvider({
      cloudinaryUsable: await resolveCloudinaryUsable(dbAdmin),
      atlasConfigured: env.atlasApiKey !== '',
    });
    if (!decision.ok) return await providerUnavailable(ROUTE, caller, decision.message, decision.reason);

    const originalUrl = input.kind === 'url' ? input.url : 'base64_upload';

    if (decision.provider === 'atlascloud') {
      return await startAtlasRoute(ROUTE, caller, env, {
        input,
        buildBody: (sourceUrl) => ({
          model: Deno.env.get('ATLASCLOUD_BG_REMOVAL_MODEL') || DEFAULT_ATLAS_BG_REMOVAL_MODEL,
          image: sourceUrl,
          enable_base64_output: false,
        }),
        meta: { original_url: originalUrl },
      });
    }

    // Cloudinary background removal: only reached while the admin policy still writes to Cloudinary.
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = `postora/${userId}/processed`;

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
    uploadFormData.append('background_removal', 'cloudinary_ai');
    uploadFormData.append('file', input.kind === 'url' ? input.url : toDataUri(input));

    console.log('Uploading to Cloudinary with background removal...');

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
      return errorResponse(`Background removal failed: ${errorText}`, 500);
    }

    const cloudinaryData = await cloudinaryResponse.json();
    console.log('Background removal successful:', cloudinaryData.public_id);

    // Generate the URL with background removal transformation applied
    const processedUrl = cloudinaryData.secure_url.replace('/upload/', '/upload/e_background_removal/');

    return jsonResponse({
      success: true,
      original_url: originalUrl,
      processed_url: processedUrl,
      public_id: cloudinaryData.public_id,
      width: cloudinaryData.width,
      height: cloudinaryData.height,
      format: cloudinaryData.format,
      bytes: cloudinaryData.bytes,
      platform: 'cloudinary',
    });

  } catch (error) {
    console.error('Remove background error:', error);
    return errorResponse(error instanceof Error ? error.message : 'Internal server error', 500);
  }
});
