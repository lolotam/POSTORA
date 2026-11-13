import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createHealthHandlerPorts, createHealthRunPorts } from './deps.ts';

Deno.test('cron-secret requests reach the in-handler authorizer through the gateway', async () => {
  const config = await Deno.readTextFile(new URL('../../config.toml', import.meta.url));
  const section = config.split('[functions.ai-provider-health]')[1]?.split('[functions.')[0];
  assert(section && /verify_jwt\s*=\s*false/.test(section));
});

// HTTP is the seam: the real Supabase query builder and production adapters run.
function fixtureAdmin() {
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
    assert(init?.signal, 'database transport must carry cancellation');
    let rows = tables[url.pathname.split('/').pop() ?? ''] ?? [];
    for (const [column, filter] of url.searchParams) {
      if (filter.startsWith('eq.')) rows = rows.filter((row) => String(row[column]) === filter.slice(3));
      if (filter.startsWith('in.(')) rows = rows.filter((row) => filter.slice(4, -1).split(',').includes(String(row[column])));
    }
    return new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { admin: createClient('https://database.example.test', 'fixture-service-key', { global: { fetch: transport } }), requests };
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
