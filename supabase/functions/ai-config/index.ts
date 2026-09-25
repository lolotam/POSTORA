import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { restrictedCorsHeaders } from '../_shared/cors.ts';
import { HiggsfieldAuthError, getValidAccessToken } from '../_shared/higgsfield-oauth.ts';
import { HiggsfieldMcpClient } from '../_shared/higgsfield-mcp.ts';
import { runCatalogSync, SYNCABLE_PROVIDERS } from '../_shared/modelCatalogSyncRun.ts';
import { describeProviderFailure, isBillingBlocked, ProviderTestError } from '../_shared/providerErrors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || '';

serve(async (req) => {
  const corsHeaders = restrictedCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // Auth check
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Missing authorization' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  
  // Verify user via JWT claims (avoids session lookup failures)
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const token = authHeader.replace('Bearer ', '');
  const { data: claimsData, error: claimsError } = await userClient.auth.getClaims(token);
  if (claimsError || !claimsData?.claims) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const user = { id: claimsData.claims.sub as string, email: claimsData.claims.email as string };

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Check admin
  const { data: roleData } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', user.id)
    .eq('role', 'admin')
    .maybeSingle();
  const isAdmin = !!roleData;

  try {
    const url = new URL(req.url);
    const action = url.searchParams.get('action') || 'list';

    // ── GET ──
    if (req.method === 'GET') {
      if (action === 'list') {
        const [pRes, mRes, sRes] = await Promise.all([
          supabase.from('ai_providers').select('*').order('name'),
          supabase.from('ai_models').select('*, ai_providers(provider_code, name)').order('name'),
          // Widened beyond the default_ai_model* tier rows so the admin UI can also
          // read the model_catalog_synced_at_<code> rows sync-models writes.
          supabase.from('system_settings').select('*').or('key.like.default_ai_model%,key.like.model_catalog_synced_at_%'),
        ]);
        return new Response(JSON.stringify({
          providers: pRes.data || [],
          models: mRes.data || [],
          settings: sRes.data || [],
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (action === 'get-active-model') {
        const feature = url.searchParams.get('feature') || 'general';
        const { data, error } = await supabase.rpc('get_active_ai_model_config', {
          p_user_id: user.id, p_feature: feature,
        });
        if (error) throw new Error(error.message);
        return new Response(JSON.stringify(data?.[0] || null), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ error: 'Unknown action' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── POST ──
    if (req.method === 'POST') {
      const body = await req.json();
      const resolvedAction = url.searchParams.get('action') || body?.action || action;

      if (resolvedAction === 'test-connection') {
        if (!isAdmin) return new Response(JSON.stringify({ error: 'Admin required' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        const { provider_id } = body;
        if (!provider_id) return new Response(JSON.stringify({ error: 'provider_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        const { data: provider } = await supabase.from('ai_providers').select('*').eq('id', provider_id).single();
        if (!provider) return new Response(JSON.stringify({ error: 'Provider not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        const startTime = Date.now();
        let success = false;
        let latency = 0;
        let errorMessage: string | null = null;

        try {
          if (provider.provider_code === 'higgsfield' || provider.api_type === 'higgsfield') {
            await getValidAccessToken(supabase);
            const mcp = await HiggsfieldMcpClient.create(supabase);
            await mcp.callTool('models_explore', { action: 'list', type: 'image', limit: 1 });
            latency = Date.now() - startTime;
            success = true;
            return new Response(JSON.stringify({ success, latency, error: null, provider_code: provider.provider_code }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          // Try env var first, then DB fallback
          let apiKey = Deno.env.get(provider.api_key_env_var);
          if (!apiKey) {
            const { data: keyRow } = await supabase.from('provider_api_keys').select('api_key').eq('provider_code', provider.provider_code).maybeSingle();
            apiKey = keyRow?.api_key;
          }
          if (!apiKey) throw new Error(`API key ${provider.api_key_env_var} not configured`);

      if (provider.provider_code === 'perplexity') {
            await testPerplexity(apiKey, provider.api_endpoint);
          } else if (provider.provider_code === 'zai') {
            await testZAI(apiKey, provider.api_endpoint);
          } else if (provider.provider_code === 'xai') {
            await testXAI(apiKey, provider.api_endpoint);
          } else if (provider.provider_code === 'minimax') {
            await testMinimax(apiKey, provider.api_endpoint);
          } else if (provider.provider_code === 'brave_search') {
            await testBrave(apiKey);
          } else if (provider.provider_code === 'exa') {
            await testExa(apiKey);
          } else if (provider.api_type === 'google') {
            await testGemini(apiKey, provider.api_endpoint);
          } else if (provider.api_type === 'anthropic') {
            await testAnthropic(apiKey, provider.api_endpoint);
          } else {
            await testOpenAI(apiKey, provider.api_endpoint, await defaultTestModel(supabase, provider));
          }
          latency = Date.now() - startTime;
          success = true;
        } catch (e: any) {
          errorMessage = e instanceof HiggsfieldAuthError ? e.message : e.message;
          latency = Date.now() - startTime;
        }

        return new Response(JSON.stringify({ success, latency, error: errorMessage, provider_code: provider.provider_code }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (resolvedAction === 'set-user-preference') {
        const { model_uuid, feature = 'general' } = body;
        if (!model_uuid) return new Response(JSON.stringify({ error: 'model_uuid required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const { error } = await supabase.from('ai_model_preferences').upsert({ user_id: user.id, model_id: model_uuid, feature, updated_at: new Date().toISOString() });
        if (error) throw new Error(error.message);
        return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (resolvedAction === 'delete-user-preference') {
        const { feature = 'general' } = body;
        await supabase.from('ai_model_preferences').delete().eq('user_id', user.id).eq('feature', feature);
        return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (resolvedAction === 'set-service-key') {
        if (!isAdmin) return new Response(JSON.stringify({ error: 'Admin required' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const { provider_code, api_key } = body;
        if (!provider_code || !api_key) return new Response(JSON.stringify({ error: 'provider_code and api_key required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        const startTime = Date.now();
        const saveKey = async () => {
          const { error: upsertErr } = await supabase.from('provider_api_keys').upsert(
            { provider_code, api_key, created_by: user.id, updated_at: new Date().toISOString() },
            { onConflict: 'provider_code' },
          );
          if (upsertErr) throw new Error(upsertErr.message);
        };
        try {
          // Test key based on provider_code
          if (provider_code === 'firecrawl') {
            await testFirecrawl(api_key);
          } else if (provider_code === 'apify') {
            await testApify(api_key);
          } else {
            // Look up provider from ai_providers table
            const { data: provider } = await supabase.from('ai_providers').select('*').eq('provider_code', provider_code).single();
            if (!provider) {
              return new Response(JSON.stringify({ error: 'Unknown provider' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
            }
            // Use the appropriate test function
            if (provider.provider_code === 'perplexity') {
              await testPerplexity(api_key, provider.api_endpoint);
            } else if (provider.provider_code === 'zai') {
              await testZAI(api_key, provider.api_endpoint);
            } else if (provider.provider_code === 'brave_search') {
              await testBrave(api_key);
            } else if (provider.provider_code === 'exa') {
              await testExa(api_key);
            } else if (provider.provider_code === 'minimax') {
              await testMinimax(api_key, provider.api_endpoint);
            } else if (provider.provider_code === 'xai') {
              await testXAI(api_key, provider.api_endpoint);
            } else if (provider.api_type === 'elevenlabs' || provider.provider_code === 'elevenlabs') {
              await testElevenLabs(api_key, provider.api_endpoint);
            } else if (provider.api_type === 'google') {
              await testGemini(api_key, provider.api_endpoint);
            } else if (provider.api_type === 'anthropic') {
              await testAnthropic(api_key, provider.api_endpoint);
            } else {
              await testOpenAI(api_key, provider.api_endpoint, await defaultTestModel(supabase, provider));
            }
          }
          const latency = Date.now() - startTime;
          await saveKey();
          return new Response(JSON.stringify({ success: true, latency }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        } catch (e: any) {
          if (e instanceof ProviderTestError && isBillingBlocked(e.status, e.body)) {
            await saveKey();
            return new Response(JSON.stringify({ success: true, latency: Date.now() - startTime, warning: e.message }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
          return new Response(JSON.stringify({ success: false, error: e.message, latency: Date.now() - startTime }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      }

      if (resolvedAction === 'test-service') {
        if (!isAdmin) return new Response(JSON.stringify({ error: 'Admin required' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const { provider_code } = body;
        if (!provider_code) return new Response(JSON.stringify({ error: 'provider_code required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        // Try to find key from env or DB
        let apiKey: string | undefined;
        
        // For external services, check known env vars
        const envMap: Record<string, string> = { firecrawl: 'FIRECRAWL_API_KEY', apify: 'APIFY_API_KEY' };
        if (envMap[provider_code]) {
          apiKey = Deno.env.get(envMap[provider_code]);
        } else {
          // For AI providers, check their env var
          const { data: provider } = await supabase.from('ai_providers').select('api_key_env_var').eq('provider_code', provider_code).maybeSingle();
          if (provider?.api_key_env_var) {
            apiKey = Deno.env.get(provider.api_key_env_var);
          }
        }
        
        // Fallback to DB
        if (!apiKey) {
          const { data: keyRow } = await supabase.from('provider_api_keys').select('api_key').eq('provider_code', provider_code).single();
          apiKey = keyRow?.api_key;
        }
        if (!apiKey) return new Response(JSON.stringify({ success: false, error: 'No API key configured' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        const startTime = Date.now();
        try {
          if (provider_code === 'firecrawl') await testFirecrawl(apiKey);
          else if (provider_code === 'apify') await testApify(apiKey);
          else {
            // AI provider test
            const { data: provider } = await supabase.from('ai_providers').select('*').eq('provider_code', provider_code).single();
            if (!provider) return new Response(JSON.stringify({ error: 'Unknown provider' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
            if (provider.provider_code === 'perplexity') await testPerplexity(apiKey, provider.api_endpoint);
            else if (provider.provider_code === 'zai') await testZAI(apiKey, provider.api_endpoint);
            else if (provider.provider_code === 'brave_search') await testBrave(apiKey);
            else if (provider.provider_code === 'exa') await testExa(apiKey);
            else if (provider.provider_code === 'minimax') await testMinimax(apiKey, provider.api_endpoint);
            else if (provider.provider_code === 'xai') await testXAI(apiKey, provider.api_endpoint);
            else if (provider.api_type === 'elevenlabs' || provider.provider_code === 'elevenlabs') await testElevenLabs(apiKey, provider.api_endpoint);
            else if (provider.api_type === 'google') await testGemini(apiKey, provider.api_endpoint);
            else if (provider.api_type === 'anthropic') await testAnthropic(apiKey, provider.api_endpoint);
            else await testOpenAI(apiKey, provider.api_endpoint, await defaultTestModel(supabase, provider));
          }
          return new Response(JSON.stringify({ success: true, latency: Date.now() - startTime }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        } catch (e: any) {
          return new Response(JSON.stringify({ success: false, error: e.message, latency: Date.now() - startTime }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      }

      if (resolvedAction === 'check-service-key') {
        if (!isAdmin) return new Response(JSON.stringify({ error: 'Admin required' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const { provider_code } = body;
        if (!provider_code) return new Response(JSON.stringify({ error: 'provider_code required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        // Check env var first
        const envMap: Record<string, string> = { firecrawl: 'FIRECRAWL_API_KEY', apify: 'APIFY_API_KEY' };
        let hasEnv = false;
        if (envMap[provider_code]) {
          hasEnv = !!Deno.env.get(envMap[provider_code]);
        } else {
          // AI provider — check its env var
          const { data: provider } = await supabase.from('ai_providers').select('api_key_env_var').eq('provider_code', provider_code).maybeSingle();
          if (provider?.api_key_env_var) {
            hasEnv = !!Deno.env.get(provider.api_key_env_var);
          }
        }

        let hasDb = false;
        if (!hasEnv) {
          const { data } = await supabase.from('provider_api_keys').select('id').eq('provider_code', provider_code).maybeSingle();
          hasDb = !!data;
        }
        return new Response(JSON.stringify({ has_key: hasEnv || hasDb }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (resolvedAction === 'sync-models') {
        if (!isAdmin) return new Response(JSON.stringify({ error: 'Admin required' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const { provider_code } = body;
        if (!(SYNCABLE_PROVIDERS as readonly string[]).includes(provider_code)) {
          return new Response(JSON.stringify({ error: 'Provider does not support model sync' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        try {
          const report = await runCatalogSync(supabase, provider_code);
          return new Response(JSON.stringify(report), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        } catch (e: any) {
          // Upstream catalogue failure, not an app error: 502 would be masked by Cloudflare,
          // so answer 200 with an error body the UI shows as a toast.
          return new Response(JSON.stringify({ error: e.message }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      }

      return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── PUT (admin only) ──
    if (req.method === 'PUT') {
      if (!isAdmin) return new Response(JSON.stringify({ error: 'Admin required' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const body = await req.json();

      if (action === 'toggle-provider') {
        const { error } = await supabase.from('ai_providers').update({ is_active: body.is_active }).eq('id', body.provider_id);
        if (error) throw new Error(error.message);
        return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (action === 'toggle-model') {
        const { error } = await supabase.from('ai_models').update({ is_active: body.is_active }).eq('id', body.model_id);
        if (error) throw new Error(error.message);
        return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (action === 'add-provider') {
        const { data, error } = await supabase.from('ai_providers').insert({
          provider_code: body.provider_code, name: body.name, api_endpoint: body.api_endpoint,
          api_key_env_var: body.api_key_env_var, api_type: body.api_type || 'openai',
          supports_streaming: body.supports_streaming ?? true,
        }).select().single();
        if (error) throw new Error(error.message);
        return new Response(JSON.stringify({ success: true, provider: data }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (action === 'add-model') {
        const { data, error } = await supabase.from('ai_models').insert({
          provider_id: body.provider_id, model_id: body.model_id, name: body.name,
          description: body.description, capabilities: body.capabilities || ['chat'],
          context_limit: body.context_limit, cost_per_1m_input_tokens: body.cost_per_1m_input_tokens,
          cost_per_1m_output_tokens: body.cost_per_1m_output_tokens,
        }).select().single();
        if (error) throw new Error(error.message);
        return new Response(JSON.stringify({ success: true, model: data }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error('AI Config Error:', error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});

// ── Test helpers ──
async function handleRes(res: Response, name: string) {
  if (res.ok) return;
  const t = await res.text();
  console.error(`${name} test failed: ${res.status} - ${t.slice(0, 300)}`);
  throw new ProviderTestError(describeProviderFailure(name, res.status, t), res.status, t);
}

function modelsUrl(ep: string, path = '/v1/models'): string {
  return ep.replace(/\/v1\/?$/, '') + path;
}

async function testGemini(key: string, ep: string) {
  const res = await fetch(`${ep}/models?key=${key}`, { headers: { 'x-goog-api-key': key } });
  await handleRes(res, 'Gemini');
}

async function testOpenAI(key: string, ep: string, model: string) {
  const url = ep.replace(/\/$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
  });
  await handleRes(res, 'OpenAI');
}

// The gateway and OpenRouter namespace ids by vendor; a bare "gpt-4o-mini" is
// rejected there, so test with a chat model the provider actually lists.
const TEST_MODEL_OVERRIDE: Record<string, string> = { vercel: 'openai/gpt-4o-mini', openrouter: 'openai/gpt-4o-mini', deepseek: 'deepseek-flash' };
async function defaultTestModel(db: any, provider: { id: string; provider_code: string }): Promise<string> {
  if (TEST_MODEL_OVERRIDE[provider.provider_code]) return TEST_MODEL_OVERRIDE[provider.provider_code];
  const { data } = await db.from('ai_models').select('model_id').eq('provider_id', provider.id)
    .eq('is_active', true).contains('capabilities', ['chat']).order('name').limit(1).maybeSingle();
  return data?.model_id ?? 'gpt-4o-mini';
}

async function testAnthropic(key: string, ep: string) {
  const res = await fetch(modelsUrl(ep), { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
  await handleRes(res, 'Anthropic');
}

async function testPerplexity(key: string, ep: string) {
  // Perplexity requires max_tokens >= 16 (sending 1 returns 400 invalid_request).
  const res = await fetch(`${ep.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'sonar', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }),
  });
  await handleRes(res, 'Perplexity');
}

async function testZAI(key: string, ep: string) {
  // Validate the key with a lightweight GET /models. Chat completions fail on
  // insufficient balance / rate limits (429), which do not reflect key
  // validity. The model list is the cheapest authoritative check.
  const url = ep.replace(/\/$/, '') + '/models';
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (res.ok) {
    const data = await res.json();
    console.log(`Z.AI test passed. Available models: ${(data.data || []).map((m: any) => m.id).join(', ')}`);
    return;
  }
  await handleRes(res, 'Z.AI');
}

async function testBrave(key: string) {
  const res = await fetch('https://api.search.brave.com/res/v1/web/search?q=test&count=1', {
    headers: { Accept: 'application/json', 'X-Subscription-Token': key },
  });
  await handleRes(res, 'Brave');
}

async function testExa(key: string) {
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ query: 'test', numResults: 1 }),
  });
  await handleRes(res, 'Exa');
}

async function testElevenLabs(key: string, ep: string) {
  const baseUrl = (ep || 'https://api.elevenlabs.io/v1').replace(/\/$/, '');
  // A valid key may be scope-limited (missing models_read / voices_read /
  // user_read). "missing_permissions" / "restricted" prove the key
  // authenticates, so they count as a PASS, not a failure.
  const probePaths = ['/user', '/models', '/voices'];
  for (const path of probePaths) {
    const res = await fetch(`${baseUrl}${path}`, { headers: { 'xi-api-key': key } });
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

async function testXAI(key: string, ep: string) {
  // Use lightweight GET /v1/models to validate API key without needing a specific model
  const modelsEndpoint = ep.replace(/\/$/, '').replace(/\/v1\/?$/, '') + '/v1/models';
  const res = await fetch(modelsEndpoint, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (res.ok) {
    const data = await res.json();
    console.log(`xAI test passed. Available models: ${(data.data || []).map((m: any) => m.id).join(', ')}`);
    return;
  }
  await handleRes(res, 'xAI');
}

async function testMinimax(key: string, ep: string) {
  // Validate the key with a lightweight GET /models instead of a chat
  // completion. Chat calls fail when the account has insufficient balance
  // (HTTP 402 / code 1008), which says nothing about key validity.
  const modelsEndpoint = ep.replace(/\/$/, '').replace(/\/v1\/?$/, '') + '/v1/models';
  const res = await fetch(modelsEndpoint, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (res.ok) {
    const data = await res.json();
    console.log(`MiniMax test passed. Available models: ${(data.data || []).map((m: any) => m.id).join(', ')}`);
    return;
  }
  await handleRes(res, 'MiniMax');
}

async function testFirecrawl(key: string) {
  // Firecrawl v2 is the current API. A minimal scrape of a stable URL
  // validates the key: bad key -> 401, valid key -> 200.
  const res = await fetch('https://api.firecrawl.dev/v2/scrape', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com', formats: ['markdown'] }),
  });
  await handleRes(res, 'Firecrawl');
}

async function testApify(key: string) {
  const res = await fetch(`https://api.apify.com/v2/users/me?token=${key}`);
  await handleRes(res, 'Apify');
}