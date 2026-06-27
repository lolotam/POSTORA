import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────
// P2-4: RPC-based atomic rate limiter (rate_limit_buckets table)
// ─────────────────────────────────────────────────────────────────────
// Unlike the legacy api_logs COUNT approach above, this uses a dedicated
// table + stored function for O(1) atomic check-and-increment. Designed
// for security-critical endpoints (send-reset-otp, manage-backup-codes).

export interface RpcRateLimitResult {
  allowed: boolean;
  count: number;
  remaining: number;
  retryAfter: number;
}

function getClientIp(req: Request): string {
  return (
    req.headers.get("CF-Connecting-IP") ??
    req.headers.get("X-Real-IP") ??
    req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

async function checkRateLimitRpc(
  supabaseAdmin: SupabaseClient,
  endpoint: string,
  identifier: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<RpcRateLimitResult> {
  try {
    const { data, error } = await supabaseAdmin.rpc("check_rate_limit", {
      p_endpoint: endpoint,
      p_identifier: identifier,
      p_max_requests: maxRequests,
      p_window_seconds: windowSeconds,
    });

    if (error) {
      console.error(`[rate-limiter] RPC error on ${endpoint}:`, error);
      return { allowed: true, count: 0, remaining: maxRequests, retryAfter: 0 };
    }
    return (data ?? { allowed: true, count: 0, remaining: maxRequests, retryAfter: 0 }) as RpcRateLimitResult;
  } catch (err) {
    console.error(`[rate-limiter] error on ${endpoint}:`, err);
    return { allowed: true, count: 0, remaining: maxRequests, retryAfter: 0 };
  }
}

export async function checkIpRateLimit(
  supabaseAdmin: SupabaseClient,
  endpoint: string,
  req: Request,
  maxRequests: number,
  windowSeconds: number,
): Promise<RpcRateLimitResult> {
  const ip = getClientIp(req);
  return checkRateLimitRpc(supabaseAdmin, endpoint, ip, maxRequests, windowSeconds);
}

export async function checkUserRateLimit(
  supabaseAdmin: SupabaseClient,
  endpoint: string,
  userId: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<RpcRateLimitResult> {
  return checkRateLimitRpc(supabaseAdmin, endpoint, `user:${userId}`, maxRequests, windowSeconds);
}

export function rateLimitExceededResponse(
  result: RpcRateLimitResult,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify({ error: "Too many requests. Please try again later." }),
    {
      status: 429,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Retry-After": String(result.retryAfter),
        "X-RateLimit-Remaining": "0",
      },
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Legacy api_logs-based rate limiter (retained for backward compat)
// ─────────────────────────────────────────────────────────────────────

interface RateLimitConfig {
  endpoint: string;
  maxRequests: number;
  windowMs: number; // Time window in milliseconds
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  retryAfter?: number; // seconds until rate limit resets
}

// Default rate limits for different endpoint types
export const RATE_LIMITS: Record<string, RateLimitConfig> = {
  // High-frequency endpoints
  'post-create': { endpoint: 'post-create', maxRequests: 10, windowMs: 60000 }, // 10 per minute
  'media-upload': { endpoint: 'media-upload', maxRequests: 20, windowMs: 60000 }, // 20 per minute
  
  // AI endpoints (expensive)
  'generate-caption': { endpoint: 'generate-caption', maxRequests: 20, windowMs: 3600000 }, // 20 per hour
  'generate-hashtags': { endpoint: 'generate-hashtags', maxRequests: 30, windowMs: 3600000 }, // 30 per hour
  'generate-image': { endpoint: 'generate-image', maxRequests: 10, windowMs: 3600000 }, // 10 per hour
  
  // OAuth endpoints
  'oauth': { endpoint: 'oauth', maxRequests: 20, windowMs: 300000 }, // 20 per 5 minutes
  
  // API endpoints (for n8n/external)
  'api-post': { endpoint: 'api-post', maxRequests: 100, windowMs: 3600000 }, // 100 per hour
  'api-upload': { endpoint: 'api-upload', maxRequests: 50, windowMs: 3600000 }, // 50 per hour
  'api-accounts': { endpoint: 'api-accounts', maxRequests: 200, windowMs: 3600000 }, // 200 per hour
  
  // Default for unspecified endpoints
  'default': { endpoint: 'default', maxRequests: 60, windowMs: 60000 }, // 60 per minute
};

/**
 * Check rate limit for a user on a specific endpoint
 */
export async function checkRateLimit(
  supabaseAdmin: SupabaseClient,
  userId: string,
  endpoint: string,
  ipAddress?: string
): Promise<RateLimitResult> {
  const config = RATE_LIMITS[endpoint] || RATE_LIMITS['default'];
  const windowStart = new Date(Date.now() - config.windowMs);
  
  try {
    // Count requests in the current window
    const { count, error } = await supabaseAdmin
      .from('api_logs')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('endpoint', endpoint)
      .gte('created_at', windowStart.toISOString());
    
    if (error) {
      console.error('Rate limit check error:', error);
      // Allow request on error (fail open for availability)
      return {
        allowed: true,
        remaining: config.maxRequests,
        resetAt: new Date(Date.now() + config.windowMs),
      };
    }
    
    const currentCount = count || 0;
    const remaining = Math.max(0, config.maxRequests - currentCount);
    const allowed = currentCount < config.maxRequests;
    const resetAt = new Date(Date.now() + config.windowMs);
    
    return {
      allowed,
      remaining,
      resetAt,
      retryAfter: allowed ? undefined : Math.ceil(config.windowMs / 1000),
    };
  } catch (err) {
    console.error('Rate limit error:', err);
    // Fail open
    return {
      allowed: true,
      remaining: config.maxRequests,
      resetAt: new Date(Date.now() + config.windowMs),
    };
  }
}

/**
 * Log an API request for rate limiting purposes
 */
export async function logApiRequest(
  supabaseAdmin: SupabaseClient,
  userId: string,
  endpoint: string,
  method: string,
  statusCode: number,
  requestData?: Record<string, unknown>,
  responseData?: Record<string, unknown>,
  ipAddress?: string,
  userAgent?: string
): Promise<void> {
  try {
    await supabaseAdmin.from('api_logs').insert({
      user_id: userId,
      endpoint,
      method,
      status_code: statusCode,
      request_data: requestData || null,
      response_data: responseData || null,
      ip_address: ipAddress || '0.0.0.0',
      user_agent: userAgent || null,
    });
  } catch (err) {
    console.error('Failed to log API request:', err);
  }
}

/**
 * Create rate limit response headers
 */
export function createRateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(RATE_LIMITS['default'].maxRequests),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(Math.floor(result.resetAt.getTime() / 1000)),
    ...(result.retryAfter ? { 'Retry-After': String(result.retryAfter) } : {}),
  };
}

/**
 * Helper to create a rate limit exceeded response
 */
export function createRateLimitResponse(result: RateLimitResult): Response {
  return new Response(
    JSON.stringify({
      error: 'Rate limit exceeded',
      message: `Too many requests. Please try again in ${result.retryAfter} seconds.`,
      retryAfter: result.retryAfter,
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        ...createRateLimitHeaders(result),
      },
    }
  );
}

/**
 * Middleware function to apply rate limiting
 */
export async function withRateLimit(
  supabaseAdmin: SupabaseClient,
  userId: string,
  endpoint: string,
  handler: () => Promise<Response>,
  ipAddress?: string
): Promise<Response> {
  const rateLimitResult = await checkRateLimit(supabaseAdmin, userId, endpoint, ipAddress);
  
  if (!rateLimitResult.allowed) {
    return createRateLimitResponse(rateLimitResult);
  }
  
  const response = await handler();
  
  // Add rate limit headers to the response
  const headers = new Headers(response.headers);
  const rateLimitHeaders = createRateLimitHeaders(rateLimitResult);
  Object.entries(rateLimitHeaders).forEach(([key, value]) => {
    headers.set(key, value);
  });
  
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
