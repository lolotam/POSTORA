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
function fixtureAdmin(failingTable?: string, failureStatus = 503) {
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
    if (url.pathname.endsWith('/get_ai_oauth_credentials') && !failingTable) return Response.json({ access: 'fixture', refresh: '', expires: Date.now() + 3600000, status: 'connected' });
    if (url.pathname.endsWith('/' + failingTable)) return new Response(JSON.stringify({ message: 'storage failed' }), { status: failureStatus, headers: { 'content-type': 'application/json' } });
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

Deno.test('round5 dedicated Higgsfield platform login is discovered without an API key', async () => {
  const { admin, tables } = fixtureAdmin();
  tables.ai_providers.push({ provider_code: 'higgsfield', name: 'Higgsfield', is_active: true });
  tables.provider_api_keys.push({ provider_code: 'higgsfield', access_token: ['fixture', 'access'].join(' '), refresh_token: null });
  const ports = createHealthRunPorts(admin);
  const targets = await ports.listOAuthConnections(AbortSignal.timeout(1000));
  assert(targets.some((r) => r.oauth_provider === 'higgsfield' && r.provider_code === 'higgsfield'));
  assertEquals(await ports.resolveApiKey('higgsfield', AbortSignal.timeout(1000)), null);
  tables.ai_providers.find((r) => r.provider_code === 'higgsfield')!.is_active = false;
  assert(!(await ports.listOAuthConnections(AbortSignal.timeout(1000))).some((r) => r.oauth_provider === 'higgsfield'));
});

Deno.test('round5 Higgsfield platform target probes the MCP models endpoint', async () => {
  const { admin, tables } = fixtureAdmin();
  const credential = ['fixture', 'access'].join(' ');
  tables.provider_api_keys.push({ provider_code: 'higgsfield', access_token: credential,
    refresh_token: null, expires_at: new Date(Date.now() + 3600000).toISOString() });
  const originalFetch = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = (async (input, init) => {
    assertEquals(String(input), 'https://mcp.higgsfield.ai/mcp');
    assertEquals(new Headers(init?.headers).get('Authorization'), `Bearer ${credential}`);
    const body = JSON.parse(String(init?.body));
    methods.push(body.method);
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'tools/call') {
      assertEquals(body.params.name, 'models_explore');
      assertEquals(body.params.arguments, { action: 'list', type: 'image', limit: 1 });
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id,
      result: body.method === 'initialize' ? { protocolVersion: '2025-03-26' } : { content: [{ type: 'text', text: '[]' }] } }),
      { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await createHealthRunPorts(admin).probeOAuth({ provider_code: 'higgsfield', oauth_provider: 'higgsfield',
      auth_method: 'oauth', display_name: 'Higgsfield' }, AbortSignal.timeout(1000));
    assertEquals(methods, ['initialize', 'notifications/initialized', 'tools/call']);
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test('round5 Higgsfield credential storage outage is never a re-login result', async () => {
  const { admin } = fixtureAdmin('provider_api_keys', 400);
  await assertRejects(() => createHealthRunPorts(admin).probeOAuth({ provider_code: 'higgsfield', oauth_provider: 'higgsfield',
    auth_method: 'oauth', display_name: 'Higgsfield' }, AbortSignal.timeout(1000)), ProviderReadError);
});

Deno.test('missing provider is a local run error at the production probe adapter', async () => {
  const { admin } = fixtureAdmin();
  await assertRejects(() => createHealthRunPorts(admin).probeApiKey({ provider_code: 'removed',
    auth_method: 'api_key', display_name: 'Removed' }, 'fixture', AbortSignal.timeout(1000)), ProviderReadError);
});

Deno.test('Higgsfield rotated tokens persist after the probe target aborts', async () => {
  const controller = new AbortController();
  let stored = false;
  let finishSave!: () => void;
  const saved = new Promise<void>(resolve => { finishSave = resolve; });
  const admin = createClient('https://database.example.test', 'fixture', { global: { fetch: (async (input, init) => {
    const table = new URL(String(input)).pathname.split('/').pop();
    if (init?.method === 'POST') {
      assertEquals(table, 'provider_api_keys');
      assertEquals(init.signal?.aborted, false, 'rotated-token save needs a live independent deadline');
      stored = true;
      finishSave();
      return new Response(null, { status: 201 });
    }
    return Response.json(table === 'provider_api_keys'
      ? { access_token: 'old', refresh_token: 'unused', expires_at: new Date(0).toISOString(), meta: { redirect_uri: 'https://callback.example.test' } }
      : { client_id: 'fixture-client', client_secret: null, issuer: 'https://mcp.higgsfield.ai', redirect_uri: 'https://callback.example.test' });
  }) as typeof fetch } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    if (String(input).includes('/token')) {
      controller.abort();
      return Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600 });
    }
    if (String(input).includes('oauth-protected-resource')) return Response.json({ authorization_servers: ['https://mcp.higgsfield.ai'] });
    return Response.json({ issuer: 'https://mcp.higgsfield.ai', token_endpoint: 'https://mcp.higgsfield.ai/token', authorization_endpoint: 'https://mcp.higgsfield.ai/authorize' });
  }) as typeof fetch;
  try {
    await assertRejects(() => createHealthRunPorts(admin).probeOAuth({ provider_code: 'higgsfield', oauth_provider: 'higgsfield',
      auth_method: 'oauth', display_name: 'Higgsfield' }, controller.signal));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([saved, new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error('rotated tokens were discarded')), 100); })]); }
    finally { if (timer) clearTimeout(timer); }
    assert(stored);
  } finally { globalThis.fetch = originalFetch; }
});

for (const scenario of ['unreadable', 'empty', 'unknown-model'] as const) {
  Deno.test(`OAuth ${scenario} registry is local incomplete work, never an upstream outage`, async () => {
    const { admin } = fixtureAdmin();
    const registry = () => {
      if (scenario === 'unreadable') throw new Error('registry unavailable');
      return scenario === 'empty' ? [] : [{ id: 'nonexistent-fixture-model' }];
    };
    await assertRejects(() => createHealthRunPorts(admin, undefined, registry).probeOAuth({
      provider_code: 'openrouter', oauth_provider: 'openrouter', auth_method: 'oauth', display_name: 'OpenRouter',
    }, AbortSignal.timeout(1000)), ProviderReadError);
  });
}

Deno.test('the production alert adapter claims only one event for the current send', async () => {
  let limit: unknown;
  const admin = createClient('https://database.example.test', 'fixture', { global: { fetch: (async (_input, init) => {
    limit = JSON.parse(String(init?.body)).p_limit;
    return Response.json([]);
  }) as typeof fetch } });
  await createHealthRunPorts(admin).claimAlerts(crypto.randomUUID(), AbortSignal.timeout(1000));
  assertEquals(limit, 1);
});
