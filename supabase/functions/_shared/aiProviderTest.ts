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

import { HEALTH_TARGET_TIMEOUT_MS, withSignal } from "./aiProviderHealth.ts";
import { describeProviderFailure, ProviderTestError } from "./providerErrors.ts";
import { redactProviderError } from "./ai-routing-errors.ts";
import type { RowReader } from "./providerEndpoint.ts";
import { ProviderReadError } from "./providerEndpoint.ts";
export { ProviderReadError } from "./providerEndpoint.ts";
import { providerFetch } from './providerUrlPolicy.ts';

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
      providerFetch(fetchImpl)(url, { ...init, signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) }),
      expiry,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Firecrawl and Apify keys can be saved without an ai_providers row; they need no endpoint.
export async function loadProbeTarget(db: RowReader, providerCode: string, signal?: AbortSignal): Promise<ProviderProbeTarget | null> {
  const query = db.from('ai_providers').select('*').eq('provider_code', providerCode);
  signal?.throwIfAborted();
  if (signal && !query.abortSignal) throw new ProviderReadError('Provider read cancellation is unavailable');
  const { data, error } = await (signal ? query.abortSignal!(signal) : query).maybeSingle();
  // A failed read must never look like a missing row: the first is the server's
  // problem, the second is the admin's.
  if (error) throw new ProviderReadError('The provider configuration could not be read');
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
  signal?: AbortSignal,
): Promise<void> {
  const ep = provider.api_endpoint;
  const transport = fetchImpl;
  // All probe helpers, including ElevenLabs' sequential fallback requests, share
  // the caller's cancellation. Do not start another request after cancellation.
  if (signal) fetchImpl = (input, init) => {
    signal.throwIfAborted();
    const combined = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
    return withSignal(transport(input, { ...init, signal: combined }), combined);
  };
  try {
    signal?.throwIfAborted();
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
      case 'openai': return await testOpenAI(key, ep, await defaultTestModel(db, provider, signal), timeoutMs, fetchImpl);
    }
  } catch (error) {
    if (error instanceof ProviderReadError) throw error;
    if (error instanceof ProviderTestError) {
      throw new ProviderTestError(redactProviderError(error.message, key), error.status, redactProviderError(error.body, key));
    }
    if (isTimeoutError(error)) {
      throw new ProviderTestError('The provider did not answer in time', 504, '');
    }
    // A rejected fetch (DNS, connection refused, TLS) carries the request URL in its
    // message, and a URL can carry the credential. Only a fixed sentence
    // leaves this function, and the raw error is never chained as a cause: a logger
    // serialises a cause just as readily as a top-level message.
    throw new Error('The provider request failed');
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
  console.error(`${name} test failed: HTTP ${res.status}`);
  throw new ProviderTestError(redactProviderError(describeProviderFailure(name, res.status, t), key), res.status, t);
}

function modelsUrl(ep: string, path = '/v1/models'): string {
  return ep.replace(/\/v1\/?$/, '') + path;
}

async function testGemini(key: string, ep: string, timeoutMs: number, fetchImpl: typeof fetch) {
  // The key travels in the x-goog-api-key header, never in the query string: a URL
  // ends up in proxy logs, in access logs and in the message of a rejected fetch.
  const res = await fetchWithTimeout(fetchImpl, `${ep}/models`, { headers: { 'x-goog-api-key': key } }, timeoutMs);
  await handleRes(res, 'Gemini', key);
}

async function testOpenAI(key: string, ep: string, model: string | null, timeoutMs: number, fetchImpl: typeof fetch) {
  if (!model) {
    const res = await fetchWithTimeout(fetchImpl, ep.replace(/\/$/, '') + '/models', {
      headers: { Authorization: `Bearer ${key}` },
    }, timeoutMs);
    await handleRes(res, 'Provider', key);
    return;
  }
  const url = ep.replace(/\/$/, '') + '/chat/completions';
  const res = await fetchWithTimeout(fetchImpl, url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    // 16, not 1: Vercel routes openai/* through the Responses API, which rejects max_output_tokens < 16.
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }],
      ...(/^(?:o[1-9](?:-|$)|gpt-5(?:-|$))/.test(model) ? { max_completion_tokens: 16 } : { max_tokens: 16 }) }),
  }, timeoutMs);
  await handleRes(res, 'OpenAI', key);
}

// The gateway and OpenRouter namespace ids by vendor; a bare "gpt-4o-mini" is
// rejected there, so test with a chat model the provider actually lists.
const TEST_MODEL_OVERRIDE: Record<string, string> = { vercel: 'openai/gpt-4o-mini', openrouter: 'openai/gpt-4o-mini' };
// Used only when a provider has no active chat model yet (e.g. DeepSeek before its first sync).
const TEST_MODEL_FALLBACK: Record<string, string> = { deepseek: 'deepseek-chat', openai: 'gpt-4o-mini' };
interface ChatModelQuery {
  abortSignal(signal: AbortSignal): ChatModelQuery;
  eq(column: string, value: unknown): ChatModelQuery;
  contains(column: string, value: string[]): ChatModelQuery;
  order(column: string): ChatModelQuery;
  limit(count: number): ChatModelQuery;
  maybeSingle(): PromiseLike<{ data: { model_id?: string } | null; error?: unknown }>;
}
interface ChatModelDb { from(table: string): { select(columns: string): ChatModelQuery } }
// Takes the client as unknown: checking the generated client type against ChatModelDb hits TS2589.
async function defaultTestModel(client: unknown, provider: { id: string; provider_code: string }, signal?: AbortSignal): Promise<string | null> {
  if (TEST_MODEL_OVERRIDE[provider.provider_code]) return TEST_MODEL_OVERRIDE[provider.provider_code];
  const query = (client as ChatModelDb).from('ai_models').select('model_id').eq('provider_id', provider.id)
    .eq('auth_method', 'api_key').eq('is_active', true).contains('capabilities', ['chat']).order('name').limit(1);
  const { data, error } = await (signal ? query.abortSignal(signal) : query).maybeSingle();
  if (error) throw new ProviderReadError('The probe model could not be read');
  return data?.model_id ?? TEST_MODEL_FALLBACK[provider.provider_code] ?? null;
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
  if (res.ok) return;
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
  // user_read). An exact structured 403 "missing_permissions" / "restricted"
  // code proves authentication; a substring in another error does not.
  const probePaths = ['/user', '/models', '/voices'];
  // A pass needs PROOF: a probe that answered 2xx, or a probe that proved the key
  // authenticates but lacks a read scope. Three probes that all failed say
  // nothing about the key, so the last failure is reported instead.
  let sawScopeLimited = false;
  let lastFailure: ProviderTestError | null = null;
  for (const path of probePaths) {
    const res = await fetchWithTimeout(fetchImpl, `${baseUrl}${path}`, { headers: { 'xi-api-key': key } }, timeoutMs);
    if (res.ok) {
      await res.text();
      return;
    }
    const t = await res.text();
    let scopeCode: unknown;
    try {
      const detail = (JSON.parse(t) as { detail?: unknown })?.detail;
      scopeCode = typeof detail === 'string' ? detail : (detail as { status?: unknown } | null)?.status;
    } catch { /* Not a structured scope error. */ }
    if (res.status === 403 && (scopeCode === 'missing_permissions' || scopeCode === 'restricted')) {
      // Key authenticates but lacks this read scope - try the next probe.
      sawScopeLimited = true;
      continue;
    }
    if (res.status === 401 || res.status === 429) {
      throw new ProviderTestError(describeProviderFailure('ElevenLabs', res.status, t), res.status, t);
    }
    // Another failure: keep the last one, so the reason names what really happened.
    console.error(`ElevenLabs test failed: HTTP ${res.status}`);
    lastFailure = new ProviderTestError(
      redactProviderError(describeProviderFailure('ElevenLabs', res.status, t), key),
      res.status,
      t,
    );
  }
  if (sawScopeLimited && !lastFailure) {
    // Every probe that answered proved the key authenticates.
    console.log('ElevenLabs test passed (key authenticates; read scope limited).');
    return;
  }
  // No probe proved the key works: the outage is a failure, not a pass.
  throw lastFailure ?? new ProviderTestError('The provider did not answer in time', 504, '');
}

async function testXAI(key: string, ep: string, timeoutMs: number, fetchImpl: typeof fetch) {
  // Use lightweight GET /v1/models to validate API key without needing a specific model
  const modelsEndpoint = ep.replace(/\/$/, '').replace(/\/v1\/?$/, '') + '/v1/models';
  const res = await fetchWithTimeout(fetchImpl, modelsEndpoint, { headers: { Authorization: `Bearer ${key}` } }, timeoutMs);
  if (res.ok) return;
  await handleRes(res, 'xAI', key);
}

async function testMinimax(key: string, ep: string, timeoutMs: number, fetchImpl: typeof fetch) {
  // Validate the key with a lightweight GET /models instead of a chat
  // completion. Chat calls fail when the account has insufficient balance
  // (HTTP 402 / code 1008), which says nothing about key validity.
  const modelsEndpoint = ep.replace(/\/$/, '').replace(/\/v1\/?$/, '') + '/v1/models';
  const res = await fetchWithTimeout(fetchImpl, modelsEndpoint, { headers: { Authorization: `Bearer ${key}` } }, timeoutMs);
  if (res.ok) return;
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
  // The token travels in the Authorization header, never in the query string: a URL
  // ends up in proxy logs, in access logs and in the message of a rejected fetch.
  const res = await fetchWithTimeout(fetchImpl, 'https://api.apify.com/v2/users/me', {
    headers: { Authorization: `Bearer ${key}` },
  }, timeoutMs);
  await handleRes(res, 'Apify', key);
}
