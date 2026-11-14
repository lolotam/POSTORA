import { createClient } from '@supabase/supabase-js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';

const { clientRef } = vi.hoisted(() => ({ clientRef: { current: undefined as unknown } }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: new Proxy({}, {
  get: (_target, property) => Reflect.get(clientRef.current as object, property),
}) }));
import { useAIConfiguration } from './useAIConfiguration';

it.each([false, true])('reads every credential catalogue page; later page failure=%s', async failLater => {
  const catalogue = Array.from({ length: 1205 }, (_, index) => ({ id: String(index), name: 'Same name',
    model_id: `model-${index}`, auth_method: index % 2 ? 'oauth' : 'api_key' }));
  const client = createClient('https://database.example.test', crypto.randomUUID(), {
    auth: { persistSession: false }, global: { fetch: (async input => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith('/ai_models')) return Response.json([]);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      if (failLater && offset > 0) return Response.json({ message: 'unavailable' }, { status: 503 });
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 1000), 173);
      return Response.json(catalogue.slice(offset, offset + limit));
    }) as typeof fetch },
  });
  vi.spyOn(client.auth, 'getSession').mockResolvedValue({ data: { session: { user: { id: 'admin' } } }, error: null } as never);
  clientRef.current = client;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  const { result, unmount } = renderHook(() => useAIConfiguration(), { wrapper });
  await waitFor(() => expect(result.current.isPending).toBe(false));
  if (failLater) {
    expect(result.current.error).toBeTruthy();
    expect(result.current.data).toBeUndefined();
  } else {
    expect(result.current.data?.models).toHaveLength(603);
    expect(result.current.data?.oauthModels).toHaveLength(602);
    expect(result.current.data?.models.at(-1)?.model_id).toBe('model-1204');
  }
  unmount();
  queryClient.clear();
});
