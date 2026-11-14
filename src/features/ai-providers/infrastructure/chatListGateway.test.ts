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
  it('a stalled read aborts at 30s and reaches the sanitized retry state', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      requestSignal = init?.signal ?? undefined;
      requestSignal?.addEventListener('abort', () => reject(new DOMException('private upstream detail', 'AbortError')), { once: true });
    }));
    const outcomes: unknown[] = [];
    const request = fetchChatListPolicy();
    const settled = request.then(value => { outcomes.push(value); }, error => { outcomes.push(error); });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(requestSignal?.aborted).toBe(true);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ message: 'AI configuration could not be saved or read. Retry; check AI Providers if it remains unavailable.' });
    await settled;
  });

  it.each(['committed', 'different', 'missing', 'unreadable'] as const)('a browser timeout reconciles a %s tier before settling', async outcome => {
    vi.useFakeTimers();
    const saved = outcome === 'missing' ? null : { value: { provider_code: 'claude', model_id: outcome === 'different' ? 'newer' : 'same', auth_method: 'oauth' } };
    fetchMock.mockImplementation((url, init) => {
      if (String(url).includes('/rest/v1/system_settings')) return Promise.resolve(outcome === 'unreadable'
        ? Response.json({ message: 'private SQL detail' }, { status: 503 }) : Response.json(saved));
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('private upstream detail', 'AbortError')), { once: true });
      });
    });
    const reconciled = vi.fn();
    const outcomes: unknown[] = [];
    // The second parameter publishes authoritative saved state before any failure.
    const request = saveChatTier({ category: 'chat', slot: 'primary', provider_code: 'claude', model_id: 'same', auth_method: 'oauth' }, reconciled)
      .then(() => outcomes.push('success'), error => outcomes.push(error));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(outcomes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    // The real PostgREST client may retry idempotent 503 reads.
    if (outcome === 'unreadable') await vi.advanceTimersByTimeAsync(10_000);
    await request;
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/functions/v1/ai-config'))).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/system_settings'))).toBe(true);
    if (outcome === 'unreadable') {
      expect(reconciled).not.toHaveBeenCalled();
      expect(outcomes[0]).toEqual(new Error('AI configuration save outcome could not be confirmed. Reload before retrying.'));
    } else {
      expect(reconciled).toHaveBeenCalledWith(saved?.value ?? null);
      if (outcome === 'committed') expect(outcomes[0]).toBe('success');
      else expect(outcomes[0]).toMatchObject({ message: 'AI configuration could not be saved or read. Retry; check AI Providers if it remains unavailable.' });
    }
  });

  it.each(['api_key', 'oauth'] as const)('a server 503 reconciles a committed %s tier without retrying the write', async auth_method => {
    const saved = { provider_code: 'openai', model_id: 'same', ...(auth_method === 'oauth' ? { auth_method } : {}) };
    fetchMock.mockImplementation(url => Promise.resolve(String(url).includes('/functions/v1/ai-config')
      ? Response.json({ error: 'configuration_read_or_write_failed' }, { status: 503 }) : Response.json({ value: saved })));
    const reconciled = vi.fn();
    await expect(saveChatTier({ category: 'chat', slot: 'fallback', provider_code: 'openai', model_id: 'same', auth_method }, reconciled)).resolves.toBeUndefined();
    expect(reconciled).toHaveBeenCalledWith(saved);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/functions/v1/ai-config'))).toHaveLength(1);
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get('key')).toBe('eq.default_ai_model_chat_fallback');
  });
});
