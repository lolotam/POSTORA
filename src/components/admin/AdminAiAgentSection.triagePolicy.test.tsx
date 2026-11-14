import { createClient } from '@supabase/supabase-js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const { clientRef } = vi.hoisted(() => ({ clientRef: { current: undefined as unknown } }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: new Proxy({}, {
  get: (_target, property) => Reflect.get(clientRef.current as object, property),
}) }));
import { AdminAiAgentSection } from './AdminAiAgentSection';

afterEach(() => vi.restoreAllMocks());
const policy = { enabled: true, groups: [], triageGroups: [{ provider_code: 'claude', auth_method: 'oauth', name: 'Claude subscription', reason: null, synced_at: null,
  models: ['saved', 'requested'].map(model_id => ({ model_id, name: model_id, provisional: true, reason: null })) }] };

function setup() {
  let failed = false;
  const writes: unknown[] = [];
  let pending: Promise<Response> | null = null;
  const client = createClient('https://database.example.test', crypto.randomUUID(), { auth: { persistSession: false }, global: { fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/ai-config')) {
      const body = JSON.parse(String(init?.body));
      if (body.action === 'set-triage-tier') { writes.push(body); return Response.json({ error: 'model_unavailable' }, { status: 409 }); }
      if (pending) return pending;
      return failed ? Response.json({ error: 'private failure' }, { status: 400 }) : Response.json(policy);
    }
    if (url.pathname.endsWith('/system_settings')) return Response.json([{ key: 'default_ai_model_agent_triage',
      value: { provider_code: 'claude', model_id: 'saved', auth_method: 'oauth' } }]);
    return Response.json([]);
  } } });
  vi.spyOn(client.auth, 'getSession').mockResolvedValue({ data: { session: { access_token: crypto.randomUUID(), user: { id: 'admin' } } }, error: null } as never);
  clientRef.current = client;
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const mount = () => render(<QueryClientProvider client={queries}><AdminAiAgentSection /></QueryClientProvider>);
  return { mount, queries, writes, fail: (value: boolean) => { failed = value; }, pending: (value: Promise<Response>) => { pending = value; } };
}

it('Triage keeps saved Auth visible during initial readiness failure and Retry restores grouped slots', async () => {
  const context = setup();
  context.fail(true);
  const view = context.mount();
  try {
    expect(await screen.findByRole('alert')).toHaveTextContent('Triage model configuration could not be read');
    expect(screen.getByText('Auth · claude · saved')).toBeInTheDocument();
    expect(screen.queryByText(/private failure/)).not.toBeInTheDocument();
    context.fail(false);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('combobox', { name: 'Primary model' })).toBeEnabled();
    expect(screen.getAllByRole('group', { name: 'Auth' })).toHaveLength(3);
    expect(context.writes).toEqual([]);
  } finally { view.unmount(); context.queries.clear(); }
});

it('Triage loading never selects automatically; a rejected save retains the stored tier and exposes Retry', async () => {
  const context = setup();
  let release: (value: Response) => void = () => {};
  context.pending(new Promise(resolve => { release = resolve; }));
  const view = context.mount();
  try {
    expect(await screen.findByRole('status')).toHaveTextContent('Loading triage model configuration');
    expect(within(screen.getByRole('status').parentElement!).queryByText(/No models available for this category/)).not.toBeInTheDocument();
    await act(async () => { release(Response.json(policy)); });
    const model = await screen.findByRole('combobox', { name: 'Primary model' });
    expect(context.writes).toEqual([]);
    fireEvent.change(model, { target: { value: 'requested' } });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Retry'));
    expect(screen.getByText('Auth · claude · saved')).toBeInTheDocument();
    expect(context.writes).toHaveLength(1);
    expect(context.writes[0]).toMatchObject({ category: 'agent_triage', action: 'set-triage-tier', model_id: 'requested', auth_method: 'oauth',
      expected: { default_ai_model_agent_triage: { provider_code: 'claude', model_id: 'saved', auth_method: 'oauth' } } });
  } finally { view.unmount(); context.queries.clear(); }
});
