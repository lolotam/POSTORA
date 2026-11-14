import { createClient } from '@supabase/supabase-js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const { clientRef } = vi.hoisted(() => ({ clientRef: { current: undefined as unknown } }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: new Proxy({}, { get: (_target, property) => Reflect.get(clientRef.current as object, property) }) }));
import { ChatModelsCard } from './AiCategoryCards';
import { parseSettingsRows } from '@/hooks/useAIConfiguration';
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); });
const tier = { provider_code: 'claude', model_id: 'same', auth_method: 'oauth' };
function setup(enabled = true) {
  let rows: Array<{ key: string; value: unknown }> = [{ key: 'default_ai_model_chat', value: tier }];
  const requests: Array<Record<string, unknown>> = [];
  let conflict = false;
  const groups = ['api_key', 'oauth'].map(auth_method => ({ provider_code: 'claude', auth_method, name: auth_method === 'oauth' ? 'Claude subscription' : 'Claude', reason: null, synced_at: null,
    models: [{ model_id: 'same', name: 'Same', provisional: auth_method === 'oauth', reason: null }] }));
  const client = createClient('https://fixture.invalid', crypto.randomUUID(), { auth: { persistSession: false }, global: { fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/ai-config')) {
      const request = JSON.parse(String(init?.body));
      if (request.action === 'chat-list-policy') return Response.json({ enabled: true, groups, categoryLaddersEnabled: enabled });
      requests.push(request);
      const prefix = `default_ai_model_${request.category}`;
      if (conflict) {
        conflict = false;
        rows = rows.filter(row => row.key !== `${prefix}_fallback`);
        rows.push({ key: `${prefix}_fallback`, value: { ...tier, extension: { keep: true } } });
        return Response.json({ error: 'configuration_changed_retry' }, { status: 409 });
      }
      if (request.action === 'inherit-text-category') rows = rows.filter(row => !row.key.startsWith(prefix));
      else rows.push({ key: `${prefix}${request.slot === 'primary' ? '' : `_${request.slot}`}`, value: { provider_code: request.provider_code, model_id: request.model_id, ...(request.auth_method ? { auth_method: request.auth_method } : {}) } });
      return Response.json({ success: true });
    }
    if (url.pathname.endsWith('/system_settings')) return Response.json(rows.filter(row => !url.searchParams.get('key') || url.searchParams.get('key')?.includes(row.key)));
    return Response.json([]);
  } } });
  vi.spyOn(client.auth, 'getSession').mockResolvedValue({ data: { session: { access_token: crypto.randomUUID(), user: { id: 'admin' } } }, error: null } as never);
  clientRef.current = client;
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(cache);
  render(<QueryClientProvider client={cache}><ChatModelsCard /></QueryClientProvider>);
  return { requests, rows: () => rows, conflict: () => { conflict = true; } };
}
function card(title: string) { return screen.getByText(title).closest('[data-slot="card"]') ?? screen.getByText(title).closest('.rounded-lg')!; }

describe('independent text categories', () => {
  it('parses every new slot and preserves API/Auth identity', () => {
    for (const category of ['caption', 'hashtags'] as const) {
      const parsed = parseSettingsRows(['', '_fallback', '_fallback_2'].map(suffix => ({ key: `default_ai_model_${category}${suffix}`, value: suffix === '_fallback' ? JSON.stringify(tier) : tier })));
      expect([parsed.categoryDefaults[category], parsed.categoryFallbacks[category], parsed.categoryFallbacks2[category]]).toEqual([tier, tier, tier]);
    }
  });
  it('hides both new cards when category resolution is off', async () => {
    setup(false);
    await screen.findByRole('combobox', { name: 'Primary provider' });
    expect(screen.queryByText('Caption Models')).not.toBeInTheDocument(); expect(screen.queryByText('Hashtag Models')).not.toBeInTheDocument();
  });
  it.each([['caption', 'Caption Models'], ['hashtags', 'Hashtag Models']])('%s customizes explicitly, saves Auth, and resets the entire category', async (category, title) => {
    const context = setup();
    await screen.findByText(title);
    const inherited = within(card(title) as HTMLElement);
    expect(inherited.getByText('Inherits Chat')).toBeInTheDocument();
    expect(inherited.getByRole('combobox', { name: 'Primary provider' })).toBeDisabled();
    expect(inherited.getByText(/Auth.*claude.*same/)).toBeInTheDocument();
    expect(context.requests).toHaveLength(0);
    fireEvent.click(inherited.getByRole('button', { name: 'Customize this category' }));
    const editor = within(card(title) as HTMLElement);
    fireEvent.change(editor.getByRole('combobox', { name: 'Primary provider' }), { target: { value: JSON.stringify(['claude', 'oauth']) } });
    expect(context.requests).toHaveLength(0);
    fireEvent.change(editor.getByRole('combobox', { name: 'Primary model' }), { target: { value: 'same' } });
    await waitFor(() => expect(context.requests).toHaveLength(1));
    expect(context.requests[0]).toMatchObject({ category, auth_method: 'oauth', expected: {}, expected_chat: { default_ai_model_chat: tier } });
    await screen.findByRole('button', { name: 'Inherit Chat' });
    const savedEditor = within(card(title) as HTMLElement);
    fireEvent.change(savedEditor.getByRole('combobox', { name: 'Fallback provider' }), { target: { value: JSON.stringify(['claude', 'api_key']) } });
    fireEvent.change(savedEditor.getByRole('combobox', { name: 'Fallback model' }), { target: { value: 'same' } });
    await waitFor(() => expect(context.requests).toHaveLength(2));
    await waitFor(() => expect(within(card(title) as HTMLElement).getByRole('combobox', { name: 'Fallback 2 provider' })).toBeEnabled());
    fireEvent.change(savedEditor.getByRole('combobox', { name: 'Fallback 2 provider' }), { target: { value: JSON.stringify(['claude', 'oauth']) } });
    fireEvent.change(savedEditor.getByRole('combobox', { name: 'Fallback 2 model' }), { target: { value: 'same' } });
    await waitFor(() => expect(context.requests).toHaveLength(3));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Inherit Chat' })).toBeEnabled());
    expect(context.rows().find(row => row.key === `default_ai_model_${category}_fallback`)?.value).toEqual({ provider_code: 'claude', model_id: 'same' });
    expect(context.rows().find(row => row.key === `default_ai_model_${category}_fallback_2`)?.value).toEqual(tier);
    fireEvent.click(screen.getByRole('button', { name: 'Inherit Chat' }));
    await waitFor(() => expect(within(card(title) as HTMLElement).getByText('Inherits Chat')).toBeInTheDocument());
    expect(context.rows().some(row => row.key.startsWith(`default_ai_model_${category}`))).toBe(false);
    expect(context.requests[3]).toMatchObject({ action: 'inherit-text-category', category, expected: { [`default_ai_model_${category}`]: tier, [`default_ai_model_${category}_fallback`]: { provider_code: 'claude', model_id: 'same' }, [`default_ai_model_${category}_fallback_2`]: tier } });
  });
  it.each([['caption', 'Caption Models'], ['hashtags', 'Hashtag Models']])('%s refreshes the complete chain on conflict before a manual retry', async (category, title) => {
    const context = setup();
    await screen.findByText(title);
    fireEvent.click(within(card(title) as HTMLElement).getByRole('button', { name: 'Customize this category' }));
    let editor = within(card(title) as HTMLElement);
    fireEvent.change(editor.getByRole('combobox', { name: 'Primary provider' }), { target: { value: JSON.stringify(['claude', 'oauth']) } });
    fireEvent.change(editor.getByRole('combobox', { name: 'Primary model' }), { target: { value: 'same' } });
    await screen.findByRole('button', { name: 'Inherit Chat' });
    context.conflict();
    editor = within(card(title) as HTMLElement);
    fireEvent.change(editor.getByRole('combobox', { name: 'Fallback provider' }), { target: { value: JSON.stringify(['claude', 'api_key']) } });
    fireEvent.change(editor.getByRole('combobox', { name: 'Fallback model' }), { target: { value: 'same' } });
    await waitFor(() => expect(within(card(title) as HTMLElement).getByRole('alert')).toHaveTextContent('Retry'));
    editor = within(card(title) as HTMLElement);
    fireEvent.change(editor.getByRole('combobox', { name: 'Fallback provider' }), { target: { value: JSON.stringify(['claude', 'api_key']) } });
    fireEvent.change(editor.getByRole('combobox', { name: 'Fallback model' }), { target: { value: 'same' } });
    await waitFor(() => expect(context.requests).toHaveLength(3));
    expect(context.requests[2].expected).toEqual({ [`default_ai_model_${category}`]: tier,
      [`default_ai_model_${category}_fallback`]: { ...tier, extension: { keep: true } } });
    expect(context.requests[2]).not.toHaveProperty('auth_method');
  });

});
