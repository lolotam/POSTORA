import { assertEquals, assert } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { runUserOverrideAction } from './userOverrideActions.ts';

const actor = '55555555-5555-4555-8555-555555555551';
const user_id = '55555555-5555-4555-8555-555555555552';
const model = 'claude-sonnet-4-5';
for (const scenario of ['saved', 'api', 'not_admin', 'strict_auth', 'injected_key', 'flag_off', 'status_failed', 'schema_missing', 'catalogue_failed', 'inactive', 'conflict', 'delete'] as const) {
  Deno.test(`override admin boundary ${scenario}: authorization, discriminator, readiness and CAS`, async () => {
    const writes: Array<Record<string, unknown>> = [];
    const logs: unknown[] = [];
    const signal = AbortSignal.timeout(2000);
    let catalogPage = 0;
    const admin = createClient('https://fixture.invalid', crypto.randomUUID(), { global: { fetch: async (input, init) => {
      assert(init?.signal, 'every new DB operation must carry the request signal');
      const url = new URL(String(input));
      const table = url.pathname.split('/').at(-1);
      if (table === 'user_roles') return Response.json(scenario === 'not_admin' ? null : { role: 'admin' });
      if (table === 'system_logs') { logs.push(JSON.parse(String(init?.body))); return Response.json([]); }
      if (table === 'write_ai_model_override') { writes.push(JSON.parse(String(init?.body))); return Response.json(scenario !== 'conflict'); }
      if (table === 'system_settings') return Response.json(['feature_ai_text_auth_lists', 'feature_ai_provider_oauth'].map(key => ({ key, value: scenario !== 'flag_off' })));
      if (table === 'ai_providers') return Response.json([{ id: 'p', provider_code: 'claude', name: 'Claude', is_active: scenario !== 'inactive' }]);
      if (table === 'provider_api_keys') return Response.json({ api_key: crypto.randomUUID() });
      if (table === 'user_ai_model_overrides') return scenario === 'schema_missing' ? Response.json({ message: 'missing migration' }, { status: 400 }) : Response.json([]);
      if (table === 'ai_models') {
        if (scenario === 'catalogue_failed') return Response.json({ message: 'private database text' }, { status: 500 });
        return Response.json(catalogPage++ ? [] : [{ id: 'm', provider_id: 'p', model_id: model, name: 'Same', is_active: true, capabilities: ['chat'], auth_method: 'api_key', ai_providers: { provider_code: 'claude' } }]);
      }
      if (table === 'get_ai_oauth_statuses') return scenario === 'status_failed' ? Response.json({ message: 'private SQL' }, { status: 500 }) : Response.json([{ provider_code: 'claude', status: 'connected' }]);
      throw new Error(`Unexpected DB table ${table}`);
    } } });
    const expected = { id: 'existing', auth_method: 'api_key' };
    const value = scenario === 'delete' ? null : { provider_code: 'claude', model_id: model,
      auth_method: scenario === 'strict_auth' ? 'typo' : scenario === 'api' ? 'api_key' : 'oauth', expires_at: null, reason: null,
      ...(scenario === 'injected_key' ? { api_key: crypto.randomUUID() } : {}) };
    const response = await runUserOverrideAction({ user_id, value, expected }, admin, actor, signal);
    const body = await response.json();
    const success = ['saved', 'api', 'delete'].includes(scenario);
    assertEquals(response.status, success ? 200 : scenario === 'not_admin' ? 403 : ['strict_auth', 'injected_key'].includes(scenario) ? 400 : ['status_failed', 'schema_missing', 'catalogue_failed'].includes(scenario) ? 503 : 409);
    assertEquals(writes.length, success || scenario === 'conflict' ? 1 : 0);
    if (writes.length) assertEquals(writes[0], { p_user_id: user_id, p_value: value, p_expected: expected, p_actor: actor });
    assertEquals(logs.length, success ? 0 : 1);
    assertEquals(JSON.stringify(body).includes('private'), false);
  });
}
