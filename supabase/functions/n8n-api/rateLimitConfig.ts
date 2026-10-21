// Resolution of the rate limit that applies to one (user, endpoint) pair.
//
// The authoritative numbers live in the database so an admin can change them
// from the Rate Limits page without redeploying this function; the previous
// module-level constant survives only as the fallback for when the database is
// unreachable or holds no row. Resolution order: user override ->
// tier rate limit (per plan) -> global setting -> fallback, mirroring the
// shape generate-caption already uses.
//
// Like requestGuards.ts, this module is deliberately dependency-free and takes
// injected query functions so the whole priority order is unit-testable
// without a database.

export interface ResolvedRateLimit {
  requests: number;
  windowMs: number;
  /** false => unmetered: an admin disabled the global limit for this endpoint */
  enforced: boolean;
  source: 'user_override' | 'tier_limit' | 'global_setting' | 'fallback';
}

/** A `user_rate_limits` row, as selected by {@link fetchUserOverride}. */
export interface UserOverrideRow {
  max_requests: number | null;
  window_minutes: number | null;
  expires_at: string | null;
}

/** A `tier_rate_limits` row, as selected by {@link fetchTierLimit}. */
export interface TierLimitRow {
  max_requests_per_hour: number | null;
  max_requests_per_day: number | null;
  is_active: boolean | null;
}

/** A `rate_limit_settings` row, as selected by {@link fetchGlobalSetting}. */
export interface GlobalSettingRow {
  max_requests: number | null;
  window_minutes: number | null;
  is_active: boolean | null;
}

/**
 * In-memory fallback, kept numerically identical to the seed migration
 * 20260823120000_unify_rate_limits.sql so a DB outage or a not-yet-applied seed
 * never enforces a different limit than the admin page shows. `default` covers
 * any path the router did not recognize.
 */
export const FALLBACK_RATE_LIMITS: Record<string, { requests: number; windowMs: number }> = {
  '/api/v1/post': { requests: 60, windowMs: 60 * 60 * 1000 },
  '/api/v1/upload-media': { requests: 120, windowMs: 60 * 60 * 1000 },
  '/api/v1/posts': { requests: 300, windowMs: 60 * 60 * 1000 },
  '/api/v1/accounts': { requests: 300, windowMs: 60 * 60 * 1000 },
  '/api/v1/webhooks': { requests: 60, windowMs: 60 * 60 * 1000 },
  '/api/v1/messages/reply': { requests: 600, windowMs: 60 * 60 * 1000 },
  '/api/v1/comments/reply': { requests: 1200, windowMs: 60 * 60 * 1000 },
  '/api/v1/comments/hide': { requests: 600, windowMs: 60 * 60 * 1000 },
  '/api/v1/comments/delete': { requests: 300, windowMs: 60 * 60 * 1000 },
  '/api/v1/media': { requests: 300, windowMs: 60 * 60 * 1000 },
  // Added with the MCP post-management tools. No rate_limit_settings row seeds
  // these yet, so this map is their limit until a migration adds one.
  // The destructive ones are kept low on purpose.
  '/api/v1/posts/cancel': { requests: 60, windowMs: 60 * 60 * 1000 },
  '/api/v1/posts/reschedule': { requests: 120, windowMs: 60 * 60 * 1000 },
  // Every retry republishes the failed platforms of a post, so this budget is
  // the lowest of the post routes: a caller that retries in a loop would
  // publish the same post over and over.
  '/api/v1/posts/retry': { requests: 10, windowMs: 60 * 60 * 1000 },
  '/api/v1/accounts/health': { requests: 300, windowMs: 60 * 60 * 1000 },
  // One best-times request costs up to six paid AI calls (one per platform),
  // and suggest-best-times has no per-user AI limit of its own: 5 requests per
  // hour is at most 30 AI calls per hour.
  '/api/v1/best-times': { requests: 5, windowMs: 60 * 60 * 1000 },
  // MCP tool routes served by serviceProxy.ts. The AI budgets are deliberately
  // low; generate-caption and generate-image also enforce their own per-plan
  // limits on the user_id they receive.
  '/api/v1/comments': { requests: 300, windowMs: 60 * 60 * 1000 },
  '/api/v1/messages': { requests: 300, windowMs: 60 * 60 * 1000 },
  '/api/v1/analytics': { requests: 120, windowMs: 60 * 60 * 1000 },
  '/api/v1/ai/caption': { requests: 30, windowMs: 60 * 60 * 1000 },
  '/api/v1/ai/hashtags': { requests: 30, windowMs: 60 * 60 * 1000 },
  '/api/v1/ai/image': { requests: 10, windowMs: 60 * 60 * 1000 },
  'default': { requests: 100, windowMs: 60 * 60 * 1000 },
};

/**
 * Maps a raw request path to its canonical rate-limit key. Aliases and
 * parameterized routes share one budget per operational family, so they stop
 * falling through to `default`:
 *
 *   /api/v1/media/upload            -> /api/v1/upload-media   (alias)
 *   /api/v1/webhooks/test           -> /api/v1/webhooks       (one webhook budget)
 *   /api/v1/webhooks/<id> DELETE    -> /api/v1/webhooks
 *   /api/v1/media/<uuid> GET        -> /api/v1/media
 *   /api/v1/post/<id> GET           -> /api/v1/posts          (the READ budget)
 *
 * GET /api/v1/post/<id> maps to /api/v1/posts, NOT to /api/v1/post — the
 * latter is the 60/hr write budget for creating a post; fetching one post and
 * listing posts are the same operational family (300/hr). An unrecognised path
 * returns itself and falls to `default` at lookup time, exactly as before.
 *
 * The method is part of the match because the router pairs each of these paths
 * with exactly one method. `POST /api/v1/post/<id>` is a 404, and billing a 404
 * against the real list-posts budget would let an unroutable request eat a
 * quota it can never use. A wrong-method request keeps its raw path and falls
 * to `default`.
 */
export function rateLimitKeyForPath(path: string, method: string): string {
  // Order matters: the /api/v1/media/upload alias must win over the
  // /api/v1/media/<id> pattern below it.
  if (method === 'POST' && path === '/api/v1/media/upload') return '/api/v1/upload-media';
  if (method === 'POST' && path === '/api/v1/webhooks/test') return '/api/v1/webhooks';
  if (method === 'DELETE' && /^\/api\/v1\/webhooks\/[^/]+$/.test(path)) return '/api/v1/webhooks';
  if (method === 'GET' && /^\/api\/v1\/media\/[^/]+$/.test(path)) return '/api/v1/media';
  if (method === 'GET' && /^\/api\/v1\/post\/[^/]+$/.test(path)) return '/api/v1/posts';
  return path;
}

/**
 * A row whose numbers are not finite positive values is malformed. Honoring it
 * — especially a zero — would cap the endpoint at zero requests and lock every
 * caller out, so the resolver skips such rows and continues to the next level
 * instead of ever producing a zero-request cap. As a type guard it also
 * narrows away the nullable column types for the code that uses the numbers.
 */
function wellFormed(
  row: { max_requests: unknown; window_minutes: unknown },
): row is { max_requests: number; window_minutes: number } {
  return (
    typeof row.max_requests === 'number' && Number.isFinite(row.max_requests) && row.max_requests > 0 &&
    typeof row.window_minutes === 'number' && Number.isFinite(row.window_minutes) && row.window_minutes > 0
  );
}

/**
 * An override is live only while `expires_at IS NULL OR expires_at > now()`.
 * The exactly-now instant counts as expired (not strictly in the future), and
 * an unparseable expiry is not "in the future" either, so it expires too.
 */
function overrideLive(expiresAt: string | null): boolean {
  if (!expiresAt) return true;
  return new Date(expiresAt).getTime() > Date.now();
}

/** Query functions injected into {@link resolveRateLimit}; see the Supabase
 *  adapters below for the production implementation. */
export interface RateLimitDeps {
  fetchUserOverride: (endpointKey: string) => Promise<UserOverrideRow | null>;
  fetchPlanSlug: () => Promise<string | null>;
  fetchTierLimit: (planSlug: string, endpointKey: string) => Promise<TierLimitRow | null>;
  fetchGlobalSetting: (endpointKey: string) => Promise<GlobalSettingRow | null>;
}

/**
 * Resolves the limit for one endpoint key:
 *
 * 1. live, well-formed user override — the most specific statement an admin
 *    can make, so it outranks even a disabled global setting;
 * 2. tier rate limit for the caller's plan — only max_requests_per_hour is
 *    enforced (see the comment at the tier block below);
 * 3. global setting — `is_active = false` means unlimited (allow, enforce no
 *    cap), matching the meaning generate-caption already gives the toggle;
 * 4. the fallback map above, then `default`.
 *
 * An expired or malformed row at any level is skipped entirely and resolution
 * continues. A rejecting query is caught and logged here rather than thrown: a
 * DB error must never become a 5xx — on this deployment Cloudflare masks
 * origin 5xx — so the resolver degrades to the fallback map instead.
 */
export async function resolveRateLimit(
  endpointKey: string,
  deps: RateLimitDeps,
): Promise<ResolvedRateLimit> {
  try {
    const override = await deps.fetchUserOverride(endpointKey);
    if (override && overrideLive(override.expires_at) && wellFormed(override)) {
      return {
        requests: override.max_requests,
        windowMs: override.window_minutes * 60_000,
        enforced: true,
        source: 'user_override',
      };
    }
  } catch (error) {
    console.error(`[n8n-api] user_rate_limits lookup failed for ${endpointKey}:`, error);
  }

  // Tier limits are per (plan, endpoint). Only max_requests_per_hour is
  // enforced: checkRateLimit counts one window per request, so the daily half
  // of the row has no consumer. The admin UI says so rather than implying a
  // cap that never fires.
  try {
    const planSlug = await deps.fetchPlanSlug();
    if (planSlug) {
      const tier = await deps.fetchTierLimit(planSlug, endpointKey);
      if (
        tier && tier.is_active !== false &&
        typeof tier.max_requests_per_hour === 'number' &&
        Number.isFinite(tier.max_requests_per_hour) &&
        tier.max_requests_per_hour > 0
      ) {
        return {
          requests: tier.max_requests_per_hour,
          windowMs: 60 * 60 * 1000,
          enforced: true,
          source: 'tier_limit',
        };
      }
    }
  } catch (error) {
    console.error(`[n8n-api] tier_rate_limits lookup failed for ${endpointKey}:`, error);
  }

  try {
    const setting = await deps.fetchGlobalSetting(endpointKey);
    if (setting && wellFormed(setting)) {
      return {
        requests: setting.max_requests,
        windowMs: setting.window_minutes * 60_000,
        // Only an explicit false disables: the column is NOT NULL, so null here
        // would mean a hand-crafted row, and treating it as active is the safe
        // reading.
        enforced: setting.is_active !== false,
        source: 'global_setting',
      };
    }
  } catch (error) {
    console.error(`[n8n-api] rate_limit_settings lookup failed for ${endpointKey}:`, error);
  }

  const fallback = FALLBACK_RATE_LIMITS[endpointKey] ?? FALLBACK_RATE_LIMITS['default'];
  return { requests: fallback.requests, windowMs: fallback.windowMs, enforced: true, source: 'fallback' };
}

// Thin Supabase adapters, exported separately from the resolver so tests can
// assert the exact filters they pass against a stub client. The query shape is
// part of the contract: a typo'd filter would match nothing, the resolver would
// fall through, and limits would silently stop being admin-editable.

export async function fetchUserOverride(
  supabase: any,
  userId: string,
  endpointKey: string,
): Promise<UserOverrideRow | null> {
  const { data, error } = await supabase
    .from('user_rate_limits')
    .select('max_requests, window_minutes, expires_at')
    .eq('user_id', userId)
    .eq('endpoint', endpointKey)
    .maybeSingle();
  if (error) throw new Error(`user_rate_limits lookup failed: ${error.message}`);
  return data ?? null;
}

export async function fetchGlobalSetting(
  supabase: any,
  endpointKey: string,
): Promise<GlobalSettingRow | null> {
  const { data, error } = await supabase
    .from('rate_limit_settings')
    .select('max_requests, window_minutes, is_active')
    .eq('endpoint', endpointKey)
    .maybeSingle();
  if (error) throw new Error(`rate_limit_settings lookup failed: ${error.message}`);
  return data ?? null;
}

/**
 * Resolves the caller's plan slug from their active/past_due subscription. A
 * caller with no entitling subscription row is a Free user, not a plan-less
 * one — most free users have no user_subscriptions row at all — so a missing
 * row resolves 'free' (amendment A7) rather than null, keeping the free tier
 * limits in play for exactly the population they are meant to constrain.
 *
 * Round-2 fix (final review C1): 'past_due' counts as entitling here too,
 * matching effective_user_quotas() — dunning must not drop a paying
 * customer's rate limit tier to free. Filtering on IN(...) instead of a
 * single .eq() can return more than one row, so the ORDER BY + LIMIT 1
 * mirrors the SQL arbiter's own three-part deterministic tie-break
 * (20260823140100_effective_user_quotas.sql); without it, a user with both
 * an active and a past_due row would make maybeSingle() throw and this
 * function would fall through to 'free'.
 */
export async function fetchPlanSlug(supabase: any, userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('user_subscriptions')
    .select('subscription_plans(slug)')
    .eq('user_id', userId)
    .in('status', ['active', 'past_due'])
    .order('current_period_end', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`user_subscriptions lookup failed: ${error.message}`);
  return data?.subscription_plans?.slug ?? 'free';
}

export async function fetchTierLimit(
  supabase: any,
  planSlug: string,
  endpointKey: string,
): Promise<TierLimitRow | null> {
  const { data, error } = await supabase
    .from('tier_rate_limits')
    .select('max_requests_per_hour, max_requests_per_day, is_active')
    .eq('plan_slug', planSlug)
    .eq('endpoint', endpointKey)
    .maybeSingle();
  if (error) throw new Error(`tier_rate_limits lookup failed: ${error.message}`);
  return data ?? null;
}
