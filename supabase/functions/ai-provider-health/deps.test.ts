import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ProviderReadError } from '../_shared/providerEndpoint.ts';
import { createHealthHandlerPorts, createHealthRunPorts } from './deps.ts';

Deno.test('cron-secret requests reach the in-handler authorizer through the gateway', async () => {
  const config = await Deno.readTextFile(new URL('../../config.toml', import.meta.url));
  const section = config.split('[functions.ai-provider-health]')[1]?.split('[functions.')[0];
  assert(section && /verify_jwt\s*=\s*false/.test(section));
});

// HTTP is the seam: the real Supabase query builder and production adapters run.
function fixtureAdmin(failingTable?: string) {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    ai_providers: [
      { provider_code: 'openrouter', name: 'OpenRouter', is_active: true },
      { provider_code: 'claude', name: 'Claude', is_active: false },
      { provider_code: 'openai', name: 'OpenAI', is_active: true },
    ],
    ai_provider_oauth_connections: [
      { oauth_provider: 'openrouter', provider_code: 'openrouter', status: 'connected' },
      { oauth_provider: 'anthropic', provider_code: 'claude', status: 'connected' },
    ],
    provider_api_keys: [],
    ai_provider_health: [
      { provider_code: 'openrouter', auth_method: 'oauth', status: 'connected' },
      { provider_code: 'openai', auth_method: 'api_key', status: 'connected' },
      { provider_code: 'claude', auth_method: 'oauth', status: 'connected' },
    ],
    ai_provider_health_completions: [{ run_id: 'daily', provider_code: 'openrouter', auth_method: 'oauth' }],
  };
  const requests: string[] = [];
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url.pathname);
    if (url.pathname.endsWith('/' + failingTable)) return new Response(JSON.stringify({ message: 'storage failed' }), { status: 503, headers: { 'content-type': 'application/json' } });
    assert(init?.signal, 'database transport must carry cancellation');
    let rows = tables[url.pathname.split('/').pop() ?? ''] ?? [];
    for (const [column, filter] of url.searchParams) {
      if (filter.startsWith('eq.')) rows = rows.filter((row) => String(row[column]) === filter.slice(3));
      if (filter.startsWith('in.(')) rows = rows.filter((row) => filter.slice(4, -1).split(',').includes(String(row[column])));
    }
    return new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { tables, admin: createClient('https://database.example.test', 'fixture-service-key', { global: { fetch: transport } }), requests };
}

Deno.test('OpenRouter OAuth is included and inactive providers are excluded', async () => {
  const { admin } = fixtureAdmin();
  const ports = createHealthRunPorts(admin);
  const targets = await ports.listOAuthConnections(AbortSignal.timeout(1000));
  assertEquals(targets.map((target) => target.oauth_provider), ['openrouter']);
  // The same pi-ai API-key adapter/registry is used with OpenRouter's Vault key.
  const { getModels } = await import('npm:@mariozechner/pi-ai@0.73.1');
  assert(getModels('openrouter').length > 0);
});

Deno.test('status excludes removed keys and disabled OAuth connections', async () => {
  const { admin } = fixtureAdmin();
  const ports = await createHealthHandlerPorts(admin);
  const rows = await ports.readResults();
  assertEquals(rows.map((row) => `${row.provider_code}:${row.auth_method}`), ['openrouter:oauth']);
});

Deno.test('completion reads use immutable run markers rather than latest status', async () => {
  const { admin, requests } = fixtureAdmin();
  const recorded = await createHealthRunPorts(admin).listRecordedTargets('daily', AbortSignal.timeout(1000));
  assertEquals(recorded, [{ provider_code: 'openrouter', auth_method: 'oauth' }]);
  assertEquals(requests, ['/rest/v1/ai_provider_health_completions']);
});

for (const table of ['provider_api_keys', 'ai_providers']) {
  Deno.test(`credential ${table} read failure stays a configuration failure`, async () => {
    const { admin } = fixtureAdmin(table);
    await assertRejects(() => createHealthRunPorts(admin).resolveApiKey('openai', AbortSignal.timeout(1000)), ProviderReadError);
  });
}

Deno.test('active custom and service providers are probed without attempting unsupported sync', async () => {
  const { admin, tables, requests } = fixtureAdmin();
  tables.ai_providers.push({ provider_code: 'custom-api', name: 'Custom', is_active: true });
  tables.ai_providers.push({ provider_code: 'firecrawl', name: 'Firecrawl', is_active: true });
  const ports = createHealthRunPorts(admin);
  const targets = await ports.listApiKeyProviders(AbortSignal.timeout(1000));
  assert(targets.some((target) => target.provider_code === 'custom-api'));
  assert(targets.some((target) => target.provider_code === 'firecrawl'));
  const before = requests.length;
  assertEquals(await ports.syncApiKeyCatalogue('custom-api', AbortSignal.timeout(1000)), { added: null, updated: null, deactivated: null });
  assertEquals(requests.length, before);
});

Deno.test('OAuth credential storage failure is a run read error at the production adapter', async () => {
  const { admin } = fixtureAdmin('get_ai_oauth_credentials');
  await assertRejects(() => createHealthRunPorts(admin).probeOAuth({
    provider_code: 'openrouter', auth_method: 'oauth', oauth_provider: 'openrouter', display_name: 'OpenRouter',
  }, AbortSignal.timeout(1000)), ProviderReadError);
});

Deno.test('standalone service discovery includes absent rows and respects explicit disablement', async () => {
  const { admin, tables } = fixtureAdmin();
  tables.ai_providers.push({ provider_code: 'apify', name: 'Apify', is_active: false });
  const previous = Deno.env.get('FIRECRAWL_API_KEY');
  Deno.env.set('FIRECRAWL_API_KEY', 'test-key-not-secret');
  try {
    const ports = createHealthRunPorts(admin);
    const targets = await ports.listApiKeyProviders(AbortSignal.timeout(1000));
    assert(targets.some((r) => r.provider_code === 'firecrawl'));
    assert(!targets.some((r) => r.provider_code === 'apify'));
    assertEquals(await ports.resolveApiKey('firecrawl', AbortSignal.timeout(1000)), 'test-key-not-secret');
    tables.ai_providers.push({ provider_code: 'firecrawl', name: 'Firecrawl', is_active: true,
      api_key_env_var: 'POSTORA_TEST_UNCONFIGURED_SERVICE_ENV' });
    assertEquals(await ports.resolveApiKey('firecrawl', AbortSignal.timeout(1000)), 'test-key-not-secret');
  } finally {
    if (previous === undefined) Deno.env.delete('FIRECRAWL_API_KEY');
    else Deno.env.set('FIRECRAWL_API_KEY', previous);
  }
});
