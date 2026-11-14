import { createClient } from '@supabase/supabase-js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { clientRef } = vi.hoisted(() => ({ clientRef: { current: undefined as unknown } }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: new Proxy({}, {
  get: (_target, property) => Reflect.get(clientRef.current as object, property),
}) }));
import { ChatModelsCard } from './AiCategoryCards';

const readyPolicy = { enabled: true, groups: [{ provider_code: 'claude', auth_method: 'oauth', name: 'Claude subscription', reason: null, synced_at: null,
  models: [{ model_id: 'saved', name: 'Saved', provisional: true, reason: null }] }] };

function setup() {
  let failure = '';
  let writes = 0;
  let pending: Promise<Response> | null = null;
  const client = createClient('https://database.example.test', crypto.randomUUID(), { auth: { persistSession: false }, global: { fetch: (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/ai-config')) {
      const body = JSON.parse(String(init?.body));
      if (body.action === 'set-chat-tier') { writes++; return Response.json({ error: 'model_unavailable' }, { status: 409 }); }
      if (pending) return pending;
      return failure === 'policy' ? Response.json({ error: 'private failure' }, { status: 400 }) : Response.json(readyPolicy);
    }
    if (failure && url.pathname.endsWith(`/${failure}`)) return Response.json({ message: 'private read failure' }, { status: 400 });
    if (url.pathname.endsWith('/system_settings') && url.searchParams.has('or')) return Response.json([
      { key: 'default_ai_model_chat', value: { provider_code: 'claude', model_id: 'saved', auth_method: 'oauth' } },
    ]);
    return Response.json([]);
  }) as typeof fetch } });
  vi.spyOn(client.auth, 'getSession').mockResolvedValue({ data: { session: { access_token: crypto.randomUUID(), user: { id: 'admin' } } }, error: null } as never);
  clientRef.current = client;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const mount = () => render(<QueryClientProvider client={queryClient}><ChatModelsCard /></QueryClientProvider>);
  return { queryClient, mount, fail: (target: string) => { failure = target; }, writes: () => writes, pending: (response: Promise<Response> | null) => { pending = response; } };
}

describe('generic Chat category card policy integration', () => {
  it('shows loading until readiness arrives without an empty-model claim or save', async () => {
    const context = setup();
    let release: (response: Response) => void = () => {};
    context.pending(new Promise(resolve => { release = resolve; }));
    context.mount();
    expect(await screen.findByRole('status')).toHaveTextContent('Loading AI configuration');
    expect(screen.queryByText(/No models available/)).not.toBeInTheDocument();
    release(Response.json(readyPolicy));
    expect(await screen.findByRole('combobox', { name: 'Primary provider' })).toBeInTheDocument();
    expect(context.writes()).toBe(0);
  });

  it.each(['policy', 'ai_models', 'system_settings', 'ai_providers'])('failed %s reads retain saved tiers and Retry recovers without writes', async target => {
    const context = setup();
    context.mount();
    await screen.findByRole('combobox', { name: 'Primary provider' });
    context.fail(target);
    await context.queryClient.invalidateQueries({ queryKey: target === 'policy' ? ['ai-chat-list-policy'] : ['ai-config'] });
    const readError = await screen.findByText('AI configuration could not be read. Saved selections have not changed.');
    const chatCard = within(readError.parentElement!);
    expect(chatCard.getByRole('alert')).toHaveTextContent('Saved selections have not changed');
    expect(screen.getByText(/Auth · claude · saved/)).toBeInTheDocument();
    expect(screen.queryByText(/private/)).not.toBeInTheDocument();
    context.fail('');
    fireEvent.click(chatCard.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryAllByRole('alert')).toHaveLength(0));
    expect(screen.getByRole('combobox', { name: 'Primary provider' })).toBeInTheDocument();
    expect(context.writes()).toBe(0);
  });
});
