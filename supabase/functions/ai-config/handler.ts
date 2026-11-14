import { runTextListAction, textActionDeps } from "./textListActions.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { restrictedCorsHeaders } from '../_shared/cors.ts';
import { getValidAccessToken } from '../_shared/higgsfield-oauth.ts';
import { HiggsfieldMcpClient } from '../_shared/higgsfield-mcp.ts';
import { createLogger } from '../_shared/logging.ts';
import {
  CatalogSyncError, type CatalogDb, SYNCABLE_PROVIDERS, syncFailureMessage,
} from '../_shared/modelCatalogSyncRun.ts';
import { isBillingBlocked, ProviderTestError } from '../_shared/providerErrors.ts';
import { resolveProviderKey } from '../_shared/providerKeys.ts';
import type { RowReader } from '../_shared/providerEndpoint.ts';
import { loadProbeTarget, probeProvider } from '../_shared/aiProviderTest.ts';
import { readCatalogue } from './readCatalogue.ts';
import { assertProviderUrl } from '../_shared/providerUrlPolicy.ts';
import { syncModels } from './syncModels.ts';
import { chatActionDeps, runChatListAction } from './chatListActions.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || '';

export async function handleAiConfigRequest(req: Request): Promise<Response> {
  // One budget covers authentication and every Chat read/write. The browser
  // waits 30s, leaving room for a response and the bounded refusal-log attempt.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException('Request deadline exceeded', 'TimeoutError')), 25_000);
  const signal = AbortSignal.any([req.signal, deadline.signal]);
  try {
    return await respondToAiConfigRequest(req, signal);
  } catch {
    console.warn({ event: 'ai_config_request_failed', reason: 'configuration_read_or_write_failed' });
    return Response.json({ error: 'configuration_read_or_write_failed' }, { status: 503, headers: restrictedCorsHeaders(req) });
  } finally {
    clearTimeout(timer);
  }
}

async function respondToAiConfigRequest(req: Request, signal: AbortSignal): Promise<Response> {
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

  // Verify user via JWT claims (avoids session lookup failures)
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: { Authorization: authHeader },
      fetch: (url, init) => fetch(url, { ...init, signal }),
    },
  });
  const token = authHeader.replace('Bearer ', '');
  const { data: claimsData, error: claimsError } = await userClient.auth.getClaims(token);
  signal.throwIfAborted();
  if (claimsError || !claimsData?.claims) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const user = { id: claimsData.claims.sub as string, email: claimsData.claims.email as string };

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const url = new URL(req.url);
    const action = url.searchParams.get('action') || 'list';
    // The abortable pipe cancels the sender and errors JSON consumption when
    // the shared deadline expires, including an incomplete streaming body.
    const body = req.method === 'POST'
      ? await new Response(req.body?.pipeThrough(new TransformStream(), { signal })).json()
      : undefined;
    const resolvedAction = url.searchParams.get('action') || body?.action || action;
    signal.throwIfAborted();

    // Chat owns its authorization and refusal logging; do not perform a second
    // role lookup before entering the application boundary.
    if (req.method === 'POST' && (resolvedAction === 'set-text-tier' || resolvedAction === 'inherit-text-category')) {
      const { action: _action, ...input } = body;
      const response = await runTextListAction(resolvedAction, input, textActionDeps(supabase, user.id, signal));
      return new Response(response.body, { status: response.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (req.method === 'POST' && (resolvedAction === 'chat-list-policy' || resolvedAction === 'set-chat-tier')) {
      const input = { ...body };
      delete input.action;
      const response = await runChatListAction(resolvedAction, input, chatActionDeps(supabase, user.id, signal));
      return new Response(response.body, { status: response.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { data: roleData, error: roleError } = await supabase
      .from('user_roles').select('role').eq('user_id', user.id).eq('role', 'admin')
      .abortSignal(signal).maybeSingle();
    if (roleError) throw new Error('Admin check failed');
    const isAdmin = !!roleData;

    // ── GET ──
    if (req.method === 'GET') {
      if (action === 'list') {
        const [pRes, mRes, sRes] = await Promise.all([
          supabase.from('ai_providers').select('*').order('name'),
          readCatalogue(supabase),
          // Widened beyond the default_ai_model* tier rows so the admin UI can also
          // read the model_catalog_synced_at_<code> rows sync-models writes, and the
          // agent_triage_enabled on/off switch.
          supabase.from('system_settings').select('*').or('key.like.default_ai_model%,key.like.model_catalog_synced_at_%,key.eq.agent_triage_enabled'),
        ]);
        if (pRes.error || mRes.error || sRes.error) throw new Error('The AI configuration could not be read');
        return new Response(JSON.stringify({
          providers: pRes.data || [],
          models: mRes.models,
          oauthModels: mRes.oauthModels,
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
          // Same precedence as the runtime (saved key, then env), so the card tests the key requests use.
          const apiKey = await resolveProviderKey(supabase as unknown as RowReader, provider.provider_code);
          if (!apiKey) throw new Error(`API key ${provider.api_key_env_var} not configured`);
          await probeProvider(supabase, provider, apiKey);
          latency = Date.now() - startTime;
          success = true;
        } catch (e: unknown) {
          errorMessage = e instanceof Error ? e.message : 'Connection test failed';
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
          const provider = await loadProbeTarget(supabase as unknown as RowReader, provider_code);
          if (!provider) {
            return new Response(JSON.stringify({ error: 'Unknown provider' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
          await probeProvider(supabase, provider, api_key);
          const latency = Date.now() - startTime;
          await saveKey();
          return new Response(JSON.stringify({ success: true, latency }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        } catch (e: unknown) {
          if (e instanceof ProviderTestError && isBillingBlocked(e.status, e.body)) {
            await saveKey();
            return new Response(JSON.stringify({ success: true, latency: Date.now() - startTime, warning: e.message }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
          return new Response(JSON.stringify({ success: false, error: e instanceof Error ? e.message : 'Provider test failed', latency: Date.now() - startTime }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      }

      if (resolvedAction === 'test-service') {
        if (!isAdmin) return new Response(JSON.stringify({ error: 'Admin required' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const { provider_code } = body;
        if (!provider_code) return new Response(JSON.stringify({ error: 'provider_code required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        // Saved key, then the provider row's env var — the runtime's order. Services
        // without an ai_providers row fall back to their well-known env var.
        const serviceEnv: Record<string, string> = { firecrawl: 'FIRECRAWL_API_KEY', apify: 'APIFY_API_KEY' };
        const apiKey = await resolveProviderKey(supabase as unknown as RowReader, provider_code)
          ?? (serviceEnv[provider_code] ? Deno.env.get(serviceEnv[provider_code]) : undefined);
        if (!apiKey) return new Response(JSON.stringify({ success: false, error: 'No API key configured' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        const startTime = Date.now();
        try {
          const provider = await loadProbeTarget(supabase as unknown as RowReader, provider_code);
          if (!provider) return new Response(JSON.stringify({ error: 'Unknown provider' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          await probeProvider(supabase, provider, apiKey);
          return new Response(JSON.stringify({ success: true, latency: Date.now() - startTime }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        } catch (e: unknown) {
          return new Response(JSON.stringify({ success: false, error: e instanceof Error ? e.message : 'Provider test failed', latency: Date.now() - startTime }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
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
        const dryRun = body.dry_run === true;
        try {
          // The generated client type is too deep for a structural check; it satisfies CatalogDb at runtime.
          const report = await syncModels(supabase as unknown as CatalogDb, provider_code, dryRun);
          return new Response(JSON.stringify(report), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        } catch (e) {
          // 502 would be masked by Cloudflare, so answer 200 with an error body the UI shows as a
          // toast. Only CatalogSyncError text reaches it; database errors stay in the log.
          if (!(e instanceof CatalogSyncError)) {
            await createLogger(supabase, 'ai-config').error('Model catalogue sync failed', {
              event: 'model_sync_failed', provider_code, error: e instanceof Error ? e.message : String(e),
            }, user.id);
          }
          return new Response(JSON.stringify({ error: syncFailureMessage(e) }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
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
        assertProviderUrl(body.api_endpoint);
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
          // The catalogue is keyed by credential kind; an admin adds an API-key model.
          auth_method: 'api_key',
        }).select().single();
        if (error) throw new Error(error.message);
        return new Response(JSON.stringify({ success: true, model: data }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error: unknown) {
    signal.throwIfAborted();
    const message = 'AI configuration failed. Please try again.';
    console.error('AI Config Error:', error instanceof Error ? error.name : 'error');
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}
