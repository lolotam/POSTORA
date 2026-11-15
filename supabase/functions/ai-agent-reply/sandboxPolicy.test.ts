import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';

let handleReply: (request: Request) => Promise<Response>;
const serve = Deno.serve;
try {
  Deno.serve = ((handler: typeof handleReply) => { handleReply = handler; return {}; }) as unknown as typeof Deno.serve;
  await import('./index.ts');
} finally { Deno.serve = serve; }

for (const action of ['sandbox-model-policy', 'test']) {
  for (const isAdmin of [true, false]) {
    Deno.test(`${action} shares the sandbox limit before policy reads/refusals, admin=${isAdmin}`, async () => {
      const names = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY'];
      const saved = names.map(name => [name, Deno.env.get(name)] as const);
      const originalFetch = globalThis.fetch;
      Deno.env.set(names[0], 'https://fixture.invalid');
      Deno.env.set(names[1], crypto.randomUUID());
      Deno.env.set(names[2], crypto.randomUUID());
      const calls: string[] = [];
      globalThis.fetch = async (input, init) => {
        assert(init?.signal, 'authentication, limiter and logging must remain bounded');
        const url = new URL(String(input));
        const table = url.pathname.split('/').at(-1)!;
        calls.push(table);
        if (table === 'user') return Response.json({ id: 'owner', aud: 'authenticated', role: 'authenticated' });
        if (table === 'check_rate_limit') {
          assertEquals(JSON.parse(String(init?.body)), { p_endpoint: 'ai-agent-reply-sandbox', p_identifier: 'user:owner', p_max_requests: 60, p_window_seconds: 900 });
          return Response.json({ allowed: false, count: 61, remaining: 0, retryAfter: 900 });
        }
        if (table === 'system_logs') return Response.json(null);
        if (table === 'user_roles') return Response.json(isAdmin ? { role: 'admin' } : null);
        if (table === 'system_settings') return Response.json([]);
        throw new Error(`Unexpected policy work: ${table}`);
      };
      try {
        const response = await handleReply(new Request('https://fixture.invalid/functions/v1/ai-agent-reply', {
          method: 'POST', headers: { Authorization: `Bearer ${crypto.randomUUID()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, inbound_text: 'hello' }),
        }));
        assertEquals(response.status, 429);
        assertEquals(response.headers.get('Retry-After'), '900');
        assertEquals((await response.json()).code, 'rate_limited');
        assertEquals(calls, ['user', 'check_rate_limit', 'system_logs']);
      } finally {
        globalThis.fetch = originalFetch;
        for (const [name, value] of saved) { if (value === undefined) Deno.env.delete(name); else Deno.env.set(name, value); }
      }
    });
  }
}
