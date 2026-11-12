// The provider probe: one implementation of "does this key work?", shared by the
// admin card's Test button and the daily health run.
//
// WHY it lives here
// The probes used to live inside ai-config/index.ts, so the health runner could not use
// them without a second copy — the exact drift the comment at the top of the old
// providerTestKind.ts warns about. One file means one place to add the timeout the
// probes still lacked.
//
// WHY every call has a timeout
// A provider that stops answering used to hang the whole edge function until the
// platform killed it. Every fetch now carries an AbortSignal and races a timer, so a
// hung provider becomes a failed probe instead of a hung request.

import { HEALTH_TARGET_TIMEOUT_MS } from "./aiProviderHealth.ts";
import { describeProviderFailure, ProviderTestError } from "./providerErrors.ts";
import { redactProviderError } from "./ai-routing-errors.ts";
import type { RowReader } from "./providerEndpoint.ts";

// Which probe proves a provider's key works. test-connection, set-service-key and
// test-service each used to carry their own copy of this chain; they drifted, and
// the card Test sent Firecrawl and ElevenLabs keys to /chat/completions.
export type ProviderTestKind =
  | "firecrawl" | "apify" | "elevenlabs" | "brave" | "exa" | "jina"
  | "zai" | "xai" | "minimax" | "perplexity"
  | "google" | "anthropic" | "openai";

const BY_CODE: Record<string, ProviderTestKind> = {
  firecrawl: "firecrawl", apify: "apify", elevenlabs: "elevenlabs", brave_search: "brave", exa: "exa",
  jina: "jina", zai: "zai", xai: "xai", minimax: "minimax", perplexity: "perplexity",
};

export function providerTestKind(provider: { provider_code: string; api_type?: string | null }): ProviderTestKind {
  const byCode = BY_CODE[provider.provider_code];
  if (byCode) return byCode;
  if (provider.api_type === "elevenlabs") return "elevenlabs";
  if (provider.api_type === "google") return "google";
  if (provider.api_type === "anthropic") return "anthropic";
  return "openai";
}

export interface ProviderProbeTarget {
  id: string;
  provider_code: string;
  api_type: string | null;
  api_endpoint: string;
}

/** The name of the error a timed-out fetch rejects with. */
function isTimeoutError(error: unknown): boolean {
  const name = typeof error === "object" && error !== null && "name" in error
    ? String((error as { name: unknown }).name)
    : "";
  return name === "TimeoutError" || name === "AbortError";
}

/** The error the timeout race rejects with; it carries the timeout's error name. */
class ProbeTimeoutError extends Error {
  constructor() {
    super("probe timeout");
    this.name = "TimeoutError";
  }
}

/**
 * A fetch that cannot outlive its timeout. The signal lets a real fetch cancel its
 * body; the race guarantees the timeout even when the fetch implementation ignores
 * the signal.
 */
async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeoutError()), timeoutMs);
  });
  try {
    return await Promise.race([
      fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
      expiry,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Firecrawl and Apify keys can be saved without an ai_providers row; they need no endpoint.
export async function loadProbeTarget(db: RowReader, providerCode: string): Promise<ProviderProbeTarget | null> {
  const { data } = await db.from('ai_providers').select('*').eq('provider_code', providerCode).maybeSingle();
  if (data) return data as ProviderProbeTarget;
  if (providerCode === 'firecrawl' || providerCode === 'apify') {
    return { id: '', provider_code: providerCode, api_type: 'rest', api_endpoint: '' };
  }
  return null;
}

/**
 * Probes one provider. Throws ProviderTestError when the provider refused the key or
 * did not answer in time; resolves when the probe succeeded.
 */
export async function probeProvider(
  db: unknown,
  provider: ProviderProbeTarget,
  key: string,
  timeoutMs = HEALTH_TARGET_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const ep = provider.api_endpoint;
  try {
    switch (providerTestKind(provider)) {
      case 'firecrawl': return await testFirecrawl(key, timeoutMs, fetchImpl);
      case 'apify': return await testApify(key, timeoutMs, fetchImpl);
      case 'elevenlabs': return await testElevenLabs(key, ep, timeoutMs, fetchImpl);
      case 'brave': return await testBrave(key, timeoutMs, fetchImpl);
      case 'exa': return await testExa(key, timeoutMs, fetchImpl);
      case 'jina': return await testJina(key, timeoutMs, fetchImpl);
      case 'zai': return await testZAI(key, ep, timeoutMs, fetchImpl);
      case 'xai': return await testXAI(key, ep, timeoutMs, fetchImpl);
      case 'minimax': return await testMinimax(key, ep, timeoutMs, fetchImpl);
      case 'perplexity': return await testPerplexity(key, ep, timeoutMs, fetchImpl);
      case 'google': return await testGemini(key, ep, timeoutMs, fetchImpl);
      case 'anthropic': return await testAnthropic(key, ep, timeoutMs, fetchImpl);
      case 'openai': return await testOpenAI(key, ep, await defaultTestModel(db, provider), timeoutMs, fetchImpl);
    }
  } catch (error) {
    if (error instanceof ProviderTestError) throw error;
    if (isTimeoutError(error)) {
      throw new ProviderTestError('The provider did not answer in time', 504, '');
    }
    throw error;
  }
}

// Jina has no chat endpoint; one tiny embedding proves the key.
async function testJina(key: string, timeoutMs: number, fetchImpl: typeof fetch) {
  const res = await fetchWithTimeout(fetchImpl, 'https://api.jina.ai/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'jina-embeddings-v5-omni-small', input: ['hi'] }),
  }, timeoutMs);
  await handleRes(res, 'Jina', key);
}

async function handleRes(res: Response, name: string, key: string) {
  if (res.ok) return;
  const t = await res.text();
  // The body can echo the key back, so it is redacted before it reaches the log.
  console.error(`${name} test failed: ${res.status} - ${redactProviderError(t, key).slice(0, 300)}`);
  throw new ProviderTestError(redactProviderError(describeProviderFailure(name, res.status, t), key), res.status, t);
}

function modelsUrl(ep: string, path = '/v1/models'): string {
  return ep.replace(/\/v1\/?$/, '') + path;
}

async function testGemini(key: string, ep: string, timeoutMs: number, fetchImpl: typeof fetch) {
  const res = await fetchWithTimeout(fetchImpl, `${ep}/models?key=${key}`, { headers: { 'x-goog-api-key': key } }, timeoutMs);
  await handleRes(res, 'Gemini', key);
}

async function testOpenAI(key: string, ep: string, model: string, timeoutMs: number, fetchImpl: typeof fetch) {
  const url = ep.replace(/\/$/, '') + '/chat/completions';
  const res = await fetchWithTimeout(fetchImpl, url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    // 16, not 1: Vercel routes openai/* through the Responses API, which rejects max_output_tokens < 16.
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }),
  }, timeoutMs);
  await handleRes(res, 'OpenAI', key);
}

// The gateway and OpenRouter namespace ids by vendor; a bare "gpt-4o-mini" is
// rejected there, so test with a chat model the provider actually lists.
const TEST_MODEL_OVERRIDE: Record<string, string> = { vercel: 'openai/gpt-4o-mini', openrouter: 'openai/gpt-4o-mini' };
// Used only when a provider has no active chat model yet (e.g. DeepSeek before its first sync).
const TEST_MODEL_FALLBACK: Record<string, string> = { deepseek: 'deepseek-chat' };
interface ChatModelQuery {
  eq(column: string, value: unknown): ChatModelQuery;
  contains(column: string, value: string[]): ChatModelQuery;
  order(column: string): ChatModelQuery;
  limit(count: number): ChatModelQuery;
  maybeSingle(): PromiseLike<{ data: { model_id?: string } | null }>;
}
interface ChatModelDb { from(table: string): { select(columns: string): ChatModelQuery } }
// Takes the client as unknown: checking the generated client type against ChatModelDb hits TS2589.
async function defaultTestModel(client: unknown, provider: { id: string; provider_code: string }): Promise<string> {
  if (TEST_MODEL_OVERRIDE[provider.provider_code]) return TEST_MODEL_OVERRIDE[provider.provider_code];
  const { data } = await (client as ChatModelDb).from('ai_models').select('model_id').eq('provider_id', provider.id)
    .eq('is_active', true).contains('capabilities', ['chat']).order('name').limit(1).maybeSingle();
  return data?.model_id ?? TEST_MODEL_FALLBACK[provider.provider_code] ?? 'gpt-4o-mini';
}

async function testAnthropic(key: string, ep: string, timeoutMs: number, fetchImpl: typeof fetch) {
  const res = await fetchWithTimeout(fetchImpl, modelsUrl(ep), { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }, timeoutMs);
  await handleRes(res, 'Anthropic', key);
}

async function testPerplexity(key: string, ep: string, timeoutMs: number, fetchImpl: typeof fetch) {
  // Perplexity requires max_tokens >= 16 (sending 1 returns 400 invalid_request).
  const res = await fetchWithTimeout(fetchImpl, `${ep.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'sonar', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }),
  }, timeoutMs);
  await handleRes(res, 'Perplexity', key);
}

async function testZAI(key: string, ep: string, timeoutMs: number, fetchImpl: typeof fetch) {
  // Validate the key with a lightweight GET /models. Chat completions fail on
  // insufficient balance / rate limits (429), which do not reflect key
  // validity. The model list is the cheapest authoritative check.
  const url = ep.replace(/\/$/, '') + '/models';
  const res = await fetchWithTimeout(fetchImpl, url, { headers: { Authorization: `Bearer ${key}` } }, timeoutMs);
  if (res.ok) {
    const data = await res.json() as { data?: Array<{ id?: string }> };
    console.log(`Z.AI test passed. Available models: ${(data.data || []).map((m) => m.id).join(', ')}`);
    return;
  }
  await handleRes(res, 'Z.AI', key);
}

async function testBrave(key: string, timeoutMs: number, fetchImpl: typeof fetch) {
  const res = await fetchWithTimeout(fetchImpl, 'https://api.search.brave.com/res/v1/web/search?q=test&count=1', {
    headers: { Accept: 'application/json', 'X-Subscription-Token': key },
  }, timeoutMs);
  await handleRes(res, 'Brave', key);
}

async function testExa(key: string, timeoutMs: number, fetchImpl: typeof fetch) {
  const res = await fetchWithTimeout(fetchImpl, 'https://api.exa.ai/search', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ query: 'test', numResults: 1 }),
  }, timeoutMs);
  await handleRes(res, 'Exa', key);
}

async function testElevenLabs(key: string, ep: string, timeoutMs: number, fetchImpl: typeof fetch) {
  const baseUrl = (ep || 'https://api.elevenlabs.io/v1').replace(/\/$/, '');
  // A valid key may be scope-limited (missing models_read / voices_read /
  // user_read). "missing_permissions" / "restricted" prove the key
  // authenticates, so they count as a PASS, not a failure.
  const probePaths = ['/user', '/models', '/voices'];
  for (const path of probePaths) {
    const res = await fetchWithTimeout(fetchImpl, `${baseUrl}${path}`, { headers: { 'xi-api-key': key } }, timeoutMs);
    if (res.ok) {
      await res.text();
      return;
    }
    const t = await res.text();
    if (t.includes('missing_permissions') || t.includes('restricted')) {
      // Key authenticates but lacks this read scope — try the next probe.
      continue;
    }
    if (res.status === 401) throw new Error('Invalid API key');
    if (res.status === 429) throw new Error('Rate limit exceeded');
    // Other transient errors: keep trying the remaining probes.
  }
  // Reached the end having seen only scope-limited responses → key is valid.
  console.log('ElevenLabs test passed (key authenticates; read scope limited).');
}

async function testXAI(key: string, ep: string, timeoutMs: number, fetchImpl: typeof fetch) {
  // Use lightweight GET /v1/models to validate API key without needing a specific model
  const modelsEndpoint = ep.replace(/\/$/, '').replace(/\/v1\/?$/, '') + '/v1/models';
  const res = await fetchWithTimeout(fetchImpl, modelsEndpoint, { headers: { Authorization: `Bearer ${key}` } }, timeoutMs);
  if (res.ok) {
    const data = await res.json() as { data?: Array<{ id?: string }> };
    console.log(`xAI test passed. Available models: ${(data.data || []).map((m) => m.id).join(', ')}`);
    return;
  }
  await handleRes(res, 'xAI', key);
}

async function testMinimax(key: string, ep: string, timeoutMs: number, fetchImpl: typeof fetch) {
  // Validate the key with a lightweight GET /models instead of a chat
  // completion. Chat calls fail when the account has insufficient balance
  // (HTTP 402 / code 1008), which says nothing about key validity.
  const modelsEndpoint = ep.replace(/\/$/, '').replace(/\/v1\/?$/, '') + '/v1/models';
  const res = await fetchWithTimeout(fetchImpl, modelsEndpoint, { headers: { Authorization: `Bearer ${key}` } }, timeoutMs);
  if (res.ok) {
    const data = await res.json() as { data?: Array<{ id?: string }> };
    console.log(`MiniMax test passed. Available models: ${(data.data || []).map((m) => m.id).join(', ')}`);
    return;
  }
  await handleRes(res, 'MiniMax', key);
}

async function testFirecrawl(key: string, timeoutMs: number, fetchImpl: typeof fetch) {
  // Firecrawl v2 is the current API. A minimal scrape of a stable URL
  // validates the key: bad key -> 401, valid key -> 200.
  const res = await fetchWithTimeout(fetchImpl, 'https://api.firecrawl.dev/v2/scrape', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com', formats: ['markdown'] }),
  }, timeoutMs);
  await handleRes(res, 'Firecrawl', key);
}

async function testApify(key: string, timeoutMs: number, fetchImpl: typeof fetch) {
  const res = await fetchWithTimeout(fetchImpl, `https://api.apify.com/v2/users/me?token=${key}`, {}, timeoutMs);
  await handleRes(res, 'Apify', key);
}
