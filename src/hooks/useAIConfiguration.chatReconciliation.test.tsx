import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn<typeof fetch>() }));
vi.mock('@/integrations/supabase/client', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  return { supabase: createClient('http://127.0.0.1:54321', crypto.randomUUID(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: fetchMock },
  }) };
});

import { parseSettingsRows, useAIConfiguration, useSetDefaultModel, useSetFallbackModel, useSetFallback2Model } from './useAIConfiguration';
import { CHAT_LIST_POLICY_QUERY_KEY } from '@/features/ai-providers/infrastructure/chatListGateway';

afterEach(() => { vi.useRealTimers(); fetchMock.mockReset(); });

// PR #419 r4: the browser's old snapshot, not a fresh server read, fences retries.
it.each([
  ['committed', 'unreadable'], ['not committed', 'unreadable'],
  ['committed', 'previous'], ['not committed', 'previous'],
] as const)('an ambiguous timeout followed by retry is safe: first write %s, reconciliation %s', async (firstWrite, observation) => {
  vi.useFakeTimers();
  const key = 'default_ai_model_chat';
  const previous = { provider_code: 'openai', model_id: 'old' };
  const desired = { provider_code: 'claude', model_id: 'requested', auth_method: 'oauth' };
  let stored = previous;
  let committedWrites = 0;
  const writes: Array<{ expected?: Record<string, unknown> }> = [];
  let reads = 0;
  fetchMock.mockImplementation((url, init) => {
    if (String(url).includes('/rest/v1/system_settings')) {
      reads++;
      if (writes.length === 1) {
        if (observation === 'unreadable') return Promise.resolve(Response.json({ message: 'unavailable' }, { status: 400 }));
        // SELECT observes the old value, then the original transaction finishes.
        // That read cannot certify completion or authorize a fresh expectation.
        const response = Response.json({ value: previous });
        if (firstWrite === 'committed') { stored = desired; committedWrites++; }
        return Promise.resolve(response);
      }
      return Promise.resolve(Response.json({ value: stored }));
    }
    const input = JSON.parse(String(init?.body));
    writes.push(input);
    if (writes.length === 1) {
      if (firstWrite === 'committed' && observation === 'unreadable') { stored = desired; committedWrites++; }
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('private detail', 'AbortError')), { once: true }));
    }
    // Database boundary: same value comparison as write_ai_chat_tier. Its real
    // SQL stale-snapshot regression lives in supabase/tests/ai_chat_list_policy.sql.
    if (JSON.stringify(input.expected) !== JSON.stringify({ [key]: stored })) {
      return Promise.resolve(Response.json({ error: 'configuration_changed_retry' }, { status: 409 }));
    }
    stored = desired;
    committedWrites++;
    return Promise.resolve(Response.json({ success: true }));
  });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false }, mutations: { retry: false } } });
  const settings = [{ key, value: previous }];
  client.setQueryData(['ai-config'], { providers: [], models: [], oauthModels: [], settings, ...parseSettingsRows(settings) });
  client.setQueryData(CHAT_LIST_POLICY_QUERY_KEY, { enabled: true, groups: [] });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result, unmount } = renderHook(() => useSetDefaultModel(), { wrapper });
  try {
    await act(async () => {
      const first = result.current.mutateAsync({ category: 'chat', ...desired, auth_method: 'oauth' }).catch(error => error);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await first).toMatchObject({ message: expect.stringContaining(observation === 'unreadable' ? 'could not be confirmed' : 'Retry') });
    });
    expect(client.getQueryData(['ai-config'])).toMatchObject({ categoryDefaults: { chat: previous } });
    await act(async () => { await result.current.mutateAsync({ category: 'chat', ...desired, auth_method: 'oauth' }); });
    expect(writes).toHaveLength(2);
    expect(writes.map(write => write.expected)).toEqual([{ [key]: previous }, { [key]: previous }]);
    expect(stored).toEqual(desired);
    expect(committedWrites).toBe(1);
    expect(reads).toBe(firstWrite === 'committed' ? 2 : 1);
    // A successful retry invalidates configuration; the committed/conflict path
    // publishes the reread value before the mutation settles.
    if (firstWrite === 'committed') expect(client.getQueryData(['ai-config'])).toMatchObject({ categoryDefaults: { chat: desired } });
  } finally { unmount(); client.clear(); }
});

// PR #419 r3: a failed save must publish the reconciled tier before its error.
it.each([
  ['primary', useSetDefaultModel, 'categoryDefaults', ''],
  ['fallback', useSetFallbackModel, 'categoryFallbacks', '_fallback'],
  ['fallback_2', useSetFallback2Model, 'categoryFallbacks2', '_fallback_2'],
] as const)('a timed-out %s save refreshes the displayed saved tier before rejecting', async (_slot, useSetter, field, suffix) => {
  vi.useFakeTimers();
  const key = `default_ai_model_chat${suffix}`;
  const saved = { provider_code: 'claude', model_id: 'concurrently-saved', auth_method: 'oauth' };
  fetchMock.mockImplementation((url, init) => {
    if (String(url).includes('/rest/v1/system_settings')) return Promise.resolve(Response.json({ value: saved }));
    return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('private detail', 'AbortError')), { once: true }));
  });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false }, mutations: { retry: false } } });
  const settings = [{ key, value: { provider_code: 'openai', model_id: 'old' } }];
  client.setQueryData(['ai-config'], { providers: [], models: [], oauthModels: [], settings, ...parseSettingsRows(settings) });
  client.setQueryData(CHAT_LIST_POLICY_QUERY_KEY, { enabled: true, groups: [] });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result, unmount } = renderHook(() => ({ mutation: useSetter(), config: useAIConfiguration() }), { wrapper });
  let atFailure: unknown;
  await act(async () => {
    const request = result.current.mutation.mutateAsync({ category: 'chat', provider_code: 'claude', model_id: 'requested', auth_method: 'oauth' })
      .catch(error => { atFailure = client.getQueryData(['ai-config']); return error; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await request).toMatchObject({ message: 'AI configuration could not be saved or read. Retry; check AI Providers if it remains unavailable.' });
  });
  expect(atFailure).toMatchObject({ [field]: { chat: saved } });
  expect(result.current.config.data?.[field].chat).toEqual(saved);
  unmount();
  client.clear();
});
