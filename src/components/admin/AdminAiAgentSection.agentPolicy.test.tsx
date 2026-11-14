import { createClient } from '@supabase/supabase-js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const { clientRef } = vi.hoisted(() => ({ clientRef: { current: undefined as unknown } }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: new Proxy({}, { get: (_target, property) => Reflect.get(clientRef.current as object, property) }) }));
import { AdminAiAgentSection } from './AdminAiAgentSection';
afterEach(() => vi.restoreAllMocks());

it.each([['Primary', 'primary'], ['Fallback', 'fallback'], ['Fallback 2', 'fallback_2']])('saves Agent %s through the authoritative gateway and preserves refused selections', async (label, slot) => {
  const writes: unknown[] = [];
  let refuse = false;
  const settings = ['', '_fallback', '_fallback_2'].map(suffix => ({ key: `default_ai_model_agent${suffix}`, value: { provider_code: 'claude', model_id: 'saved', auth_method: 'oauth' } }));
  const policy = { enabled: true, groups: [], triageGroups: [], agentGroups: [{ provider_code: 'claude', auth_method: 'oauth', name: 'Claude subscription', reason: null, synced_at: null,
    models: ['saved', 'requested', 'refused'].map(model_id => ({ model_id, name: model_id, provisional: true, reason: null })) }] };
  const client = createClient('https://database.example.test', crypto.randomUUID(), { auth: { persistSession: false }, global: { fetch: async (url, init) => {
    const target = new URL(String(url));
    if (target.pathname.endsWith('/ai-config')) {
      const input = JSON.parse(String(init?.body));
      if (input.action === 'set-agent-tier') {
        writes.push(input);
        if (refuse) return Response.json({ error: 'oauth_api_fallback_required' }, { status: 409 });
        settings.find(row => row.key === `default_ai_model_agent${input.slot === 'primary' ? '' : `_${input.slot}`}`)!.value = { provider_code: input.provider_code, model_id: input.model_id, auth_method: input.auth_method };
        return Response.json({ success: true });
      }
      return Response.json(policy);
    }
    if (target.pathname.endsWith('/system_settings')) return Response.json(settings);
    return Response.json([]);
  } } });
  vi.spyOn(client.auth, 'getSession').mockResolvedValue({ data: { session: { access_token: crypto.randomUUID(), user: { id: 'admin' } } }, error: null } as never);
  clientRef.current = client;
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={queries}><AdminAiAgentSection /></QueryClientProvider>);
  try {
    const region = within(screen.getByRole('region', { name: 'Messaging Agent model configuration' }));
    const picker = await region.findByRole('combobox', { name: `${label} model` });
    expect(writes).toEqual([]);
    fireEvent.change(picker, { target: { value: 'requested' } });
    await waitFor(() => expect(picker).toHaveValue('requested'));
    expect(writes).toEqual([{ action: 'set-agent-tier', category: 'agent', slot, provider_code: 'claude', model_id: 'requested', auth_method: 'oauth', expected:
      Object.fromEntries(['', '_fallback', '_fallback_2'].map(suffix => [`default_ai_model_agent${suffix}`, { provider_code: 'claude', model_id: 'saved', auth_method: 'oauth' }])) }]);
    refuse = true;
    fireEvent.change(picker, { target: { value: 'refused' } });
    expect(await region.findByRole('alert')).toHaveTextContent('Every Auth Agent tier requires a later active tool-capable API fallback');
    expect(picker).toHaveValue('requested');
    expect(writes).toHaveLength(2);
  } finally { view.unmount(); queries.clear(); }
});
