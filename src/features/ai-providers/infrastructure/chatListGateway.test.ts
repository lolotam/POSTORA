import { afterEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn<typeof fetch>() }));

vi.mock('@/integrations/supabase/client', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  return { supabase: createClient('http://127.0.0.1:54321', crypto.randomUUID(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetchMock },
  }) };
});

import { fetchChatListPolicy, saveChatTier } from './chatListGateway';

afterEach(() => {
  vi.useRealTimers();
  fetchMock.mockReset();
});

describe('Chat action deadlines (PR #419)', () => {
  it.each(['read', 'save'] as const)('a stalled %s aborts at 30s and reaches the sanitized retry state', async action => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      requestSignal = init?.signal ?? undefined;
      requestSignal?.addEventListener('abort', () => reject(new DOMException('private upstream detail', 'AbortError')), { once: true });
    }));
    const outcomes: unknown[] = [];
    const request = action === 'read' ? fetchChatListPolicy() : saveChatTier({
      category: 'chat', slot: 'primary', provider_code: 'claude', model_id: 'same', auth_method: 'oauth',
    });
    const settled = request.then(value => { outcomes.push(value); }, error => { outcomes.push(error); });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(requestSignal?.aborted).toBe(true);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toEqual(new Error('AI configuration could not be saved or read. Retry; check AI Providers if it remains unavailable.'));
    await settled;
  });
});
