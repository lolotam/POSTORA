import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn<typeof fetch>() }));
vi.mock('@/integrations/supabase/client', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  return { supabase: createClient('http://127.0.0.1:54321', crypto.randomUUID(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/ai_providers') || path.endsWith('/ai_models')) return Promise.resolve(Response.json([]));
      return fetchMock(url, init);
    } },
  }) };
});

import { parseSettingsRows, useAIConfiguration, useSetDefaultModel, useSetFallbackModel, useSetFallback2Model } from './useAIConfiguration';
import { CHAT_LIST_POLICY_QUERY_KEY } from '@/features/ai-providers/infrastructure/chatListGateway';
import { supabase } from '@/integrations/supabase/client';

beforeEach(() => { vi.spyOn(supabase.auth, 'getSession').mockResolvedValue({ data: { session: { access_token: crypto.randomUUID(), user: { id: 'admin' } } }, error: null } as never); });
afterEach(() => { vi.useRealTimers(); fetchMock.mockReset(); vi.restoreAllMocks(); });

it('a hashtag conflict restarts a caption success refresh after publishing its partial snapshot', async () => {
  const old = { provider_code: 'claude', model_id: 'old' };
  const fresh = { provider_code: 'claude', model_id: 'fresh' };
  const settings = [{ key: 'default_ai_model_caption', value: old }, { key: 'default_ai_model_hashtags', value: old }];
  const freshSettings = settings.map(row => ({ ...row, value: fresh }));
  const config = { providers: [], models: [], oauthModels: [], settings, ...parseSettingsRows(settings) };
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(['ai-config'], config);
  let reads = 0;
  let cancelled = false;
  fetchMock.mockImplementation(url => Promise.resolve(String(url).includes('/rest/v1/system_settings')
    ? Response.json([freshSettings[1]]) : Response.json({ success: true })));
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result, unmount } = renderHook(() => ({
    caption: useSetDefaultModel(), hashtags: useSetFallbackModel(),
    configuration: useQuery({ queryKey: ['ai-config'], queryFn: ({ signal }) => {
      reads++;
      if (reads > 1) return Promise.resolve({ ...config, settings: freshSettings, ...parseSettingsRows(freshSettings) });
      return new Promise<typeof config>((_resolve, reject) => signal.addEventListener('abort', () => {
        cancelled = true; reject(new DOMException('cancelled', 'AbortError'));
      }, { once: true }));
    } }),
  }), { wrapper });
  try {
    await act(async () => { await result.current.caption.mutateAsync({ category: 'caption', ...fresh }); });
    await waitFor(() => expect(reads).toBe(1));
    fetchMock.mockImplementation(url => Promise.resolve(String(url).includes('/rest/v1/system_settings')
      ? Response.json([freshSettings[1]]) : Response.json({ error: 'configuration_changed_retry' }, { status: 409 })));
    await act(async () => { await expect(result.current.hashtags.mutateAsync({ category: 'hashtags', ...fresh })).rejects.toThrow('Retry'); });
    expect(cancelled).toBe(true);
    await waitFor(() => expect(result.current.configuration.data?.categoryDefaults.caption).toEqual(fresh));
    expect(reads).toBe(2);
  } finally { unmount(); client.clear(); }
});

// PR #419 r5: a sibling change invalidates the expectation for the whole chain.
it.each(([
  ['primary', useSetDefaultModel, 'default_ai_model_chat', 'default_ai_model_chat_fallback', 'changed'],
  ['fallback', useSetFallbackModel, 'default_ai_model_chat_fallback', 'default_ai_model_chat_fallback_2', 'missing'],
  ['fallback_2', useSetFallback2Model, 'default_ai_model_chat_fallback_2', 'default_ai_model_chat', 'changed'],
  ['primary', useSetDefaultModel, 'default_ai_model_chat', 'default_ai_model_chat_fallback_2', 'null'],
  ['fallback', useSetFallbackModel, 'default_ai_model_chat_fallback', 'default_ai_model_chat', 'raw string'],
] as const).flatMap(variant => (['chat', 'agent_triage'] as const).filter(category => category === 'agent_triage' || variant[4] !== 'raw string').map(category => [category, ...variant] as const)))('%s: a %s conflict publishes every tier before rejection and permits a fresh retry', async (category, _slot, useSetter, originalEditedKey, originalSiblingKey, change) => {
  const editedKey = originalEditedKey.replace('chat', category);
  const siblingKey = originalSiblingKey.replace('chat', category);
  const previous = Object.fromEntries(Object.entries({
    default_ai_model_chat: { provider_code: 'openai', model_id: 'primary' },
    default_ai_model_chat_fallback: { provider_code: 'openai', model_id: 'fallback' },
    default_ai_model_chat_fallback_2: { provider_code: 'openai', model_id: 'fallback-2' },
  }).map(([key, value]) => [key.replace('chat', category), value]));
  const desired = { provider_code: 'claude', model_id: 'requested', auth_method: 'oauth' as const };
  const fresh: Record<string, unknown> = { ...previous };
  if (change === 'missing') delete fresh[siblingKey];
  else if (change === 'null') fresh[siblingKey] = null;
  else if (change === 'raw string') fresh[siblingKey] = JSON.stringify({ provider_code: 'claude', model_id: 'concurrently-saved', auth_method: 'oauth', extension: { retain: true } });
  else fresh[siblingKey] = { provider_code: 'claude', model_id: 'concurrently-saved', auth_method: 'oauth', provider_option: 'retained' };
  let stored = { ...fresh };
  const unrelated = { key: 'default_ai_model_image', value: { provider_code: 'openai', model_id: 'image' } };
  const writes: Array<{ expected: Record<string, unknown> }> = [];
  fetchMock.mockImplementation((url, init) => {
    const requestUrl = new URL(String(url));
    if (requestUrl.pathname.includes('/rest/v1/system_settings')) {
      const rows = Object.entries(stored).map(([key, value]) => ({ key, value }));
      if (requestUrl.searchParams.has('or')) rows.push(unrelated);
      // Support the old single-tier request too, so the regression fails on
      // stale cache contents rather than on a different HTTP response shape.
      return Promise.resolve(Response.json(requestUrl.searchParams.get('key')?.startsWith('eq.')
        ? rows.find(row => row.key === requestUrl.searchParams.get('key')?.slice(3)) ?? null : rows));
    }
    const input = JSON.parse(String(init?.body));
    writes.push(input);
    const matches = Object.keys({ ...stored, ...input.expected }).every(key => JSON.stringify(input.expected[key]) === JSON.stringify(stored[key]));
    if (!matches) return Promise.resolve(Response.json({ error: 'configuration_changed_retry' }, { status: 409 }));
    stored = { ...stored, [editedKey]: desired };
    return Promise.resolve(Response.json({ success: true }));
  });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false }, mutations: { retry: false } } });
  const settings = [...Object.entries(previous).map(([key, value]) => ({ key, value })), unrelated];
  client.setQueryData(['ai-config'], { providers: [], models: [], oauthModels: [], settings, ...parseSettingsRows(settings) });
  client.setQueryData(CHAT_LIST_POLICY_QUERY_KEY, { enabled: true, groups: [] });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result, unmount } = renderHook(() => ({ mutation: useSetter(), config: useAIConfiguration() }), { wrapper });
  try {
    let atFailure: unknown;
    await act(async () => {
      const failure = await result.current.mutation.mutateAsync({ category, ...desired }).catch(error => {
        atFailure = client.getQueryData(['ai-config']);
        return error;
      });
      expect(failure).toMatchObject({ message: expect.stringContaining('Retry') });
    });
    const freshSettings = [...Object.entries(fresh).map(([key, value]) => ({ key, value })), unrelated];
    expect(atFailure).toMatchObject(parseSettingsRows(freshSettings));
    await waitFor(() => expect(result.current.config.data).toMatchObject(parseSettingsRows(freshSettings)));
    expect(result.current.config.data?.settings).toEqual(expect.arrayContaining(freshSettings));
    if (change === 'missing') expect(result.current.config.data?.settings.some(row => row.key === siblingKey)).toBe(false);
    await act(async () => { await result.current.mutation.mutateAsync({ category, ...desired }); });
    expect(writes.map(write => write.expected)).toEqual([previous, fresh]);
    expect(stored).toEqual({ ...fresh, [editedKey]: desired });
  } finally { unmount(); client.clear(); }
});

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
      return Promise.resolve(Response.json([{ key, value: stored }]));
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
    await act(async () => {
      const retry = result.current.mutateAsync({ category: 'chat', ...desired, auth_method: 'oauth' });
      if (firstWrite === 'committed') await expect(retry).rejects.toThrow('Retry');
      else await retry;
    });
    expect(writes).toHaveLength(2);
    expect(writes.map(write => write.expected)).toEqual([{ [key]: previous }, { [key]: previous }]);
    expect(stored).toEqual(desired);
    expect(committedWrites).toBe(1);
    expect(reads).toBe(firstWrite === 'committed' ? 2 : 1);
    // A successful retry invalidates configuration; an explicit CAS conflict
    // publishes the full chain before surfacing the retry error.
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
