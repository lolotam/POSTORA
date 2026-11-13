import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ProviderHealthButton } from './ProviderHealthButton';

const invoke = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } },
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, vars?: Record<string, unknown>) => {
      const text = typeof fallback === 'string' ? fallback : key;
      if (!vars) return text;
      return text.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(vars[name] ?? ''));
    },
  }),
}));

// A fresh cache per test: the stored-results query must not leak between them.
let queryClient: QueryClient;
const wrap = (ui: ReactNode) => <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>;
const chunk = (results: unknown[], done = true) => ({
  data: {
    run_id: 'r',
    chunk: 1,
    done,
    next_chunk: done ? null : 2,
    results,
    skipped: [],
    summary: { total: results.length, connected: 1, failed: 1, needs_relogin: 0 },
  },
  error: null,
});

describe('ProviderHealthButton', () => {
  beforeEach(() => {
    invoke.mockReset();
    toast.error.mockReset();
    // A fresh cache per test: the stored-results query must not leak between them.
    queryClient = new QueryClient();
  });

  it('shows a read warning instead of empty history when status is unavailable', async () => {
    invoke.mockResolvedValue({ data: null, error: new Error('unavailable') });
    render(wrap(<ProviderHealthButton />));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('could not be read'));
    expect(screen.queryByText('No provider has been checked yet.')).toBeNull();
  });

  it('clears removed connections after an empty successful status refresh', async () => {
    invoke.mockResolvedValue({ data: { results: [{ provider_code: 'claude', auth_method: 'api_key',
      display_name: 'Claude', status: 'connected', models_added: 0, models_updated: 0,
      models_deactivated: 0, checked_at: '' }] }, error: null });
    render(wrap(<ProviderHealthButton />));
    await waitFor(() => expect(screen.getAllByTestId('provider-health-row').length).toBe(1));
    invoke.mockResolvedValue({ data: { results: [] }, error: null });
    await queryClient.invalidateQueries({ queryKey: ['ai-provider-health'] });
    await waitFor(() => expect(screen.queryAllByTestId('provider-health-row').length).toBe(0));
    expect(screen.getByText('No provider has been checked yet.')).toBeTruthy();
  });

  it('shows one row per provider with the status and the model counts', async () => {
    invoke.mockImplementation((_fn: string, { body }: { body: { action: string } }) =>
      body.action === 'status'
        ? Promise.resolve({ data: { results: [] }, error: null })
        : Promise.resolve(chunk([
          { provider_code: 'claude', auth_method: 'api_key', display_name: 'Claude', status: 'connected', reason: null, models_added: 2, models_updated: 1, models_deactivated: 0, latency_ms: 10, checked_at: '2026-11-13T00:00:00Z' },
          { provider_code: 'openrouter', auth_method: 'api_key', display_name: 'OpenRouter', status: 'failed', reason: 'Rate limit exceeded', models_added: null, models_updated: null, models_deactivated: null, latency_ms: 20, checked_at: '2026-11-13T00:00:00Z' },
        ])));
    render(wrap(<ProviderHealthButton />));
    fireEvent.click(screen.getByRole('button', { name: /Check & sync all providers/i }));
    await waitFor(() => expect(screen.getAllByTestId('provider-health-row').length).toBe(2));
    expect(screen.getByText('Rate limit exceeded')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('shows needs re-login for an expired subscription and never a count for it', async () => {
    invoke.mockImplementation((_fn: string, { body }: { body: { action: string } }) =>
      body.action === 'status'
        ? Promise.resolve({ data: { results: [] }, error: null })
        : Promise.resolve(chunk([
          { provider_code: 'claude', auth_method: 'oauth', display_name: 'Claude', status: 'needs_relogin', reason: 'The subscription sign-in expired. Sign in again.', models_added: null, models_updated: null, models_deactivated: null, latency_ms: 5, checked_at: '2026-11-13T00:00:00Z' },
        ])));
    render(wrap(<ProviderHealthButton />));
    fireEvent.click(screen.getByRole('button', { name: /Check & sync all providers/i }));
    await waitFor(() => expect(screen.getAllByTestId('provider-health-row').length).toBe(1));
    expect(screen.getByText(/needs re-login/i)).toBeTruthy();
    // A provider that was not synced has no count — a dash, never a zero.
    expect(screen.queryByText('0')).toBeNull();
    expect(screen.getAllByText('—').length).toBe(3);
  });

  it('says the run was incomplete when a provider was not checked', async () => {
    invoke.mockImplementation((_fn: string, { body }: { body: { action: string } }) =>
      body.action === 'status'
        ? Promise.resolve({ data: { results: [] }, error: null })
        : Promise.resolve({
          data: {
            run_id: 'r',
            chunk: 1,
            done: false,
            next_chunk: 2,
            results: [{
              provider_code: 'openai', auth_method: 'api_key', display_name: 'OpenAI', status: 'connected',
              reason: null, models_added: 1, models_updated: 0, models_deactivated: 0, latency_ms: 5,
              checked_at: '2026-11-13T00:00:00Z',
            }],
            skipped: [{ provider_code: 'claude', auth_method: 'api_key', reason: 'ran out of time' }],
            summary: { total: 1, connected: 1, failed: 0, needs_relogin: 0 },
          },
          error: null,
        }));
    render(wrap(<ProviderHealthButton />));
    fireEvent.click(screen.getByRole('button', { name: /Check & sync all providers/i }));
    // The run did not cover every provider, and the button says so: a summary
    // that reads like a finished check would hide the provider nobody looked at.
    await waitFor(() => expect(screen.getByTestId('provider-health-incomplete')).toBeTruthy());
    expect(screen.getByText('claude (API key): ran out of time')).toBeTruthy();
  });

  it('keeps going after one provider fails', async () => {
    invoke.mockImplementation((_fn: string, { body }: { body: { action: string } }) =>
      body.action === 'status'
        ? Promise.resolve({ data: { results: [] }, error: null })
        : Promise.resolve(chunk([
          { provider_code: 'openai', auth_method: 'api_key', display_name: 'OpenAI', status: 'failed', reason: 'Invalid API key', models_added: null, models_updated: null, models_deactivated: null, latency_ms: 5, checked_at: 't' },
          { provider_code: 'xai', auth_method: 'api_key', display_name: 'xAI', status: 'connected', reason: null, models_added: 3, models_updated: 0, models_deactivated: 1, latency_ms: 5, checked_at: 't' },
        ])));
    render(wrap(<ProviderHealthButton />));
    fireEvent.click(screen.getByRole('button', { name: /Check & sync all providers/i }));
    await waitFor(() => expect(screen.getAllByTestId('provider-health-row').length).toBe(2));
  });

  it('says the daily check is running when the server is busy', async () => {
    invoke.mockImplementation((_fn: string, { body }: { body: { action: string } }) =>
      body.action === 'status'
        ? Promise.resolve({ data: { results: [] }, error: null })
        : Promise.resolve({ data: { error: 'busy' }, error: null }));
    render(wrap(<ProviderHealthButton />));
    fireEvent.click(screen.getByRole('button', { name: /Check & sync all providers/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(String(toast.error.mock.calls[0][0])).toMatch(/daily check is running/i);
  });

  it('shows the stored rows before anything is clicked', async () => {
    invoke.mockResolvedValue({
      data: {
        results: [{
          provider_code: 'claude', auth_method: 'api_key', display_name: 'Claude', status: 'connected',
          reason: null, models_added: 1, models_updated: 0, models_deactivated: 0, latency_ms: 9,
          checked_at: '2026-11-13T00:00:00Z',
        }],
      },
      error: null,
    });
    render(wrap(<ProviderHealthButton />));
    await waitFor(() => expect(screen.getAllByTestId('provider-health-row').length).toBe(1));
  });

  it('says so when no provider has been checked yet', async () => {
    invoke.mockResolvedValue({ data: { results: [] }, error: null });
    render(wrap(<ProviderHealthButton />));
    await waitFor(() => expect(screen.getByText(/No provider has been checked yet/i)).toBeTruthy());
  });
});
