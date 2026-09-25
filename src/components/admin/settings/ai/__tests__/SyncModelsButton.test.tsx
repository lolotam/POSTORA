import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SyncModelsButton } from '../SyncModelsButton';

const invoke = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } } }));
// vi.mock factories are hoisted above imports, so the toast mock object must be
// created with vi.hoisted rather than a plain const declared alongside it.
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const wrap = (ui: React.ReactNode) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;

describe('SyncModelsButton', () => {
  it('reports added, deactivated and in-use counts', async () => {
    invoke.mockResolvedValue({ data: { added: 12, updated: 3, deactivated: 1, kept_in_use: ['x'], skipped_by_type: { evaluation: 1 }, synced_at: '2026-09-25T00:00:00Z' }, error: null });
    render(wrap(<SyncModelsButton providerCode="vercel" />));
    fireEvent.click(screen.getByRole('button', { name: /Sync models/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Synced: 12 added, 3 updated, 1 deactivated, 1 kept (in use)'));
    expect(invoke).toHaveBeenCalledWith('ai-config', { body: { action: 'sync-models', provider_code: 'vercel' } });
  });
  it('shows the server error', async () => {
    invoke.mockResolvedValue({ data: { error: 'vercel /models returned HTTP 503' }, error: null });
    render(wrap(<SyncModelsButton providerCode="vercel" />));
    fireEvent.click(screen.getByRole('button', { name: /Sync models/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('vercel /models returned HTTP 503'));
  });
});
