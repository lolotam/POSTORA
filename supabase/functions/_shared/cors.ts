/**
 * Shared CORS headers for Supabase Edge Functions
 * Import this in your edge functions for consistent CORS handling
 * 
 * @example
 * import { corsHeaders, handleCorsOptions } from "../_shared/cors.ts";
 * 
 * serve(async (req) => {
 *   // Handle CORS preflight
 *   if (req.method === 'OPTIONS') {
 *     return handleCorsOptions();
 *   }
 *   
 *   // Your logic here...
 *   
 *   return new Response(JSON.stringify(data), {
 *     headers: { ...corsHeaders, 'Content-Type': 'application/json' }
 *   });
 * });
 */

/**
 * Standard CORS headers for edge functions
 */
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE',
};

/**
 * Handle CORS OPTIONS preflight request
 * @returns Response with CORS headers and 200 status
 */
export function handleCorsOptions(): Response {
  return new Response(null, { headers: corsHeaders });
}

/**
 * Create a JSON response with CORS headers
 * @param data - Data to serialize as JSON
 * @param status - HTTP status code (default: 200)
 * @returns Response with JSON body and CORS headers
 */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/**
 * Create an error response with CORS headers
 * @param message - Error message
 * @param status - HTTP status code (default: 500)
 * @returns Response with error JSON and CORS headers
 */
export function errorResponse(message: string, status = 500): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/**
 * Create an unauthorized response
 * @param message - Error message (default: "Unauthorized")
 * @returns Response with 401 status and CORS headers
 */
export function unauthorizedResponse(message = "Unauthorized"): Response {
  return errorResponse(message, 401);
}

/**
 * Create a bad request response
 * @param message - Error message (default: "Bad Request")
 * @returns Response with 400 status and CORS headers
 */
export function badRequestResponse(message = "Bad Request"): Response {
  return errorResponse(message, 400);
}

/**
 * Create a JSON response with CORS + Cache-Control headers
 * Use for semi-static data (feature flags, public config) that can be cached by CDN
 * @param data - Data to serialize as JSON
 * @param maxAge - Cache duration in seconds (default: 300 = 5 minutes)
 * @param status - HTTP status code (default: 200)
 * @returns Response with JSON body, CORS headers, and Cache-Control
 */
export function cacheableJsonResponse(data: unknown, maxAge = 300, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${maxAge}, s-maxage=${maxAge}`,
    },
  });
}

/**
 * RESTRICTED CORS (P2-2). Use on admin / auth-adjacent / credentialed endpoints
 * (manage-*, ai-config, test-ai-model, backfill-subscription, n8n-api, send-reset-otp,
 * verify-mfa-reset, manage-backup-codes, observability-alerts, notify-*,
 * send-token-expiry-notifications, and the *-oauth callbacks).
 *
 * Unlike `corsHeaders` (which returns `Access-Control-Allow-Origin: *`), this reflects the
 * request's Origin ONLY when it is on the allow-list, and emits `Vary: Origin`. When the
 * Origin is absent (same-origin / server-to-server) it falls back to the primary production
 * origin so legitimate callers still work. When Origin is present but not allowed, no
 * `Access-Control-Allow-Origin` header is emitted, so browsers block the read.
 *
 * Public provider webhooks (stripe-webhook, tiktok-webhook, whatsapp-webhook, resend-webhook)
 * must NOT use this — providers do not send an Origin, and they should keep `corsHeaders` (`*`).
 */

const PRODUCTION_ORIGINS = [
  'https://postora.cloud',
  'https://www.postora.cloud',
] as const;

const DEVELOPMENT_ORIGINS = [
  'http://localhost:8080',
  'http://127.0.0.1:8080',
] as const;

// Lovable preview/staging hosts, e.g. https://preview--<project>.lovable.app or
// https://<project>.lovable.app. Kept as a regex so branch previews keep working.
const LOVABLE_HOST_RE = /^https:\/\/(?:preview--)?[a-z0-9-]+\.lovable\.app$/;

function configuredAllowedOrigins(): readonly string[] {
  // Optional comma-separated override/addition via env. Lets ops grant a new origin
  // (e.g. a fresh Lovable branch or a staging domain) without a redeploy.
  const extra = Deno.env.get('ALLOWED_ORIGINS');
  if (extra && extra.trim()) {
    return extra
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
  }
  return [...PRODUCTION_ORIGINS, ...DEVELOPMENT_ORIGINS];
}

function isAllowedOrigin(origin: string): boolean {
  if (configuredAllowedOrigins().includes(origin)) return true;
  return LOVABLE_HOST_RE.test(origin);
}

export function restrictedCorsHeaders(req: Request): Record<string, string> {
  const base: Record<string, string> = {
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    Vary: 'Origin',
  };
  const origin = req.headers.get('Origin');
  if (!origin) {
    // Same-origin or non-browser caller: echo the primary production origin.
    return { ...base, 'Access-Control-Allow-Origin': PRODUCTION_ORIGINS[0] };
  }
  if (isAllowedOrigin(origin)) {
    return { ...base, 'Access-Control-Allow-Origin': origin };
  }
  // Unknown origin: omit Access-Control-Allow-Origin entirely so browsers block the read.
  return base;
}

/** Preflight handler for restricted endpoints. 204 + restricted headers. */
export function handleRestrictedCorsOptions(req: Request): Response {
  return new Response(null, { status: 204, headers: restrictedCorsHeaders(req) });
}

/** JSON response bound to restricted CORS headers (use on sensitive endpoints). */
export function restrictedJsonResponse(
  req: Request,
  data: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...restrictedCorsHeaders(req), 'Content-Type': 'application/json' },
  });
}

/** Error response bound to restricted CORS headers. */
export function restrictedErrorResponse(
  req: Request,
  message: string,
  status = 500,
): Response {
  return restrictedJsonResponse(req, { error: message }, status);
}
