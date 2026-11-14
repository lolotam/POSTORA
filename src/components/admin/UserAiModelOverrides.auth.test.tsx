import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderMinimal } from '@/test/test-utils';
import { UserAiModelOverrides } from './UserAiModelOverrides';

const io = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/integrations/supabase/client', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  return { supabase: createClient('https://fixture.invalid', crypto.randomUUID(), { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (...args) => io.fetch(...args) } }) };
});

const groups = (['api_key', 'oauth'] as const).map(auth_method => ({ provider_code: 'claude', auth_method,
  name: auth_method === 'oauth' ? 'Claude subscription' : 'Claude', reason: null, synced_at: null,
  models: [{ model_id: 'same', name: 'Same', provisional: false, reason: null }] }));
const user = { id: '55555555-5555-4555-8555-555555555552', email: 'owner@example.invalid', full_name: 'Owner' };
type Row = { id: string; user_id: string; provider: string; model: string; auth_method: string; expires_at: null; reason: null; created_at: string; updated_at: string; created_by: null };
function setup(conflict = false, readFailed = false) {
  let rows: Row[] = [];
  const writes: Array<Record<string, unknown>> = [];
  io.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const inputUrl = typeof input === 'object' && 'url' in input ? String(input.url) : String(input);
    const url = new URL(inputUrl, 'https://fixture.invalid');
    if (url.pathname.endsWith('ai-config')) {
      const body = JSON.parse(String(init?.body));
      if (body.action === 'chat-list-policy') return Response.json({ enabled: true, overrideWriterReady: true, groups });
      writes.push(body);
      rows = [{ id: 'row', user_id: user.id, provider: 'claude', model: conflict && writes.length === 1 ? 'concurrent' : 'same', auth_method: body.value.auth_method ?? 'api_key', expires_at: null, reason: null, created_at: '2026-11-15T00:00:00Z', updated_at: '2026-11-15T00:00:00Z', created_by: null }];
      return conflict && writes.length === 1 ? Response.json({ error: 'configuration_changed_retry' }, { status: 409 }) : Response.json({ success: true });
    }
    if (url.pathname.endsWith('profiles')) return Response.json([user]);
    if (url.pathname.endsWith('user_ai_model_overrides')) return readFailed ? Response.json({ message: 'failed' }, { status: 500 }) : Response.json(rows);
    throw new Error(`Unexpected HTTP ${url.pathname}`);
  });
  return writes;
}
async function choose(method: 'api_key' | 'oauth') {
  fireEvent.click(screen.getByRole('button', { name: 'Add Override' }));
  const dialog = await screen.findByRole('dialog');
  const provider = await within(dialog).findByRole('combobox', { name: 'User override provider' });
  fireEvent.keyDown(within(dialog).getAllByRole('combobox')[0], { key: 'Enter' });
  fireEvent.click(await screen.findByRole('option', { name: /owner@example.invalid/ }));
  fireEvent.change(provider, { target: { value: JSON.stringify(['claude', method]) } });
  fireEvent.change(within(dialog).getByRole('combobox', { name: 'User override model' }), { target: { value: 'same' } });
  return within(dialog).getByRole('button', { name: 'Add Override' });
}
describe('admin override grouped contract', () => {
  beforeEach(() => { io.fetch.mockReset(); });
  afterEach(() => vi.unstubAllGlobals());
  it.each(['api_key', 'oauth'] as const)('saves the %s identity through the real boundary and renders its marker', async method => {
    const writes = setup();
    renderMinimal(<UserAiModelOverrides />);
    await screen.findByText('No user AI model overrides configured.');
    fireEvent.click(await choose(method));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ action: 'set-user-override', user_id: user.id, expected: null,
      value: { provider_code: 'claude', model_id: 'same', ...(method === 'oauth' ? { auth_method: 'oauth' } : {}) } });
    if (method === 'api_key') expect(writes[0].value).not.toHaveProperty('auth_method');
    expect(await screen.findByText(`${method === 'oauth' ? 'Auth' : 'API'} · claude`)).toBeInTheDocument();
  });
  it('refreshes the complete override snapshot after conflict before manual retry', async () => {
    const writes = setup(true);
    renderMinimal(<UserAiModelOverrides />);
    await screen.findByText('No user AI model overrides configured.');
    const save = await choose('oauth');
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByText('concurrent')).toBeInTheDocument());
    await waitFor(() => expect(save).toBeEnabled());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(save);
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].expected).toMatchObject({ model: 'concurrent', auth_method: 'oauth', user_id: user.id });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
  it('does not turn a failed override read into an empty successful list', async () => {
    setup(false, true);
    renderMinimal(<UserAiModelOverrides />);
    expect(await screen.findByRole('alert')).toHaveTextContent('User overrides could not be read.');
    expect(screen.queryByText('No user AI model overrides configured.')).not.toBeInTheDocument();
  });
});
