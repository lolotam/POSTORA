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
      if (table === 'system_settings') {
        if (url.searchParams.get('select') === 'value') return Response.json({ value: false });
        if (url.searchParams.get('key')?.includes('default_ai_model_')) return Response.json([{ key: 'default_ai_model_chat', value: { provider_code: 'claude', model_id: model } }]);
        return Response.json(['feature_ai_text_auth_lists', 'feature_ai_provider_oauth'].map(key => ({ key, value: scenario !== 'flag_off' })));
      }
      if (table === 'app_settings') return Response.json({ value: false });
      if (table === 'user_feature_overrides') return Response.json(null);
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

// Round 2: the runtime floor serves inherited Chat and category ladders alike.
for (const enabled of [false, true]) {
  for (const customized of [false, true]) {
    for (const available of [false, true]) {
      for (const choice of ['oauth', 'floor', 'displaced'] as const) {
        Deno.test(`override floor enabled=${enabled} customized=${customized} available=${available} choice=${choice}`, async () => {
          const previous = Deno.env.get('GOOGLE_AI_STUDIO_KEY');
          Deno.env.delete('GOOGLE_AI_STUDIO_KEY');
          let writes = 0;
          const signal = AbortSignal.timeout(2000);
          const codex = { provider_code: 'openai', model_id: 'gpt-5.4', auth_method: 'oauth' };
          const rows = ['chat', ...(customized ? ['caption', 'hashtags'] : [])].flatMap(category => [
            { key: `default_ai_model_${category}`, value: codex },
            ...(choice === 'displaced' ? [{ key: `default_ai_model_${category}_fallback`, value: codex }] : []),
          ]);
          const db = createClient('https://fixture.invalid', crypto.randomUUID(), { global: { fetch: async (input, init) => {
            assertEquals(init?.signal, signal);
            const url = new URL(String(input));
            const table = url.pathname.split('/').at(-1);
            if (table === 'user_roles') return Response.json({ role: 'admin' });
            if (table === 'system_logs') return Response.json(null);
            if (table === 'write_ai_model_override') { writes++; return Response.json(true); }
            if (table === 'system_settings') {
              if (url.searchParams.get('select') === 'value') return Response.json({ value: enabled });
              if (url.searchParams.has('or')) return Response.json(rows.filter(row => row.key.includes('chat')));
              const keys = url.searchParams.get('key');
              if (keys?.includes('default_ai_model_')) return Response.json(rows.filter(row => keys.includes(row.key)));
              return Response.json(['feature_ai_text_auth_lists', 'feature_ai_provider_oauth', 'feature_ai_category_text_ladders']
                .map(key => ({ key, value: key === 'feature_ai_category_text_ladders' ? enabled : true })));
            }
            if (table === 'ai_providers') return Response.json(['openai', 'google'].map(provider_code => ({ id: provider_code, provider_code, name: provider_code, is_active: true })));
            if (table === 'provider_api_keys') return Response.json(!available && url.searchParams.get('provider_code') === 'eq.gemini' ? null : { api_key: crypto.randomUUID() });
            if (table === 'user_ai_model_overrides') return Response.json([]);
            if (table === 'ai_models') return Response.json(Number(url.searchParams.get('offset')) === 0
              ? [{ id: 'floor', provider_id: 'google', model_id: 'gemini-3-flash-preview', name: 'Floor', is_active: true, capabilities: ['chat'], auth_method: 'api_key' }] : []);
            if (table === 'get_ai_oauth_statuses') return Response.json([{ provider_code: 'openai', status: 'connected' }]);
            if (table === 'app_settings') return Response.json({ value: false });
            if (table === 'user_feature_overrides') return Response.json(null);
            throw new Error(`Unexpected floor read ${table}`);
          } } });
          try {
            const value = { ...(choice === 'floor' ? { provider_code: 'google', model_id: 'gemini-3-flash-preview', auth_method: 'api_key' } : codex), expires_at: null, reason: null };
            const response = await runUserOverrideAction({ user_id, expected: null, value }, db, actor, signal);
            const usable = available && choice !== 'displaced';
            assertEquals(await response.json(), usable ? { success: true } : { error: 'ai_output_cap_unsupported' });
            assertEquals(response.status, usable ? 200 : 409);
            assertEquals(writes, usable ? 1 : 0);
          } finally {
            if (previous !== undefined) Deno.env.set('GOOGLE_AI_STUDIO_KEY', previous);
          }
        });
      }
    }
  }
}

for (const outcome of ['deleted', 'conflict', 'not_admin'] as const) {
  Deno.test(`override removal ${outcome} never reads unavailable routing or readiness`, async () => {
    const reads: string[] = [];
    const writes: Array<Record<string, unknown>> = [];
    const signal = AbortSignal.timeout(1000);
    const expected = { id: crypto.randomUUID(), auth_method: 'oauth' };
    const db = createClient('https://fixture.invalid', crypto.randomUUID(), { global: { fetch: async (input, init) => {
      const table = new URL(String(input)).pathname.split('/').at(-1)!;
      reads.push(table);
      if (table === 'user_roles') return Response.json(outcome === 'not_admin' ? null : { role: 'admin' });
      if (table === 'system_logs') return Response.json(null);
      if (table === 'write_ai_model_override') {
        assertEquals(init?.signal, signal);
        writes.push(JSON.parse(String(init?.body)));
        return Response.json(outcome !== 'conflict');
      }
      return Response.json({ message: 'routing and readiness unavailable' }, { status: 503 });
    } } });
    const response = await runUserOverrideAction({ user_id, expected, value: null }, db, actor, signal);
    assertEquals(await response.json(), outcome === 'deleted' ? { success: true } : { error: outcome === 'conflict' ? 'configuration_changed_retry' : 'not_admin' });
    assertEquals(response.status, outcome === 'deleted' ? 200 : outcome === 'conflict' ? 409 : 403);
    assertEquals(reads, outcome === 'not_admin' ? ['user_roles', 'system_logs'] : outcome === 'deleted' ? ['user_roles', 'write_ai_model_override'] : ['user_roles', 'write_ai_model_override', 'system_logs']);
    assertEquals(writes, outcome === 'not_admin' ? [] : [{ p_user_id: user_id, p_expected: expected, p_value: null, p_actor: actor }]);
  });
}

for (const category of ['caption', 'hashtags'] as const) {
  for (const scenario of ['displaced', 'inherited', 'claude', 'api', 'user_first', 'user_only_missing', 'expired', 'delete', 'read_failed'] as const) {
    Deno.test(`override cap validation ${category}/${scenario} checks the composed three tiers before writing`, async () => {
      let writes = 0;
      const capTier = (provider_code: string) => ({ provider_code, model_id: provider_code === 'openai' ? 'gpt-5.4' : model, auth_method: 'oauth' });
      const rows = [
        { key: 'feature_ai_category_text_ladders', value: true },
        { key: `default_ai_model_${category === 'caption' ? 'hashtags' : 'caption'}`, value: capTier('claude') },
        ...['', '_fallback', '_fallback_2'].map((suffix, i) => ({ key: `default_ai_model_${scenario === 'inherited' ? 'chat' : category}${suffix}`, value: capTier(i === 2 ? 'claude' : 'openai') })),
      ];
      const db = createClient('https://fixture.invalid', crypto.randomUUID(), { global: { fetch: async (input, init) => {
        assert(init?.signal, 'all reads and writes share a bounded request');
        const url = new URL(String(input));
        const table = url.pathname.split('/').at(-1);
        if (table === 'user_roles') return Response.json({ role: 'admin' });
        if (table === 'system_logs') return Response.json(null);
        if (table === 'write_ai_model_override') { writes++; return Response.json(true); }
        if (table === 'system_settings') {
          if (scenario === 'read_failed' && url.searchParams.get('key')?.includes(category)) return Response.json({ message: 'private SQL' }, { status: 500 });
          if (url.searchParams.get('select') === 'value') return Response.json({ value: true });
          if (url.searchParams.has('or')) return Response.json(rows.filter(row => row.key.includes('chat')));
          if (url.searchParams.get('key')?.includes('default_ai_model_')) return Response.json(rows.filter(row => url.searchParams.get('key')!.includes(row.key)));
          return Response.json(['feature_ai_text_auth_lists', 'feature_ai_provider_oauth', 'feature_ai_category_text_ladders'].map(key => ({ key, value: true })));
        }
        if (table === 'ai_providers') return Response.json(['openai', 'claude'].map(provider_code => ({ id: provider_code, provider_code, name: provider_code, is_active: true })));
        if (table === 'provider_api_keys') return Response.json({ api_key: crypto.randomUUID() });
        if (table === 'user_ai_model_overrides') return Response.json([]);
        if (table === 'ai_models') return Response.json(Number(url.searchParams.get('offset')) === 0 ? [{ id: 'api', provider_id: 'openai', model_id: 'gpt-5.4', name: 'API', is_active: true, capabilities: ['chat'], auth_method: 'api_key' }] : []);
        if (table === 'get_ai_oauth_statuses') return Response.json(['claude', 'openai'].map(provider_code => ({ provider_code, status: 'connected' })));
        if (table === 'app_settings') return Response.json({ value: true });
        if (table === 'user_feature_overrides') return Response.json(null);
        if (table === 'user_ai_routing_preferences') return Response.json([{ capability: 'chat', mode: scenario === 'user_first' ? 'user_first' : scenario === 'user_only_missing' ? 'user_only' : 'postora_only', allow_platform_fallback: true, preferred_provider_code: 'openai', preferred_model_id: 'own' }]);
        if (table === 'get_user_ai_provider_key_snapshot') return Response.json(scenario === 'user_only_missing' ? [] : [{ api_key: crypto.randomUUID(), updated_at: new Date().toISOString() }]);
        throw new Error(`Unexpected cap validation read ${table}`);
      } } });
      const value = scenario === 'delete' ? null : { ...capTier(scenario === 'claude' ? 'claude' : 'openai'),
        ...(scenario === 'api' ? { auth_method: 'api_key' } : {}), expires_at: scenario === 'expired' ? '2000-01-01T00:00:00Z' : null, reason: null };
      const response = await runUserOverrideAction({ user_id, value, expected: null }, db, actor, AbortSignal.timeout(2000));
      const success = ['claude', 'api', 'user_first', 'expired', 'delete'].includes(scenario);
      assertEquals(await response.json(), success ? { success: true } : { error: scenario === 'read_failed' ? 'configuration_read_or_write_failed' : 'ai_output_cap_unsupported' });
      assertEquals(response.status, success ? 200 : scenario === 'read_failed' ? 503 : 409);
      assertEquals(writes, success ? 1 : 0);
    });
  }
}
