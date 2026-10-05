import { callAnthropic } from "./anthropic-adapter.ts";
import { AI_USER_KEY_INVALID, redactProviderError } from "./ai-routing-errors.ts";
import type { AiRoutingAdmin } from "./ai-user-routing.ts";
import { BUILTIN_CHAT_PROVIDERS, loadOpenAiCompatibleBase } from "./providerEndpoint.ts";
import { resolveProviderKey } from "./providerKeys.ts";

export type AiTier =
  | { provider: string; model: string; credentialSource: 'user'; apiKey: string }
  | { provider: string; model: string; credentialSource: 'platform'; apiKey?: string };

export interface AiEndpoint {
  kind?: 'anthropic';
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
  credentialSource?: 'user' | 'platform';
  reason?: 'tier_cap';
}

export interface AiCallResult {
  response: Response;
  tierUsed: 'primary' | 'fallback' | 'last_resort';
  modelUsed: string;
  providerUsed: string;
  tiers: AiTierResult[];
  credentialSource?: 'user' | 'platform';
  fallbackReason?: string;
  /** Set when every attempted tier was the user's own key and the provider rejected it. */
  errorCode?: 'AI_USER_KEY_INVALID';
}

/** Category-aware hardcoded last resort models */
const CATEGORY_LAST_RESORT: Record<string, { provider: string; model: string } | null> = {
  chat: { provider: 'google', model: 'gemini-3-flash-preview' },
  image: { provider: 'google', model: 'gemini-2.5-flash-image' },
  tts: { provider: 'google', model: 'gemini-3.8-flash-tts' },
  video: null,
  search: null,
  stt: { provider: 'openai', model: 'whisper-1' },
  // Image & Document Understanding. OpenRouter, so the floor sits on a different vendor
  // account from the Gemini key the configured rungs usually start with.
  vision: { provider: 'openrouter', model: 'google/gemini-3.1-flash-lite' },
};

export function getAiEndpoint(provider: string, suppliedKey?: string, baseUrl?: string): AiEndpoint {
  if (provider === 'claude') {
    const apiKey = suppliedKey ?? Deno.env.get('ANTHROPIC_API_KEY') ?? '';
    return { kind: 'anthropic', apiUrl: '', apiKey, headers: {} };
  }
  if (provider === 'openai') {
    const apiKey = suppliedKey ?? Deno.env.get('OPENAI_API_KEY') ?? '';
    return { apiUrl: 'https://api.openai.com/v1/chat/completions', apiKey,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } };
  }
  if (provider === 'openrouter') {
    const apiKey = suppliedKey ?? Deno.env.get('OPENROUTER_API_KEY') ?? '';
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

  if (provider === 'xai') {
    const apiKey = suppliedKey ?? '';
    return { apiUrl: 'https://api.x.ai/v1/chat/completions', apiKey,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } };
  }

  if (baseUrl && !BUILTIN_CHAT_PROVIDERS.has(provider)) {
    // Data-driven providers get their key from resolveProviderKey; there is no env var to read here.
    const apiKey = suppliedKey ?? '';
    return { apiUrl: `${baseUrl}/chat/completions`, apiKey,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } };
  }

  // Default: Google AI Studio direct
  const apiKey = suppliedKey ?? Deno.env.get('GOOGLE_AI_STUDIO_KEY') ?? '';
  return {
    apiUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    apiKey,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  };
}

export async function resolvePlatformApiKey(admin: AiRoutingAdmin | undefined, provider: string): Promise<string> {
  // A data-driven provider must never fall through to the Google default key below.
  if (!BUILTIN_CHAT_PROVIDERS.has(provider)) return (await resolveProviderKey(admin, provider)) ?? '';
  if (admin) {
    const { data, error } = await admin.from('provider_api_keys').select('api_key')
      .eq('provider_code', provider === 'google' ? 'gemini' : provider).maybeSingle();
    if (error) throw new Error('Platform AI key read failed');
    if (data !== null) {
      if (typeof data !== 'object' || !('api_key' in data) || typeof data.api_key !== 'string') throw new Error('Invalid platform AI key response');
      if (data.api_key.trim()) return data.api_key;
    }
  }
  return getAiEndpoint(provider).apiKey;
}

export function normalizeModelName(model: string, provider: string): string {
  if (provider === 'google' || provider === 'gemini' || provider === 'lovable') {
    return model.replace(/^google\//, '');
  }
  return model;
}

function chatRequestForTier(request: Record<string, unknown>, tier: AiTier): Record<string, unknown> {
  const model = normalizeModelName(tier.model, tier.provider);
  const body: Record<string, unknown> = { ...request, model };
  if (tier.provider !== 'openai' || !/^(?:gpt-5(?:[.-]|$)|o[134](?:-|$))/.test(model)) return body;
  // GPT-5 and o-series reject the legacy token parameter. Build a fresh body
  // per tier: removing fields from the caller would also alter Google fallback.
  if (body.max_completion_tokens === undefined && body.max_tokens !== undefined) {
    body.max_completion_tokens = body.max_tokens;
  }

  delete body.max_tokens;
  const samplingSupported = /^gpt-5\.[1-9][0-9]*(?:-|$)/.test(model) && body.reasoning_effort === 'none';
  if (!samplingSupported) {
    delete body.temperature;
    delete body.top_p;
    delete body.logprobs;
    delete body.top_logprobs;
  }
  return body;
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
  const { data: settings, error: settingsError } = await supabaseAdmin
    .from('app_settings')
    .select('key, value')
    .in('key', ['ai_provider', 'ai_model', 'ai_fallback_provider', 'ai_fallback_model']);

  if (settingsError) throw new Error('AI settings read failed');

  let primaryProvider = 'google';
  let primaryModel = 'google/gemini-3.1-flash-lite';
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
  // The admin UI writes a THIRD tier (useAIConfiguration.ts:126). Reading only the first
  // two silently discarded whatever an operator picked as last resort and substituted the
  // hardcoded CATEGORY_LAST_RESORT instead -- for every category, not just stt.
  const fallback2Key = `default_ai_model_${category}_fallback_2`;

  const { data: settings, error: settingsError } = await supabaseAdmin
    .from('system_settings')
    .select('key, value')
    .in('key', [primaryKey, fallbackKey, fallback2Key]);

  if (settingsError) throw new Error('AI settings read failed');

  let primaryProvider = 'google';
  let primaryModel = 'google/gemini-3.1-flash-lite';
  let fallbackProvider = '';
  let fallbackModel = '';
  let configuredLastResortProvider = '';
  let configuredLastResortModel = '';

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
      if (s.key === fallback2Key && val?.provider_code && val?.model_id) {
        configuredLastResortProvider = val.provider_code;
        configuredLastResortModel = val.model_id;
      }
    } catch { /* use defaults */ }
  }

  // An operator's explicit third choice outranks the hardcoded floor -- but only when it
  // names a model that actually exists and is active.
  //
  // This guard is not theoretical: default_ai_model_chat_fallback_2 held
  // openrouter/nvidia/nemotron-3-ultra-550b-a55b:free, which is absent from ai_models.
  // The row had been inert while nothing read _fallback_2, so switching it on would have
  // silently replaced chat's known-good floor with an unvalidated model. A stale setting
  // must not be able to take out the last line of defence for every AI category.
  let useConfiguredLastResort = false;
  if (configuredLastResortProvider && configuredLastResortModel) {
    const { data: known, error: modelError } = await supabaseAdmin
      .from('ai_models')
      .select('id, ai_providers!inner(provider_code)')
      .eq('model_id', configuredLastResortModel)
      .eq('is_active', true)
      .eq('ai_providers.provider_code', configuredLastResortProvider)
      .maybeSingle();
    if (modelError) throw new Error('AI model catalog read failed');
    useConfiguredLastResort = Boolean(known);
    if (!useConfiguredLastResort) {
      console.warn(
        `[ai-fallback] ignoring ${category} third tier ` +
        `${configuredLastResortProvider}/${configuredLastResortModel}: not an active model`,
      );
    }
  }

  const lastResort = CATEGORY_LAST_RESORT[category] || CATEGORY_LAST_RESORT['chat']!;
  const lastResortProvider = useConfiguredLastResort
    ? configuredLastResortProvider
    : (lastResort?.provider || 'google');
  const lastResortModel = useConfiguredLastResort
    ? configuredLastResortModel
    : (lastResort?.model || 'gemini-3-flash-preview');

  return { primaryProvider, primaryModel, fallbackProvider, fallbackModel, lastResortProvider, lastResortModel };
}

/**
 * Resolve the chat-model 3-tier configuration following the canonical pathway:
 *   1. User-specific override (user_ai_model_overrides) — highest precedence
 *   2. Admin "Chat" primary + fallback (system_settings.default_ai_model_chat[_fallback])
 *   3. Hard-coded last resort (google/gemini-3-flash-preview)
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
    const { data: userOverride, error: overrideError } = await supabaseAdmin
      .from('user_ai_model_overrides')
      .select('provider, model, expires_at')
      .eq('user_id', userId)
      .maybeSingle();

    if (overrideError) throw new Error('AI model override read failed');
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

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { ctrl.abort(); reject(new Error(`timeout after ${timeoutMs}ms`)); }, timeoutMs);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const response = await fetch(url, { ...init, signal: ctrl.signal });
      const body = await response.arrayBuffer();
      return new Response(body.byteLength ? body : null, { status: response.status, headers: response.headers });
    })()]);
  } finally {
    clearTimeout(timer);
  }
}

export function platformChatTiers(config: {
  primaryProvider: string; primaryModel: string; fallbackProvider: string; fallbackModel: string;
  lastResortProvider?: string; lastResortModel?: string;
}): AiTier[] {
  // ── Tier 1: Primary ──
  const tiers: AiTier[] = [{ provider: config.primaryProvider, model: config.primaryModel, credentialSource: 'platform' }];
  // ── Tier 2: Fallback ──
  if (config.fallbackProvider && config.fallbackModel) tiers.push({ provider: config.fallbackProvider, model: config.fallbackModel, credentialSource: 'platform' });
  // ── Tier 3: Last Resort ──
  tiers.push({ provider: config.lastResortProvider || 'google', model: config.lastResortModel || 'gemini-3-flash-preview', credentialSource: 'platform' });
  return tiers;
}

export async function callAiChain(admin: AiRoutingAdmin | undefined, requestBody: Record<string, unknown>, candidates: AiTier[]): Promise<AiCallResult> {
  if (candidates.some((tier) => tier.credentialSource === 'user' && !tier.apiKey?.trim())) throw new Error('User AI tier requires an API key');
  const labels = ['primary', 'fallback', 'last_resort'] as const;
  const skipped: AiTierResult[] = candidates.slice(3).map((tier) => ({
    tier: 'last_resort', provider: tier.provider, model: tier.model, status: 0, reason: 'tier_cap', credentialSource: tier.credentialSource,
  }));
  const tiers: AiTierResult[] = [];
  const platformKeys = new Map<string, string>();
  let fallbackReason: string | undefined;
  for (const [index, tier] of candidates.slice(0, 3).entries()) {
    // Resolve outside the provider catch: failed database reads are not missing keys.
    let apiKey = tier.apiKey;
    if (tier.credentialSource === 'platform') {
      if (!platformKeys.has(tier.provider)) platformKeys.set(tier.provider, await resolvePlatformApiKey(admin, tier.provider));
      apiKey = platformKeys.get(tier.provider)!;
    }
    const attempt: AiTierResult = { tier: labels[index], provider: tier.provider, model: tier.model, status: 0, credentialSource: tier.credentialSource };
    tiers.push(attempt);
    if (!apiKey) { attempt.error = 'API key not configured'; continue; }
    try {
      let baseUrl: string | undefined;
      if (!BUILTIN_CHAT_PROVIDERS.has(tier.provider)) {
        const base = await loadOpenAiCompatibleBase(admin, tier.provider);
        if (!base) { attempt.error = 'Provider endpoint not configured'; continue; }
        baseUrl = base;
      }
      const endpoint = getAiEndpoint(tier.provider, apiKey, baseUrl);
      const body = chatRequestForTier(requestBody, tier);
      const response = endpoint.kind === 'anthropic'
        ? await callAnthropic(body, apiKey, AI_TIER_TIMEOUT_MS)
        : await fetchWithTimeout(endpoint.apiUrl, { method: 'POST', headers: endpoint.headers, body: JSON.stringify(body) }, AI_TIER_TIMEOUT_MS);
      attempt.status = response.status;
      if (response.ok) return { response, tierUsed: attempt.tier, modelUsed: tier.model, providerUsed: tier.provider,
        credentialSource: tier.credentialSource, fallbackReason, tiers: [...tiers, ...skipped] };
      attempt.error = tier.credentialSource === 'user' && [401, 403].includes(response.status)
        ? AI_USER_KEY_INVALID : redactProviderError(await response.text(), apiKey);
    } catch (error) {
      attempt.error = redactProviderError(error instanceof Error ? error.message : 'AI request failed', apiKey);
    }
    if (tier.credentialSource === 'user') fallbackReason = `user_tier_failed:${attempt.status}`;
  }
  const last = tiers[tiers.length - 1];
  // A chain made only of the user's rejected key is not a provider outage: keep
  // the actionable code so callers can tell the user to fix the saved key.
  const userKeyRejected = tiers.length > 0 &&
    tiers.every((t) => t.credentialSource === 'user' && t.error === AI_USER_KEY_INVALID);
  const errorCode = userKeyRejected ? AI_USER_KEY_INVALID : undefined;
  return { response: new Response(JSON.stringify({ error: errorCode ?? 'All AI tiers failed' }), { status: 502 }),
    tierUsed: last?.tier ?? 'last_resort', modelUsed: last?.model ?? '', providerUsed: last?.provider ?? '',
    credentialSource: last?.credentialSource, fallbackReason, errorCode, tiers: [...tiers, ...skipped] };
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
  const result = await callAiChain(undefined, requestBody, platformChatTiers({ primaryProvider, primaryModel,
    fallbackProvider, fallbackModel, lastResortProvider, lastResortModel }));
  // The positional API keeps its last-resort label even when slot two is unset.
  if (!fallbackProvider || !fallbackModel) {
    if (result.tiers[1]) result.tiers[1].tier = 'last_resort';
    if (result.tierUsed === 'fallback') result.tierUsed = 'last_resort';
  }
  return result;
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
      tierDetails[t.reason === 'tier_cap' ? `skipped_${Object.keys(tierDetails).length}` : t.tier] = {
        provider: t.provider,
        model: t.model,
        status: t.status,
        error: t.error || undefined,
        credential_source: t.credentialSource,
        reason: t.reason,
      };
    }

    const { error } = await supabaseAdmin.from('system_logs').insert({
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
        credential_source: result.credentialSource,
        fallback_reason: result.fallbackReason,
        success,
        tiers: tierDetails,
        ...extraMeta,
      },
    });
    if (error) throw new Error(`AI call log write failed: ${(error as { message?: string }).message ?? 'unknown'}`);
  } catch (e) {
    console.error('Failed to log AI call:', e instanceof Error ? e.message : e);
  }
}
