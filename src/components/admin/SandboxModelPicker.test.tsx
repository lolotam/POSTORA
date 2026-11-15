import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { renderMinimal } from '@/test/test-utils';
import { SandboxModelPicker } from './SandboxModelPicker';
import { createTestQueryClient } from '@/test/test-utils';

const io = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/integrations/supabase/client', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  return { supabase: createClient('https://fixture.invalid', crypto.randomUUID(), { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (...args) => io.fetch(...args) } }) };
});
describe('sandbox server contract readiness', () => {
  it.each(['disabled', 'failed'] as const)('clears an active comparison and keeps reset available after policy becomes %s', async state => {
    const client = createTestQueryClient();
    const value = { provider_code: 'claude', model_id: 'same', auth_method: 'oauth' as const };
    const ready = { enabled: true, contract: 1, groups: [{ provider_code: 'claude', auth_method: 'oauth', name: 'Claude', reason: null, synced_at: null,
      models: [{ model_id: 'same', name: 'Same', reason: null, provisional: false }] }] };
    io.fetch.mockImplementation(async () => Response.json(ready));
    const onChange = vi.fn();
    renderMinimal(<SandboxModelPicker value={value} onChange={onChange} busy={false} />, { queryClient: client });
    await screen.findByRole('combobox', { name: 'Sandbox comparison provider' });
    io.fetch.mockImplementation(async () => Response.json(state === 'disabled' ? { enabled: false } : { error: 'unavailable' }, { status: state === 'disabled' ? 200 : 503 }));
    await act(async () => { await client.invalidateQueries({ queryKey: ['ai-sandbox-model-policy'] }); });
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(null));
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    const reset = screen.getByRole('button', { name: 'Use configured chain' });
    expect(reset).toBeEnabled();
    onChange.mockClear();
    fireEvent.click(reset);
    expect(onChange).toHaveBeenCalledWith(null);
  });
  it.each([{ enabled: false }, { enabled: true, groups: [] }, { error: 'old-server' }])('does not expose grouped choices without deployed contract %j', async response => {
    io.fetch.mockResolvedValue(Response.json(response));
    renderMinimal(<SandboxModelPicker value={null} onChange={vi.fn()} busy={false} />);
    if (response.enabled === false) await vi.waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    else expect(await screen.findByRole('alert')).toHaveTextContent('Sandbox model choices could not be read.');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
  it('selects structured auth only after the runtime reports contract 1', async () => {
    io.fetch.mockResolvedValue(Response.json({ enabled: true, contract: 1, groups: [{ provider_code: 'claude', auth_method: 'oauth', name: 'Claude subscription', reason: null, synced_at: null,
      models: [{ model_id: 'same', name: 'Same', reason: null, provisional: false }] }] }));
    const onChange = vi.fn();
    renderMinimal(<SandboxModelPicker value={null} onChange={onChange} busy={false} />);
    fireEvent.change(await screen.findByRole('combobox', { name: 'Sandbox comparison provider' }), { target: { value: JSON.stringify(['claude', 'oauth']) } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Sandbox comparison model' }), { target: { value: 'same' } });
    expect(onChange).toHaveBeenCalledWith({ provider_code: 'claude', model_id: 'same', auth_method: 'oauth' });
  });
});
