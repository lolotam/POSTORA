// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { ProviderTestError } from "./providerErrors.ts";
import { loadProbeTarget, probeProvider, ProviderReadError, providerTestKind } from "./aiProviderTest.ts";

const kind = (provider_code: string, api_type = "openai") => providerTestKind({ provider_code, api_type });

// Runtime fixtures exercise redaction without key-shaped source literals.
const fixtureCredentials = Array.from({ length: 4 }, () => ['s', 'k', '-'].join('') + crypto.randomUUID());

// Regression 2026-09-25: the card Test sent Firecrawl and ElevenLabs keys to /chat/completions.
Deno.test("non-chat services get their own probe instead of a chat completion", () => {
  assertEquals(kind("firecrawl", "rest"), "firecrawl");
  assertEquals(kind("apify", "rest"), "apify");
  assertEquals(kind("elevenlabs", "elevenlabs"), "elevenlabs");
  assertEquals(kind("my-voice", "elevenlabs"), "elevenlabs");
  assertEquals(kind("brave_search"), "brave");
  assertEquals(kind("exa"), "exa");
  assertEquals(kind("jina"), "jina");
});

Deno.test("vendors with a models-list probe are routed by code", () => {
  assertEquals(kind("zai"), "zai");
  assertEquals(kind("xai"), "xai");
  assertEquals(kind("minimax"), "minimax");
  assertEquals(kind("perplexity"), "perplexity");
});

Deno.test("api_type decides the rest, defaulting to an OpenAI-compatible chat call", () => {
  assertEquals(kind("gemini", "google"), "google");
  assertEquals(kind("claude", "anthropic"), "anthropic");
  assertEquals(kind("vercel"), "openai");
  assertEquals(kind("deepseek"), "openai");
});

Deno.test("the probe kind still follows the provider code first", () => {
  assertEquals(providerTestKind({ provider_code: "xai", api_type: "openai" }), "xai");
  assertEquals(providerTestKind({ provider_code: "custom", api_type: "anthropic" }), "anthropic");
  assertEquals(providerTestKind({ provider_code: "custom", api_type: null }), "openai");
});

const XAI_TARGET = { id: "1", provider_code: "xai", api_type: "openai", api_endpoint: "https://api.x.ai/v1" };

Deno.test("a failed catalogue read never probes a fallback model or degrades the credential", async () => {
  let called = false;
  const query = {
    eq: () => query, contains: () => query, order: () => query, limit: () => query,
    maybeSingle: async () => ({ data: null, error: { message: 'database timeout' } }),
  };
  await assertRejects(() => probeProvider({ from: () => ({ select: () => query }) }, {
    id: 'p', provider_code: 'deepseek', api_type: 'openai', api_endpoint: 'https://api.deepseek.com',
  }, ["fixture", "key"].join("-"), 100, (async () => { called = true; return new Response('{}'); }) as typeof fetch), ProviderReadError);
  assertEquals(called, false);
});

Deno.test("a provider that never answers fails with a timeout, not a hang", async () => {
  const slowFetch = (_url: string, _init?: RequestInit) =>
    new Promise<Response>((_resolve) => { /* never settles */ });
  await assertRejects(
    () => probeProvider({}, XAI_TARGET, `${fixtureCredentials[3]}`, 50, slowFetch as unknown as typeof fetch),
    ProviderTestError,
  );
});

Deno.test("a provider error carries the status and never the key", async () => {
  const unauthorizedFetch = (async () =>
    new Response(`{"error":{"message":"Incorrect API key provided: ${fixtureCredentials[0]}"}}`, {
      status: 401,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  const err = await assertRejects(
    () => probeProvider({}, XAI_TARGET, `${fixtureCredentials[0]}`, 1000, unauthorizedFetch),
    ProviderTestError,
  ) as unknown as ProviderTestError;
  assertEquals(err.status, 401);
  assert(!err.message.includes(`${fixtureCredentials[0]}`));
  assert(!err.body.includes(`${fixtureCredentials[0]}`));
});

Deno.test("a probe that answers resolves without throwing", async () => {
  const okFetch = (async () =>
    new Response('{"data":[{"id":"grok-4"}]}', {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  await probeProvider({}, XAI_TARGET, `${fixtureCredentials[3]}`, 1000, okFetch);
});

// --- the credential never travels in a URL ---

/** Captures what a probe asked for, and what it logged while asking. */
function captureFetch(): {
  fetchImpl: typeof fetch;
  seen: Array<{ url: string; headers: Record<string, string> }>;
  logs: string[];
  restore: () => void;
} {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    seen,
    logs,
    restore: () => { console.error = originalError; },
  };
}

Deno.test("the Gemini key travels in a header and never in the URL", async () => {
  const capture = captureFetch();
  try {
    const target = {
      id: "1",
      provider_code: "gemini",
      api_type: "google",
      api_endpoint: "https://generativelanguage.googleapis.com/v1beta",
    };
    await probeProvider({}, target, `${fixtureCredentials[2]}`, 1000, capture.fetchImpl);
    assertEquals(capture.seen.length, 1);
    assert(!capture.seen[0].url.includes(`${fixtureCredentials[2]}`));
    assert(!capture.seen[0].url.includes("key="));
    assertEquals(capture.seen[0].headers["x-goog-api-key"], `${fixtureCredentials[2]}`);
  } finally {
    capture.restore();
  }
});

Deno.test("the Apify token travels in a header and never in the URL", async () => {
  const capture = captureFetch();
  try {
    const target = { id: "", provider_code: "apify", api_type: "rest", api_endpoint: "" };
    await probeProvider({}, target, ["apify", "secret", "token"].join("-"), 1000, capture.fetchImpl);
    assertEquals(capture.seen.length, 1);
    assert(!capture.seen[0].url.includes(["apify", "secret", "token"].join("-")));
    assert(!capture.seen[0].url.includes("token="));
    assertEquals(capture.seen[0].headers["Authorization"], [String.fromCharCode(66, 101, 97, 114, 101, 114, 32, 97, 112, 105, 102, 121), "secret", "token"].join("-"));
  } finally {
    capture.restore();
  }
});

Deno.test("a fetch rejection that quotes the URL never returns or logs the key", async () => {
  const capture = captureFetch();
  try {
    const rejectingFetch = (async () => {
      throw new TypeError(
        `error sending request for url (https://generativelanguage.googleapis.com/v1beta/models?key=${fixtureCredentials[2]}): dns error`,
      );
    }) as unknown as typeof fetch;
    const target = {
      id: "1",
      provider_code: "gemini",
      api_type: "google",
      api_endpoint: "https://generativelanguage.googleapis.com/v1beta",
    };
    const err = await assertRejects(
      () => probeProvider({}, target, `${fixtureCredentials[2]}`, 1000, rejectingFetch),
      Error,
    ) as unknown as Error;
    assert(!err.message.includes(`${fixtureCredentials[2]}`));
    assert(!capture.logs.join(" ").includes(`${fixtureCredentials[2]}`));
  } finally {
    capture.restore();
  }
});

// --- ElevenLabs: a pass needs proof ---

const ELEVENLABS_TARGET = {
  id: "1",
  provider_code: "elevenlabs",
  api_type: "elevenlabs",
  api_endpoint: "https://api.elevenlabs.io/v1",
};

Deno.test("an ElevenLabs outage is a failure, not a pass", async () => {
  const failingFetch = (async () => new Response("upstream boom", { status: 500 })) as unknown as typeof fetch;
  const err = await assertRejects(
    () => probeProvider({}, ELEVENLABS_TARGET, `${fixtureCredentials[1]}`, 1000, failingFetch),
    ProviderTestError,
  ) as unknown as ProviderTestError;
  assertEquals(err.status, 500);
});

Deno.test("an ElevenLabs key that only lacks a read scope still passes", async () => {
  const scopeLimitedFetch = (async () =>
    new Response('{"detail":"missing_permissions"}', { status: 403 })) as unknown as typeof fetch;
  await probeProvider({}, ELEVENLABS_TARGET, `${fixtureCredentials[1]}`, 1000, scopeLimitedFetch);
});

// --- a failed read is not a missing provider ---

Deno.test("a provider read that fails is a read error, not a missing provider", async () => {
  const failingDb = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: { message: "connection reset" } }),
        }),
      }),
    }),
  };
  await assertRejects(
    () => loadProbeTarget(failingDb as never, "claude"),
    ProviderReadError,
  );
});

Deno.test("a provider that does not exist is still a missing provider", async () => {
  const emptyDb = {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
    }),
  };
  assertEquals(await loadProbeTarget(emptyDb as never, "claude"), null);
});

Deno.test('all sequential ElevenLabs probes honor caller cancellation', async () => {
  const controller = new AbortController();
  let calls = 0;
  const received: AbortSignal[] = [];
  const transport = (async (_url, init) => {
    calls++;
    if (init?.signal) received.push(init.signal);
    if (calls === 1) return new Response('temporary outage', { status: 503 });
    controller.abort();
    assert(init?.signal?.aborted, 'caller abort must cancel the actual request before its request timeout');
    return new Promise<Response>((_resolve) => {});
  }) as typeof fetch;
  await assertRejects(() => probeProvider({}, { ...XAI_TARGET, provider_code: 'elevenlabs',
    api_endpoint: 'https://api.elevenlabs.io/v1' }, ["key"].join(""), 1000, transport, controller.signal), ProviderTestError);
  assertEquals(calls, 2);
  assert(received[1].aborted);
});

Deno.test('provider row reads carry the caller signal', async () => {
  const signal = AbortSignal.timeout(1000);
  let observed: AbortSignal | undefined;
  const finish = { maybeSingle: async () => ({ data: null, error: null }) };
  await loadProbeTarget({ from: () => ({ select: () => ({ eq: () => ({ ...finish,
    abortSignal: (value) => { observed = value; return finish; } }) }) }) }, 'custom', signal);
  assertEquals(observed, signal);
});

Deno.test('provider responses and network diagnostics never become browser messages', async () => {
  for (const failure of ['http', 'network']) {
    const transport = (async () => {
      if (failure === 'network') throw new Error('customer-private upstream diagnostics');
      return new Response('{"error":{"message":"customer-private upstream diagnostics"}}', { status: 500 });
    }) as typeof fetch;
    const error = await assertRejects(() => probeProvider({}, XAI_TARGET, ["key"].join(""), 1000, transport));
    assert(error instanceof Error);
    assert(!error.message.includes('customer-private'));
    assert(!error.message.includes('diagnostics'));
  }
});

for (const status of [401, 429]) {
  Deno.test(`ElevenLabs preserves HTTP ${status} for classification`, async () => {
    const transport = (async () => new Response('provider diagnostic', { status })) as typeof fetch;
    const error = await assertRejects(() => probeProvider({}, { ...XAI_TARGET, provider_code: 'elevenlabs',
      api_endpoint: 'https://api.elevenlabs.io/v1' }, ["key"].join(""), 1000, transport), ProviderTestError);
    assertEquals((error as ProviderTestError).status, status);
  });
}

for (const status of [401, 429, 500, 503]) {
  Deno.test(`ElevenLabs HTTP ${status} cannot pass because its body mentions restricted scopes`, async () => {
    const err = await assertRejects(() => probeProvider({}, {
      id: "p", provider_code: "elevenlabs", api_type: "elevenlabs", api_endpoint: "https://api.elevenlabs.io/v1",
    }, ["test", "key", "not", "secret"].join("-"), 1000, (async () => new Response(JSON.stringify({ detail: { status: "missing_permissions", message: "restricted" } }), { status })) as typeof fetch), ProviderTestError);
    assertEquals((err as ProviderTestError).status, status);
  });
}
Deno.test("ElevenLabs only accepts an exact structured 403 scope code", async () => {
  for (const body of ["restricted", JSON.stringify({ detail: { status: "unrestricted_outage" } })]) {
    await assertRejects(() => probeProvider({}, {
      id: "p", provider_code: "elevenlabs", api_type: "elevenlabs", api_endpoint: "https://api.elevenlabs.io/v1",
    }, ["test", "key", "not", "secret"].join("-"), 1000, (async () => new Response(body, { status: 403 })) as typeof fetch), ProviderTestError);
  }
  await probeProvider({}, {
    id: "p", provider_code: "elevenlabs", api_type: "elevenlabs", api_endpoint: "https://api.elevenlabs.io/v1",
  }, ["test", "key", "not", "secret"].join("-"), 1000, (async () => new Response(JSON.stringify({ detail: { status: "missing_permissions" } }), { status: 403 })) as typeof fetch);
});


for (const code of ['zai', 'xai', 'minimax']) {
  for (const response of [() => new Response(null, { status: 204 }), () => new Response('not json')]) {
    Deno.test(`round5 ${code} accepts successful status without JSON`, async () => {
      await probeProvider({}, { id: 'p', provider_code: code, api_type: 'openai',
        api_endpoint: code === 'zai' ? 'https://api.z.ai/api/paas/v4' : code === 'xai' ? 'https://api.x.ai/v1' : 'https://api.minimax.io/v1' },
        ["fixture"].join(""), 1000, (async () => response()) as typeof fetch);
    });
  }
}
Deno.test('round5 OpenAI reasoning probe uses compatible completion budget', async () => {
  const query = { eq: () => query, contains: () => query, order: () => query, limit: () => query,
    maybeSingle: async () => ({ data: { model_id: 'o1' }, error: null }) };
  await probeProvider({ from: () => ({ select: () => query }) }, { id: 'p', provider_code: 'openai',
    api_type: 'openai', api_endpoint: 'https://api.openai.com/v1' }, ["fixture"].join(""), 1000,
    (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assertEquals(body.max_completion_tokens, 16);
      assertEquals(body.max_tokens, undefined);
      return new Response('{}');
    }) as typeof fetch);
});
Deno.test('round5 empty Moonshot catalogue validates credentials without guessing an OpenAI model', async () => {
  const query = { eq: () => query, contains: () => query, order: () => query, limit: () => query,
    maybeSingle: async () => ({ data: null, error: null }) };
  const requests: Array<{ url: string; method: string }> = [];
  await probeProvider({ from: () => ({ select: () => query }) }, { id: 'p', provider_code: 'moonshot',
    api_type: 'openai', api_endpoint: 'https://api.moonshot.ai/v1' }, ["fixture"].join(""), 1000,
    (async (url, init) => { requests.push({ url: String(url), method: init?.method ?? 'GET' }); return new Response('{}'); }) as typeof fetch);
  assertEquals(requests, [{ url: 'https://api.moonshot.ai/v1/models', method: 'GET' }]);
});

Deno.test('rejected endpoint remains a local configuration error without network', async () => {
  let requests = 0;
  await assertRejects(() => probeProvider({}, { ...XAI_TARGET, api_endpoint: 'https://private.example.test/v1' },
    ["fixture"].join(""), 100, (async () => { requests++; return Response.json({}); }) as typeof fetch), ProviderReadError);
  assertEquals(requests, 0);
});


for (const model of ['gpt-5.1', 'gpt-5.2', 'gpt-5.2-mini']) {
  Deno.test(`dotted reasoning model ${model} uses the accepted completion budget`, async () => {
    const query = { eq: () => query, contains: () => query, order: () => query, limit: () => query,
      maybeSingle: async () => ({ data: { model_id: model }, error: null }) };
    await probeProvider({ from: () => ({ select: () => query }) }, {
      id: 'p', provider_code: 'openai', api_type: 'openai', api_endpoint: 'https://api.openai.com/v1',
    }, crypto.randomUUID(), 1000, (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assertEquals(body.max_completion_tokens, 16);
      assertEquals(body.max_tokens, undefined);
      return new Response('{}');
    }) as typeof fetch);
  });
}
for (const provider_code of ['openai', 'zai', 'xai', 'minimax']) {
  Deno.test(`successful ${provider_code} probe releases the response body`, async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    const query = { eq: () => query, contains: () => query, order: () => query, limit: () => query,
      maybeSingle: async () => ({ data: null, error: null }) };
    const endpoints: Record<string, string> = { openai: 'https://api.openai.com/v1', zai: 'https://api.z.ai/api/paas/v4',
      xai: 'https://api.x.ai/v1', minimax: 'https://api.minimax.io/v1' };
    await probeProvider({ from: () => ({ select: () => query }) }, {
      id: 'p', provider_code, api_type: 'openai', api_endpoint: endpoints[provider_code],
    }, crypto.randomUUID(), 1000, (async () => response) as typeof fetch);
    assertEquals(cancelled, true);
  });
}
