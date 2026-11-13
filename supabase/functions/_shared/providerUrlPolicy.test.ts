import { assertEquals, assertRejects, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { assertProviderUrl, providerFetch } from './providerUrlPolicy.ts';
import { redactProviderError } from './ai-routing-errors.ts';

Deno.test('provider URLs reject private, metadata, disguised and arbitrary hosts', () => {
  for (const url of ['http://api.openai.com/v1', 'https://127.0.0.1', 'https://10.0.0.1',
    'https://172.16.0.1', 'https://192.168.1.1', 'https://169.254.169.254/latest/meta-data',
    'https://[::1]', 'https://[fe80::1]', 'https://[::ffff:127.0.0.1]',
    'https://localhost', 'https://metadata.google.internal', 'https://2130706433',
    'https://0177.0.0.1', 'https://api.openai.com.evil.test', 'https://evil.test',
    'https://api.openai.com:8443', 'https://user:secret@api.openai.com']) {
    assertThrows(() => assertProviderUrl(url));
  }
  assertEquals(assertProviderUrl('https://api.openai.com/v1').hostname, 'api.openai.com');
});

Deno.test('provider transport refuses redirects without following them', async () => {
  let calls = 0;
  const transport = providerFetch((async (_input, init) => {
    calls++;
    assertEquals(init?.redirect, 'error');
    return new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/' } });
  }) as typeof fetch);
  await assertRejects(() => transport('https://api.openai.com/v1'), Error, 'redirects');
  assertEquals(calls, 1);
  await assertRejects(() => transport('https://localhost/'));
  assertEquals(calls, 1);
});

Deno.test('standalone and whitespace credential parameters are redacted', () => {
  for (const boundary of ['', ' ', '?', '&', '\n']) {
    for (const key of ['api_key', 'api-key', 'token', 'access_token', 'secret', 'password', 'auth']) {
      assertEquals(redactProviderError(`${boundary}${key}=encoded%2Bvalue`, 'other-key'), `${boundary}${key}=[REDACTED]`);
    }
  }
});
