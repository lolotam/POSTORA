// Use 'any' for SupabaseClient to avoid version mismatch issues between edge functions
// deno-lint-ignore-file no-explicit-any

// ─────────────────────────────────────────────────────────────────────
// P3-4: Sensitive data redactor
// ─────────────────────────────────────────────────────────────────────
// Recursively scans objects/arrays for keys matching sensitive patterns
// and replaces their values with [REDACTED]. Also redacts long hex/base64
// strings and Bearer tokens that slip into values.

const SENSITIVE_KEY_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /api[-_]?key/i,
  /^key$/i,
  /otp/i,
  /code[-_]?hash/i,
  /bearer/i,
  /authorization/i,
  /private[-_]?key/i,
  /service[-_]?role/i,
  /cron[-_]?secret/i,
  /webhook[-_]?secret/i,
  /pepper/i,
  /cookie/i,
  /session[-_]?id/i,
];

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 10;

export function redactSensitive(data: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (typeof data === "string") {
    if (data.length >= 64 && /^[a-f0-9]+$/i.test(data)) return REDACTED;
    if (/^Bearer\s+\S/i.test(data)) return REDACTED;
    return data;
  }
  if (Array.isArray(data)) {
    return data.map((item) => redactSensitive(item, depth + 1));
  }
  if (data !== null && typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (SENSITIVE_KEY_PATTERNS.some((p) => p.test(key))) {
        result[key] = REDACTED;
      } else {
        result[key] = redactSensitive(value, depth + 1);
      }
    }
    return result;
  }
  return data;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogCategory = 'auth' | 'edge' | 'database' | 'token' | 'post' | 'system';

export interface LogEntry {
  level: LogLevel;
  category: LogCategory;
  source: string;
  message: string;
  user_id?: string;
  metadata?: Record<string, unknown>;
}

export interface UserContext {
  email?: string;
  full_name?: string;
  plan?: string;
}

// Simple in-memory cache for user context within a single request
const userContextCache = new Map<string, UserContext>();

/**
 * Fetch user context (email, name, plan) from profiles table
 * Caches results within the request lifecycle
 */
export async function fetchUserContext(
  supabaseAdmin: any,
  userId: string
): Promise<UserContext | null> {
  if (!userId) return null;

  // Check cache first
  if (userContextCache.has(userId)) {
    return userContextCache.get(userId)!;
  }

  try {
    // Fetch profile
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('email, full_name')
      .eq('id', userId)
      .maybeSingle();

    // Fetch subscription plan
    const { data: subscription } = await supabaseAdmin
      .from('user_subscriptions')
      .select('subscription_plans(name, slug)')
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle();

    // Fetch user role
    const { data: userRole } = await supabaseAdmin
      .from('user_roles')
      .select('role')
      .eq('user_id', userId)
      .maybeSingle();

    // Determine plan display: Admin role > Active subscription > Role name > Free
    let planName: string;
    if (userRole?.role === 'admin') {
      planName = 'Admin';
    } else if (subscription?.subscription_plans?.name) {
      planName = subscription.subscription_plans.name;
    } else if (userRole?.role === 'subscriber') {
      planName = 'Subscriber';
    } else {
      planName = 'Free';
    }

    const context: UserContext = {
      email: profile?.email || undefined,
      full_name: profile?.full_name || undefined,
      plan: planName,
    };

    userContextCache.set(userId, context);
    return context;
  } catch (err) {
    console.error('Failed to fetch user context:', err);
    return null;
  }
}

/**
 * Log an entry to the system_logs table
 * Automatically enriches metadata with user context when user_id is provided
 */
export async function logToDatabase(
  supabaseAdmin: any,
  entry: LogEntry
): Promise<void> {
  try {
    // Enrich metadata with user context if user_id is available
    let enrichedMetadata = entry.metadata || {};

    if (entry.user_id) {
      const userContext = await fetchUserContext(supabaseAdmin, entry.user_id);
      if (userContext) {
        enrichedMetadata = {
          ...enrichedMetadata,
          user: userContext,
        };
      }
    }

    const { error } = await supabaseAdmin
      .from('system_logs')
      .insert({
        level: entry.level,
        category: entry.category,
        source: entry.source,
        message: entry.message,
        user_id: entry.user_id || null,
        metadata: redactSensitive(enrichedMetadata) as Record<string, unknown>,
      });

    if (error) {
      console.error('Failed to write log to database:', error);
    }
  } catch (err) {
    console.error('Error logging to database:', err);
  }
}

/**
 * Create a logger instance for an edge function
 */
export function createLogger(supabaseAdmin: any, source: string, category: LogCategory = 'edge') {
  return {
    debug: (message: string, metadata?: Record<string, unknown>, user_id?: string) => {
      console.log(`[DEBUG] ${source}: ${message}`);
      return logToDatabase(supabaseAdmin, { level: 'debug', category, source, message, metadata, user_id });
    },
    info: (message: string, metadata?: Record<string, unknown>, user_id?: string) => {
      console.log(`[INFO] ${source}: ${message}`);
      return logToDatabase(supabaseAdmin, { level: 'info', category, source, message, metadata, user_id });
    },
    warn: (message: string, metadata?: Record<string, unknown>, user_id?: string) => {
      console.warn(`[WARN] ${source}: ${message}`);
      return logToDatabase(supabaseAdmin, { level: 'warn', category, source, message, metadata, user_id });
    },
    error: (message: string, metadata?: Record<string, unknown>, user_id?: string) => {
      console.error(`[ERROR] ${source}: ${message}`);
      return logToDatabase(supabaseAdmin, { level: 'error', category, source, message, metadata, user_id });
    },
  };
}

/**
 * Log token refresh events specifically
 */
export async function logTokenEvent(
  supabaseAdmin: any,
  event: 'refresh_success' | 'refresh_failed' | 'refresh_started' | 'expired',
  platform: string,
  accountId: string,
  userId?: string,
  errorMessage?: string
): Promise<void> {
  const level: LogLevel = event === 'refresh_failed' || event === 'expired' ? 'error' : 'info';
  const message = event === 'refresh_success' 
    ? `Token refreshed successfully for ${platform}`
    : event === 'refresh_failed'
    ? `Token refresh failed for ${platform}: ${errorMessage || 'Unknown error'}`
    : event === 'expired'
    ? `Token expired for ${platform}`
    : `Token refresh started for ${platform}`;

  await logToDatabase(supabaseAdmin, {
    level,
    category: 'token',
    source: 'refresh-tokens',
    message,
    user_id: userId,
    metadata: {
      event,
      platform,
      account_id: accountId,
      error: errorMessage,
    },
  });
}

/**
 * Log post-related events
 */
export async function logPostEvent(
  supabaseAdmin: any,
  event: 'post_started' | 'post_success' | 'post_failed' | 'post_scheduled',
  postId: string,
  userId: string,
  platforms: string[],
  errorMessage?: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  const level: LogLevel = event === 'post_failed' ? 'error' : 'info';
  const message = event === 'post_success'
    ? `Post published successfully to ${platforms.join(', ')}`
    : event === 'post_failed'
    ? `Post failed: ${errorMessage || 'Unknown error'}`
    : event === 'post_scheduled'
    ? `Post scheduled for ${platforms.join(', ')}`
    : `Post processing started for ${platforms.join(', ')}`;

  await logToDatabase(supabaseAdmin, {
    level,
    category: 'post',
    source: 'process-post',
    message,
    user_id: userId,
    metadata: {
      event,
      post_id: postId,
      platforms,
      error: errorMessage,
      ...metadata,
    },
  });
}

/**
 * Log authentication events
 */
export async function logAuthEvent(
  supabaseAdmin: any,
  event: 'login' | 'logout' | 'signup' | 'password_reset' | 'email_verified' | 'mfa_enabled' | 'mfa_disabled',
  userId?: string,
  email?: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  const level: LogLevel = 'info';
  const message = event === 'login'
    ? `User logged in${email ? `: ${email}` : ''}`
    : event === 'logout'
    ? `User logged out`
    : event === 'signup'
    ? `New user signed up${email ? `: ${email}` : ''}`
    : event === 'password_reset'
    ? `Password reset requested${email ? ` for ${email}` : ''}`
    : event === 'email_verified'
    ? `Email verified${email ? `: ${email}` : ''}`
    : event === 'mfa_enabled'
    ? `MFA enabled for user`
    : `MFA disabled for user`;

  await logToDatabase(supabaseAdmin, {
    level,
    category: 'auth',
    source: 'auth-webhook',
    message,
    user_id: userId,
    metadata: {
      event,
      email,
      ...metadata,
    },
  });
}
