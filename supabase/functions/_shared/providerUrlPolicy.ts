// Provider credentials may only leave the edge network for these vendor hosts.
// Exact hosts also exclude arbitrary DNS names (including rebinding endpoints),
// IP literals, internal names and metadata aliases. New vendors require review.
const PROVIDER_HOSTS = new Set([
  'api.openai.com', 'api.anthropic.com', 'openrouter.ai', 'api.x.ai',
  'generativelanguage.googleapis.com', 'ai-gateway.vercel.sh', 'api.deepseek.com',
  'api.z.ai', 'open.bigmodel.cn', 'api.minimax.io', 'api.minimaxi.com',
  'api.elevenlabs.io', 'api.perplexity.ai', 'api.jina.ai', 'api.exa.ai',
  'api.search.brave.com', 'api.firecrawl.dev', 'api.apify.com',
]);

export function assertProviderUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid provider endpoint'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
    !PROVIDER_HOSTS.has(url.hostname) || url.hash) {
    throw new Error('Provider endpoint must use an approved HTTPS vendor host');
  }
  return url;
}

/** Redirects are refused, so a vendor cannot redirect a credential to an internal address. */
export function providerFetch(fetchImpl: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    assertProviderUrl(input instanceof Request ? input.url : String(input));
    const response = await fetchImpl(input, { ...init, redirect: 'error' });
    // Test/custom transports must honor the same rule as native fetch.
    if (response.status >= 300 && response.status < 400 || response.redirected) {
      throw new Error('Provider redirects are not allowed');
    }
    return response;
  }) as typeof fetch;
}
