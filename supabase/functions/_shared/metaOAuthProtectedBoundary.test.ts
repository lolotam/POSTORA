/**
 * The protected Meta OAuth boundary: service reads, request agreement,
 * truthful token selection, and bounded provider HTTP.
 *
 * These tests call the helper directly. They do not open a network socket.
 */
import { assertEquals, assertRejects, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  BoundaryContractError,
  ProtectedProviderFailure,
  assertClaimAgrees,
  assertCompleteAgrees,
  assertReceiptAgrees,
  cleanProviderId,
  createOperationBudget,
  exchangeProtectedDirectLogin,
  logProtectedFailure,
  protectedFetchJson,
  protectedWebhookSubscribe,
  readMaybeSingle,
  readServiceEnvelope,
  selectProviderToken,
} from "./metaOAuthProtectedBoundary.ts";

const SECRET = "provider-token-must-not-leak";

Deno.test("a service envelope distinguishes a row, absence and a failure", () => {
  assertEquals(readServiceEnvelope({ data: { id: "1" }, error: null }).status, "row");
  assertEquals(readServiceEnvelope({ data: null, error: null }).status, "missing");
  assertEquals(readServiceEnvelope({ data: null, error: { message: SECRET } }), {
    status: "failed",
    reason: "driver",
  });
  assertEquals(readServiceEnvelope({ data: { id: "1" } }).status, "failed");
  assertEquals(readServiceEnvelope({ data: { id: "1" }, error: undefined }).status, "failed");
  assertEquals(readServiceEnvelope({ data: [], error: null }).status, "failed");
});

Deno.test("a PostgREST thenable without catch is a real read", async () => {
  const present: PromiseLike<unknown> = {
    then(onfulfilled, onrejected) {
      return Promise.resolve({ data: { id: "row-1" }, error: null }).then(onfulfilled, onrejected);
    },
  };
  const read = await readMaybeSingle(() => present);
  assertEquals(read.status, "row");
  if (read.status === "row") assertEquals(read.row.id, "row-1");

  const failing: PromiseLike<unknown> = {
    then(onfulfilled, onrejected) {
      return Promise.reject(new Error(SECRET)).then(onfulfilled, onrejected);
    },
  };
  const thrown = await readMaybeSingle(() => failing);
  assertEquals(thrown, { status: "failed", reason: "thrown" });
});

Deno.test("token selection never invents a 60 day lifetime", () => {
  assertEquals(selectProviderToken({
    shortToken: "short",
    shortExpiresIn: 3600,
    longLivedOk: false,
    longLivedToken: "long",
    longLivedExpiresIn: 5_184_000,
  }), { token: "short", expiresIn: 3600 });

  assertEquals(selectProviderToken({
    shortToken: "short",
    shortExpiresIn: 3600,
    longLivedOk: true,
    longLivedToken: "long",
    longLivedExpiresIn: undefined,
  }), { token: "long", expiresIn: null });

  assertEquals(selectProviderToken({
    shortToken: "short",
    shortExpiresIn: null,
    longLivedOk: false,
    longLivedToken: null,
    longLivedExpiresIn: null,
  }), { token: "short", expiresIn: null });
});

Deno.test("provider ids are clean strings and nothing else", () => {
  assertEquals(cleanProviderId("ig-1"), "ig-1");
  assertEquals(cleanProviderId("provider-id-123"), "provider-id-123");
  assertEquals(cleanProviderId(15), null);
  assertEquals(cleanProviderId({ id: "ig-1" }), null);
  assertEquals(cleanProviderId(" ig-1"), null);
  assertEquals(cleanProviderId(""), null);
  for (const id of ["provider\u0000id", "provider\nid", "provider\rid", "provider\u0001id", "provider\u007fid"]) {
    assertEquals(cleanProviderId(id), null);
  }
});

Deno.test("a direct profile HTTP 500 is not an identity", async () => {
  const fetcher = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("api.instagram.com")) {
      return Promise.resolve(new Response(JSON.stringify({
        access_token: "short",
        expires_in: 3600,
      }), { status: 200 }));
    }
    if (url.includes("ig_exchange_token")) {
      return Promise.resolve(new Response(JSON.stringify({
        access_token: "long",
        expires_in: 5_184_000,
      }), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({
      id: "ig-canonical",
      user_id: "ig-messaging",
      account_type: "BUSINESS",
    }), { status: 500 }));
  }) as typeof fetch;

  const error = await assertRejects(
    () => exchangeProtectedDirectLogin({
      appId: "app",
      appSecret: "secret",
      redirectUri: "https://postora.cloud/callback",
      code: "code-1",
      fetcher,
    }),
    ProtectedProviderFailure,
  );
  assertEquals((error as ProtectedProviderFailure).category, "provider_http_failure");
  assertEquals((error as Error).message.includes("ig-canonical"), false);
});

Deno.test("a numeric profile id is not coerced into an identity", async () => {
  const fetcher = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("api.instagram.com")) {
      return Promise.resolve(new Response(JSON.stringify({ access_token: "short", expires_in: 60 }), { status: 200 }));
    }
    if (url.includes("ig_exchange_token")) {
      return Promise.resolve(new Response(JSON.stringify({ access_token: "long" }), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({
      id: 15,
      user_id: { id: "msg" },
      account_type: "BUSINESS",
    }), { status: 200 }));
  }) as typeof fetch;

  const error = await assertRejects(
    () => exchangeProtectedDirectLogin({
      appId: "app",
      appSecret: "secret",
      redirectUri: "https://postora.cloud/callback",
      code: "code-1",
      fetcher,
    }),
    ProtectedProviderFailure,
  );
  assertEquals((error as ProtectedProviderFailure).category, "provider_identity_unverified");
});

Deno.test("a hung provider call becomes a timeout category", async () => {
  const hung = ((_input: unknown, init?: RequestInit) => new Promise<Response>((resolve) => {
    // Settle on a later turn so the timeout wins the race and nothing leaks.
    init?.signal?.addEventListener("abort", () => {
      setTimeout(() => resolve(new Response("{}", { status: 200 })), 0);
    });
  })) as typeof fetch;
  const error = await assertRejects(
    () => protectedFetchJson("https://graph.facebook.com/v22.0/me?access_token=SECRET", { method: "GET" }, {
      timeoutMs: 20,
      fetcher: hung,
    }),
    ProtectedProviderFailure,
  );
  assertEquals((error as ProtectedProviderFailure).category, "provider_timeout");
  assertEquals((error as Error).message.includes("SECRET"), false);
});

Deno.test("an exhausted operation budget refuses before another call", () => {
  let now = 1_000;
  const budget = createOperationBudget(30, () => now);
  assertEquals(budget.take(10), 10);
  now = 1_030;
  assertThrows(() => budget.take(10), ProtectedProviderFailure, "provider_timeout");
});

Deno.test("claim, completion and receipt results must agree with the request", () => {
  assertThrows(
    () => assertClaimAgrees(
      { attemptId: "attempt-a", flow: "facebook_page" },
      { attemptId: "attempt-b", flow: "facebook_page" },
    ),
    BoundaryContractError,
    "attempt_id",
  );
  assertThrows(
    () => assertCompleteAgrees(
      { attemptId: "attempt-a", flow: "facebook_page" },
      { attemptId: "attempt-a", flow: "instagram_direct" },
    ),
    BoundaryContractError,
    "flow",
  );
  assertThrows(
    () => assertReceiptAgrees(
      { attemptId: "attempt-a", selectionKey: "key-a", flow: "facebook_page" },
      { attemptId: "attempt-a", selectionKey: "key-b" },
    ),
    BoundaryContractError,
    "selection_key",
  );
  assertReceiptAgrees(
    { attemptId: "attempt-a", selectionKey: "key-a", flow: "instagram_direct" },
    { attemptId: "attempt-a", selectionKey: "key-a" },
  );
});

function jsonFetcher(status: number, body: unknown): typeof fetch {
  return (() =>
    Promise.resolve(new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }))) as typeof fetch;
}

Deno.test("a pre-aborted provider call does not start the fetch", async () => {
  let called = false;
  const error = await assertRejects(
    () => protectedFetchJson("https://synthetic.invalid/profile", { method: "GET" }, {
      timeoutMs: 1000,
      signal: AbortSignal.abort(),
      fetcher: (() => {
        called = true;
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch,
    }),
    ProtectedProviderFailure,
  );
  assertEquals((error as ProtectedProviderFailure).category, "provider_timeout");
  assertEquals(called, false);
});

Deno.test("caller cancellation before headers aborts the transport", async () => {
  const caller = new AbortController();
  const seen: { signal: AbortSignal | null } = { signal: null };
  const pending = protectedFetchJson("https://synthetic.invalid/profile", { method: "GET" }, {
    timeoutMs: 5000,
    signal: caller.signal,
    fetcher: ((_url: unknown, init?: RequestInit) => {
      seen.signal = init?.signal ?? null;
      return new Promise<Response>(() => undefined);
    }) as typeof fetch,
  });
  await Promise.resolve();
  caller.abort();
  const error = await assertRejects(() => pending, ProtectedProviderFailure);
  assertEquals((error as ProtectedProviderFailure).category, "provider_timeout");
  assertEquals(seen.signal?.aborted, true);
});

Deno.test("caller cancellation during the body settles and aborts the transport", async () => {
  const caller = new AbortController();
  const seen: { signal: AbortSignal | null } = { signal: null };
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(next) {
      controller = next;
    },
  });
  const pending = protectedFetchJson("https://synthetic.invalid/profile", { method: "GET" }, {
    timeoutMs: 5000,
    signal: caller.signal,
    fetcher: ((_url: unknown, init?: RequestInit) => {
      seen.signal = init?.signal ?? null;
      return Promise.resolve(new Response(stream, { status: 200 }));
    }) as typeof fetch,
  });
  await Promise.resolve();
  caller.abort();
  const error = await assertRejects(() => pending, ProtectedProviderFailure);
  controller.error(new Error("synthetic test cleanup"));
  assertEquals((error as ProtectedProviderFailure).category, "provider_timeout");
  assertEquals(seen.signal?.aborted, true);
});

Deno.test("a deadline before headers aborts the transport", async () => {
  const seen: { signal: AbortSignal | null } = { signal: null };
  const error = await assertRejects(
    () => protectedFetchJson("https://synthetic.invalid/profile", { method: "GET" }, {
      timeoutMs: 20,
      fetcher: ((_url: unknown, init?: RequestInit) => {
        seen.signal = init?.signal ?? null;
        return new Promise<Response>((resolve) => {
          init?.signal?.addEventListener("abort", () => {
            setTimeout(() => resolve(new Response("{}", { status: 200 })), 0);
          });
        });
      }) as typeof fetch,
    }),
    ProtectedProviderFailure,
  );
  assertEquals((error as ProtectedProviderFailure).category, "provider_timeout");
  assertEquals(seen.signal?.aborted, true);
});

Deno.test("a deadline during the body settles even when the body ignores abort", async () => {
  const seen: { signal: AbortSignal | null } = { signal: null };
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(next) {
      controller = next;
    },
  });
  const error = await assertRejects(
    () => protectedFetchJson("https://synthetic.invalid/profile", { method: "GET" }, {
      timeoutMs: 20,
      fetcher: ((_url: unknown, init?: RequestInit) => {
        seen.signal = init?.signal ?? null;
        return Promise.resolve(new Response(stream, { status: 200 }));
      }) as typeof fetch,
    }),
    ProtectedProviderFailure,
  );
  controller.error(new Error("synthetic test cleanup"));
  assertEquals((error as ProtectedProviderFailure).category, "provider_timeout");
  assertEquals(seen.signal?.aborted, true);
  assertEquals((error as Error).message.includes("synthetic"), false);
});

Deno.test("a normal JSON body stays inside the same deadline", async () => {
  const result = await protectedFetchJson("https://synthetic.invalid/profile", { method: "GET" }, {
    timeoutMs: 1000,
    fetcher: jsonFetcher(200, { id: "provider-id-123" }),
  });
  assertEquals(result, { status: 200, ok: true, body: { id: "provider-id-123" } });
});

Deno.test("a settled provider call removes the deadline and the caller listener", async () => {
  const caller = new AbortController();
  let adds = 0;
  let removes = 0;
  const signal = caller.signal;
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (type === "abort") adds += 1;
    originalAdd(type, listener, options);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
    if (type === "abort") removes += 1;
    originalRemove(type, listener, options);
  }) as typeof signal.removeEventListener;
  try {
    const result = await protectedFetchJson("https://synthetic.invalid/profile", { method: "GET" }, {
      timeoutMs: 1000,
      signal,
      fetcher: jsonFetcher(200, { ok: true }),
    });
    assertEquals(result.body, { ok: true });
    assertEquals(adds, 1);
    assertEquals(removes, 1);
    caller.abort();
  } finally {
    signal.addEventListener = originalAdd;
    signal.removeEventListener = originalRemove;
  }
});

Deno.test("a direct profile id with a control character is not an identity", async () => {
  for (const profile of [
    { id: "provider\u0000id", user_id: "ig-messaging" },
    { id: "ig-canonical", user_id: "provider\nid" },
  ]) {
    const error = await assertRejects(
      () => exchangeProtectedDirectLogin({
        appId: "app",
        appSecret: "secret",
        redirectUri: "https://postora.cloud/callback",
        code: "code-1",
        fetcher: ((input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("api.instagram.com")) {
            return Promise.resolve(new Response(JSON.stringify({ access_token: "short", expires_in: 60 }), { status: 200 }));
          }
          if (url.includes("ig_exchange_token")) {
            return Promise.resolve(new Response(JSON.stringify({ access_token: "long" }), { status: 200 }));
          }
          return Promise.resolve(new Response(JSON.stringify({ ...profile, account_type: "BUSINESS" }), { status: 200 }));
        }) as typeof fetch,
      }),
      ProtectedProviderFailure,
    );
    assertEquals((error as ProtectedProviderFailure).category, "provider_identity_unverified");
  }

  const ok = await exchangeProtectedDirectLogin({
    appId: "app",
    appSecret: "secret",
    redirectUri: "https://postora.cloud/callback",
    code: "code-1",
    fetcher: ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.instagram.com")) {
        return Promise.resolve(new Response(JSON.stringify({ access_token: "short", expires_in: 60 }), { status: 200 }));
      }
      if (url.includes("ig_exchange_token")) {
        return Promise.resolve(new Response(JSON.stringify({ access_token: "long" }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        id: "provider-id-123",
        user_id: "ig-messaging",
        account_type: "BUSINESS",
      }), { status: 200 }));
    }) as typeof fetch,
  });
  assertEquals(ok.kind, "ok");
  if (ok.kind === "ok") {
    assertEquals(ok.canonicalId, "provider-id-123");
    assertEquals(ok.igid, "ig-messaging");
  }
});

Deno.test("subscription success is the Meta success body, not HTTP 200 alone", async () => {
  await protectedWebhookSubscribe({
    url: "https://graph.facebook.com/v22.0/page-1/subscribed_apps",
    fetcher: jsonFetcher(200, { success: true }),
  });

  for (const body of [
    { success: false },
    {},
    { data: [] },
    { success: "true" },
    { success: true, error: { message: "synthetic provider text" } },
    null,
  ]) {
    const error = await assertRejects(
      () => protectedWebhookSubscribe({
        url: "https://graph.facebook.com/v22.0/page-1/subscribed_apps?access_token=SECRET",
        fetcher: jsonFetcher(200, body),
      }),
      ProtectedProviderFailure,
    );
    assertEquals((error as ProtectedProviderFailure).category, "subscription_unconfirmed");
    assertEquals((error as Error).message.includes("SECRET"), false);
    assertEquals((error as Error).message.includes("synthetic"), false);
  }
});

Deno.test("protected failure logs keep the category and drop the provider text", () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" "));
  };
  try {
    logProtectedFailure(
      "boundary-test",
      new Error(`https://graph.facebook.com/me?access_token=${SECRET} ${SECRET}`),
    );
  } finally {
    console.error = original;
  }
  const text = lines.join("\n");
  assertEquals(text.includes(SECRET), false);
  assertEquals(text.includes("unexpected"), true);
  assertEquals(text.includes("protected_oauth_failed"), true);
});
