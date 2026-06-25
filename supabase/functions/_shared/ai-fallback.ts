import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";

export interface AiEndpoint {
  apiUrl: string;
  apiKey: string;
  headers: Record<string, string>;
}

export interface AiTierResult {
  tier: 'primary' | 'fallback' | 'last_resort';
  provider: string;
  model: string;
  status: number;
  error?: string;
}

export interface AiCallResult {
  response: Response;
  tierUsed: 'primary' | 'fallback' | 'last_resort';
  modelUsed: string;
  providerUsed: string;
  tiers: AiTierResult[];
}

/** Category-aware hardcoded last resort models */
const CATEGORY_LAST_RESORT: Record<string, { provider: string; model: string } | null> = {
  chat: { provider: 'google', model: 'gemini-3-flash-preview' },
  image: { provider: 'google', model: 'gemini-2.5-flash-image' },
  tts: { provider: 'google', model: 'gemini-2.5-flash' },
  video: null,
  search: null,
  stt: { provider: 'openai', model: 'whisper-1' },
};

export function getAiEndpoint(provider: string): AiEndpoint {
  if (provider === 'openrouter') {
    const apiKey = Deno.env.get('OPENROUTER_API_KEY') ?? '';
    return {
      apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
      apiKey,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://postora.cloud',
        'X-Title': 'Postora',
      },
    };
  }

  // Default: Google AI Studio direct
  const apiKey = Deno.env.get('GOOGLE_AI_STUDIO_KEY') ?? '';
  return {
    apiUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    apiKey,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  };
}

export function normalizeModelName(model: string, provider: string): string {
  if (provider === 'google' || provider === 'lovable') {
    return model.replace(/^google\//, '');
  }
  return model;
}

/**
 * Fetch AI settings (primary + fallback) from app_settings table.
 */
export async function fetchAiSettings(supabaseAdmin: any): Promise<{
  primaryProvider: string;
  primaryModel: string;
  fallbackProvider: string;
  fallbackModel: string;
}> {
  const { data: settings } = await supabaseAdmin
    .from('app_settings')
    .select('key, value')
    .in('key', ['ai_provider', 'ai_model', 'ai_fallback_provider', 'ai_fallback_model']);

  let primaryProvider = 'google';
  let primaryModel = 'google/gemini-2.5-flash';
  let fallbackProvider = '';
  let fallbackModel = '';

  for (const s of settings || []) {
    try {
      const val = typeof s.value === 'string' ? JSON.parse(s.value) : s.value;
      if (s.key === 'ai_provider' && val) primaryProvider = String(val);
      if (s.key === 'ai_model' && val) primaryModel = String(val);
      if (s.key === 'ai_fallback_provider' && val) fallbackProvider = String(val);
      if (s.key === 'ai_fallback_model' && val) fallbackModel = String(val);
    } catch { /* use defaults */ }
  }

  return { primaryProvider, primaryModel, fallbackProvider, fallbackModel };
}

/**
 * Fetch per-category AI settings from system_settings table.
 */
export async function fetchCategoryAiSettings(supabaseAdmin: any, category: string): Promise<{
  primaryProvider: string;
  primaryModel: string;
  fallbackProvider: string;
  fallbackModel: string;
  lastResortProvider: string;
  lastResortModel: string;
}> {
  const primaryKey = `default_ai_model_${category}`;
  const fallbackKey = `default_ai_model_${category}_fallback`;

  const { data: settings } = await supabaseAdmin
    .from('system_settings')
    .select('key, value')
    .in('key', [primaryKey, fallbackKey]);

  let primaryProvider = 'google';
  let primaryModel = 'google/gemini-2.5-flash';
  let fallbackProvider = '';
  let fallbackModel = '';

  for (const s of settings || []) {
    try {
      const val = typeof s.value === 'string' ? JSON.parse(s.value) : s.value;
      if (s.key === primaryKey && val?.provider_code && val?.model_id) {
        primaryProvider = val.provider_code;
        primaryModel = val.model_id;
      }
      if (s.key === fallbackKey && val?.provider_code && val?.model_id) {
        fallbackProvider = val.provider_code;
        fallbackModel = val.model_id;
      }
    } catch { /* use defaults */ }
  }

  const lastResort = CATEGORY_LAST_RESORT[category] || CATEGORY_LAST_RESORT['chat']!;
  const lastResortProvider = lastResort?.provider || 'google';
  const lastResortModel = lastResort?.model || 'gemini-3-flash-preview';

  return { primaryProvider, primaryModel, fallbackProvider, fallbackModel, lastResortProvider, lastResortModel };
}

/**
 * Resolve the chat-model 3-tier configuration following the canonical pathway:
 *   1. User-specific override (user_ai_model_overrides) — highest precedence
 *   2. Admin "Chat" primary + fallback (system_settings.default_ai_model_chat[_fallback])
 *   3. Hard-coded last resort (google/gemini-2.5-flash via Lovable AI Gateway)
 *
 * If a user override is active, it becomes the primary tier and admin settings
 * become fallback + last-resort, so the override never leaves the user without recovery.
 */
export async function resolveChatModelConfig(
  supabaseAdmin: any,
  userId: string | null,
): Promise<{
  primaryProvider: string;
  primaryModel: string;
  fallbackProvider: string;
  fallbackModel: string;
  lastResortProvider: string;
  lastResortModel: string;
  source: 'user_override' | 'admin_chat' | 'hardcoded';
}> {
  const adminConfig = await fetchCategoryAiSettings(supabaseAdmin, 'chat');

  // Check user-specific override (non-expired)
  if (userId) {
    const { data: userOverride } = await supabaseAdmin
      .from('user_ai_model_overrides')
      .select('provider, model, expires_at')
      .eq('user_id', userId)
      .maybeSingle();

    if (userOverride && (!userOverride.expires_at || new Date(userOverride.expires_at) > new Date())) {
      return {
        primaryProvider: userOverride.provider,
        primaryModel: userOverride.model,
        fallbackProvider: adminConfig.primaryProvider,
        fallbackModel: adminConfig.primaryModel,
        lastResortProvider: adminConfig.fallbackProvider || adminConfig.lastResortProvider,
        lastResortModel: adminConfig.fallbackModel || adminConfig.lastResortModel,
        source: 'user_override',
      };
    }
  }

  return {
    primaryProvider: adminConfig.primaryProvider,
    primaryModel: adminConfig.primaryModel,
    fallbackProvider: adminConfig.fallbackProvider,
    fallbackModel: adminConfig.fallbackModel,
    lastResortProvider: adminConfig.lastResortProvider,
    lastResortModel: adminConfig.lastResortModel,
    source: 'admin_chat',
  };
}

/**
 * Execute a 3-tier AI call with fallback chain.
 */
// Per-tier hard timeout. Keeps total request time bounded so edge gateway
// (Kong ~60s) never returns a 504 with stripped CORS headers.
const AI_TIER_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function callAiWithFallback(
  requestBody: any,
  primaryProvider: string,
  primaryModel: string,
  fallbackProvider: string,
  fallbackModel: string,
  lastResortProvider?: string,
  lastResortModel?: string,
): Promise<AiCallResult> {
  const tiers: AiTierResult[] = [];
  const lrProvider = lastResortProvider || 'google';
  const lrModel = lastResortModel || 'gemini-3-flash-preview';

  // ── Tier 1: Primary ──
  const ep1 = getAiEndpoint(primaryProvider);
  if (ep1.apiKey) {
    const model1 = normalizeModelName(primaryModel, primaryProvider);
    const body1 = { ...requestBody, model: model1 };
    try {
      const res = await fetchWithTimeout(ep1.apiUrl, {
        method: 'POST',
        headers: ep1.headers,
        body: JSON.stringify(body1),
      }, AI_TIER_TIMEOUT_MS);
      tiers.push({ tier: 'primary', provider: primaryProvider, model: primaryModel, status: res.status });
      if (res.ok) {
        return { response: res, tierUsed: 'primary', modelUsed: primaryModel, providerUsed: primaryProvider, tiers };
      }
      const errText = await res.text();
      tiers[tiers.length - 1].error = errText.substring(0, 500);
      console.error('Primary AI failed:', res.status, errText.substring(0, 200));
    } catch (e: any) {
      const msg = e?.name === 'AbortError' ? `timeout after ${AI_TIER_TIMEOUT_MS}ms` : e?.message;
      tiers.push({ tier: 'primary', provider: primaryProvider, model: primaryModel, status: 0, error: msg });
      console.error('Primary AI exception:', msg);
    }
  } else {
    tiers.push({ tier: 'primary', provider: primaryProvider, model: primaryModel, status: 0, error: 'API key not configured' });
  }

  // ── Tier 2: Fallback ──
  if (fallbackProvider && fallbackModel) {
    const ep2 = getAiEndpoint(fallbackProvider);
    if (ep2.apiKey) {
      const model2 = normalizeModelName(fallbackModel, fallbackProvider);
      const body2 = { ...requestBody, model: model2 };
      try {
        const res = await fetchWithTimeout(ep2.apiUrl, {
          method: 'POST',
          headers: ep2.headers,
          body: JSON.stringify(body2),
        }, AI_TIER_TIMEOUT_MS);
        tiers.push({ tier: 'fallback', provider: fallbackProvider, model: fallbackModel, status: res.status });
        if (res.ok) {
          return { response: res, tierUsed: 'fallback', modelUsed: fallbackModel, providerUsed: fallbackProvider, tiers };
        }
        const errText = await res.text();
        tiers[tiers.length - 1].error = errText.substring(0, 500);
        console.error('Fallback AI failed:', res.status, errText.substring(0, 200));
      } catch (e: any) {
        const msg = e?.name === 'AbortError' ? `timeout after ${AI_TIER_TIMEOUT_MS}ms` : e?.message;
        tiers.push({ tier: 'fallback', provider: fallbackProvider, model: fallbackModel, status: 0, error: msg });
        console.error('Fallback AI exception:', msg);
      }
    } else {
      tiers.push({ tier: 'fallback', provider: fallbackProvider, model: fallbackModel, status: 0, error: 'API key not configured' });
    }
  }

  // ── Tier 3: Last Resort ──
  const normalizedLrModel = normalizeModelName(lrModel, lrProvider);
  const ep3 = getAiEndpoint(lrProvider);
  if (ep3.apiKey) {
    const body3 = { ...requestBody, model: normalizedLrModel };
    try {
      const res = await fetchWithTimeout(ep3.apiUrl, {
        method: 'POST',
        headers: ep3.headers,
        body: JSON.stringify(body3),
      }, AI_TIER_TIMEOUT_MS);
      tiers.push({ tier: 'last_resort', provider: lrProvider, model: lrModel, status: res.status });
      if (res.ok) {
        return { response: res, tierUsed: 'last_resort', modelUsed: lrModel, providerUsed: lrProvider, tiers };
      }
      const errText = await res.text();
      tiers[tiers.length - 1].error = errText.substring(0, 500);
      console.error('Last resort AI failed:', res.status, errText.substring(0, 200));
    } catch (e: any) {
      const msg = e?.name === 'AbortError' ? `timeout after ${AI_TIER_TIMEOUT_MS}ms` : e?.message;
      tiers.push({ tier: 'last_resort', provider: lrProvider, model: lrModel, status: 0, error: msg });
      console.error('Last resort AI exception:', msg);
    }
  } else {
    tiers.push({ tier: 'last_resort', provider: lrProvider, model: lrModel, status: 0, error: 'API key not configured' });
  }

  return {
    response: new Response(JSON.stringify({ error: 'All AI tiers failed' }), { status: 502 }),
    tierUsed: 'last_resort',
    modelUsed: lrModel,
    providerUsed: lrProvider,
    tiers,
  };
}

/**
 * Log an AI call to system_logs.
 */
export async function logAiCall(
  supabaseAdmin: any,
  feature: string,
  source: string,
  userId: string | null,
  success: boolean,
  result: AiCallResult,
  extraMeta?: Record<string, any>,
): Promise<void> {
  try {
    const tierDetails: Record<string, any> = {};
    for (const t of result.tiers) {
      tierDetails[t.tier] = {
        provider: t.provider,
        model: t.model,
        status: t.status,
        error: t.error || undefined,
      };
    }

    await supabaseAdmin.from('system_logs').insert({
      level: success ? 'info' : 'error',
      category: 'ai',
      source,
      message: success
        ? `AI ${feature} succeeded using ${result.modelUsed} (${result.tierUsed})`
        : `AI ${feature} failed after all fallback tiers`,
      user_id: userId,
      metadata: {
        feature,
        model_used: result.modelUsed,
        provider_used: result.providerUsed,
        tier_used: result.tierUsed,
        success,
        tiers: tierDetails,
        ...extraMeta,
      },
    });
  } catch (e) {
    console.error('Failed to log AI call:', e);
  }
}
