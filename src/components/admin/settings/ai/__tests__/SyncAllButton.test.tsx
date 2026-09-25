import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SyncAllButton } from '../SyncAllButton';

const invoke = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } } }));
// vi.mock factories are hoisted above imports, so the toast mock object must be
// created with vi.hoisted rather than a plain const declared alongside it.
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const wrap = (ui: React.ReactNode) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;

describe('SyncAllButton', () => {
  beforeEach(() => {
    invoke.mockReset();
    toast.success.mockReset();
    toast.warning.mockReset();
  });

  it('syncs every provider in turn and keeps going after a failure', async () => {
    invoke.mockImplementation((_fn: string, { body }: { body: { provider_code: string } }) =>
      Promise.resolve(body.provider_code === 'xai'
        ? { data: { error: 'xai /models returned HTTP 403' }, error: null }
        : { data: { added: 1, updated: 0, deactivated: 0, kept_in_use: [], skipped_by_type: {}, synced_at: 't', dry_run: false }, error: null }));
    render(wrap(<SyncAllButton providerCodes={['openai', 'xai', 'zai']} />));
    fireEvent.click(screen.getByRole('button', { name: /Sync all/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
    expect(invoke.mock.calls.map((c) => c[1].body.provider_code)).toEqual(['openai', 'xai', 'zai']);
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(String(toast.warning.mock.calls[0][0])).toMatch(/2 of 3/);
  });

  it('reports success with the total added when every sync succeeds', async () => {
    invoke.mockResolvedValue({ data: { added: 2, updated: 1, deactivated: 0, kept_in_use: [], skipped_by_type: {}, synced_at: 't', dry_run: false }, error: null });
    render(wrap(<SyncAllButton providerCodes={['openai', 'zai']} />));
    fireEvent.click(screen.getByRole('button', { name: /Sync all/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(String(toast.success.mock.calls[0][0])).toMatch(/4 added/);
  });
});
