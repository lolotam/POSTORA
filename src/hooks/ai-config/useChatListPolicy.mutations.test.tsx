import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSetServiceKey, useToggleModel, useToggleProvider } from '../useAIConfiguration';
import { useDisconnectAiOAuth, useFinishAiOAuth, useTestAiOAuth } from './useAiProviderAuth';
import { useRunProviderHealth } from './useAiProviderHealth';
import { useSyncModels } from './useSyncModels';
import { useChatListPolicy } from './useChatListPolicy';

const { invoke, getSession } = vi.hoisted(() => ({ invoke: vi.fn(), getSession: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke }, auth: { getSession } } }));

function usePolicyMutations() {
  return {
    policy: useChatListPolicy(true), provider: useToggleProvider(), model: useToggleModel(),
    key: useSetServiceKey(), sync: useSyncModels(), finish: useFinishAiOAuth(),
    disconnect: useDisconnectAiOAuth(), test: useTestAiOAuth(), health: useRunProviderHealth(),
  };
}

type MountedMutations = ReturnType<typeof usePolicyMutations>;
const mutations: Array<[string, (hooks: MountedMutations) => Promise<unknown>]> = [
  ['provider activation', hooks => hooks.provider.mutateAsync({ provider_id: 'claude', is_active: true })],
  ['provider deactivation', hooks => hooks.provider.mutateAsync({ provider_id: 'claude', is_active: false })],
  ['model activation', hooks => hooks.model.mutateAsync({ model_id: 'model-row', is_active: true })],
  ['model deactivation', hooks => hooks.model.mutateAsync({ model_id: 'model-row', is_active: false })],
  ['key save', hooks => hooks.key.mutateAsync({ provider_code: 'claude', api_key: crypto.randomUUID() })],
  ['catalogue sync', hooks => hooks.sync.mutateAsync({ provider_code: 'claude' })],
  ['subscription login', hooks => hooks.finish.mutateAsync({ provider: 'anthropic', pasted: 'code#state' })],
  ['subscription disconnect', hooks => hooks.disconnect.mutateAsync('anthropic')],
  ['subscription test', hooks => hooks.test.mutateAsync({ provider: 'anthropic', modelId: 'model' })],
  ['health sync', hooks => hooks.health.run()],
  ['partial health sync', hooks => hooks.health.run()],
];

describe('configuration changes refresh mounted Chat readiness (PR #419)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(mutations)('%s refreshes availability and catalogue without remounting', async (scenario, mutate) => {
    let changed = false;
    let healthChunks = 0;
    const removesReadiness = scenario.includes('deactivation') || scenario === 'subscription disconnect' || scenario === 'subscription test';
    const policy = () => ({ enabled: true, groups: [{
      provider_code: 'claude', auth_method: 'oauth', name: 'Claude subscription',
      reason: changed === removesReadiness ? 'not_connected' : null, synced_at: null,
      models: [{ model_id: changed ? 'new-model' : 'old-model', name: 'Model', provisional: false, reason: null }],
    }] });
    invoke.mockImplementation(async (name: string, options: { body: { action: string } }) => {
      if (options.body.action === 'chat-list-policy') return { data: policy(), error: null };
      changed = true;
      if (name === 'ai-provider-health') {
        healthChunks++;
        if (healthChunks === 2) return { data: null, error: new Error('later chunk failed') };
        return { data: { run_id: 'run', chunk: 1, done: scenario !== 'partial health sync', next_chunk: 2,
          results: [], skipped: [], summary: { total: 0, connected: 0, failed: 0, needs_relogin: 0 } }, error: null };
      }
      const status = scenario === 'subscription disconnect' ? 'not_connected' : 'connected';
      return { data: { success: true, status, account_label: null, ok: false, latency_ms: 1 }, error: null };
    });
    getSession.mockResolvedValue({ data: { session: { access_token: crypto.randomUUID() } } });
    vi.stubGlobal('fetch', vi.fn(async () => { changed = true; return Response.json({ success: true }); }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result, unmount } = renderHook(usePolicyMutations, { wrapper });
    const currentGroup = () => {
      const readiness = result.current.policy.data;
      return readiness?.enabled ? readiness.groups[0] : undefined;
    };
    try {
      await waitFor(() => expect(currentGroup()?.reason).toBe(removesReadiness ? null : 'not_connected'));
      await act(async () => { await mutate(result.current); });
      await waitFor(() => expect(currentGroup()?.models[0].model_id).toBe('new-model'));
      expect(currentGroup()?.reason).toBe(removesReadiness ? 'not_connected' : null);
      if (scenario === 'partial health sync') expect(result.current.health.error).toBe('later chunk failed');
    } finally {
      unmount();
      client.clear();
    }
  });
});
