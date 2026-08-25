import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createEvolutionApi, normalizeEvolutionEvent } from "./evolutionApi.ts";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("Evolution API client sends instance creation to the configured public endpoint", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const apiKey = crypto.randomUUID();
  const jwtKey = crypto.randomUUID();
  const api = createEvolutionApi(async (url, init) => {
    calls.push({ url: String(url), init });
    return response({ instance: { instanceName: "postora-account-1" } });
  }, { baseUrl: "https://wa.postora.cloud", apiKey });

  await api.createInstance({
    instanceName: "postora-account-1",
    webhook: {
      url: "https://api.postora.cloud/functions/v1/whatsapp-evolution-webhook",
      headers: { jwt_key: jwtKey },
      events: ["MESSAGES_UPSERT", "CONNECTION_UPDATE", "QRCODE_UPDATED"],
    },
  });

  assertEquals(calls[0].url, "https://wa.postora.cloud/instance/create");
  assertEquals(calls[0].init?.method, "POST");
  assertEquals((calls[0].init?.headers as Record<string, string>).apikey, apiKey);
  assertEquals(JSON.parse(String(calls[0].init?.body)), {
    instanceName: "postora-account-1",
    integration: "WHATSAPP-BAILEYS",
    qrcode: true,
    webhook: {
      enabled: true,
      url: "https://api.postora.cloud/functions/v1/whatsapp-evolution-webhook",
      webhookByEvents: false,
      webhookBase64: false,
      headers: { jwt_key: jwtKey },
      events: ["MESSAGES_UPSERT", "CONNECTION_UPDATE", "QRCODE_UPDATED"],
    },
  });
});

Deno.test("Evolution API client sends text, media, and delete-for-everyone through the instance routes", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const apiKey = crypto.randomUUID();
  const api = createEvolutionApi(async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return response({ key: { id: "message-1" } });
  }, { baseUrl: "https://wa.postora.cloud", apiKey });

  await api.sendText("postora-account-1", { number: "+96550000000", text: "hello" });
  await api.sendMedia("postora-account-1", {
    number: "+96550000000",
    mediaType: "image",
    media: "https://cdn.example/image.jpg",
    caption: "caption",
  });
  await api.deleteMessageForEveryone("postora-account-1", {
    id: "3EB0ABC",
    remoteJid: "96550000000@s.whatsapp.net",
    fromMe: true,
  });

  assertEquals(calls, [
    {
      url: "https://wa.postora.cloud/message/sendText/postora-account-1",
      body: { number: "+96550000000", text: "hello" },
    },
    {
      url: "https://wa.postora.cloud/message/sendMedia/postora-account-1",
      body: {
        number: "+96550000000",
        mediatype: "image",
        media: "https://cdn.example/image.jpg",
        caption: "caption",
      },
    },
    {
      url: "https://wa.postora.cloud/chat/deleteMessageForEveryone/postora-account-1",
      body: {
        id: "3EB0ABC",
        remoteJid: "96550000000@s.whatsapp.net",
        fromMe: true,
      },
    },
  ]);
});

Deno.test("deleteMessageForEveryone uses DELETE on the Evolution chat route", async () => {
  const calls: Array<{ url: string; method: string | undefined }> = [];
  const api = createEvolutionApi(async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    return response({ message: { protocolMessage: { type: "REVOKE" } } });
  }, { baseUrl: "https://wa.postora.cloud", apiKey: "k" });

  await api.deleteMessageForEveryone("postora-account-1", {
    id: "3EB0ABC",
    remoteJid: "96550000000@s.whatsapp.net",
    fromMe: true,
  });

  assertEquals(calls, [{
    url: "https://wa.postora.cloud/chat/deleteMessageForEveryone/postora-account-1",
    method: "DELETE",
  }]);
});

Deno.test("Evolution API client rejects a request that exceeds its deadline", async () => {
  const apiKey = crypto.randomUUID();
  const api = createEvolutionApi(() => new Promise<Response>(() => {}), {
    baseUrl: "https://wa.postora.cloud",
    apiKey,
    timeoutMs: 5,
  });

  await assertRejects(
    () => api.connectionState("postora-account-1"),
    Error,
    "Evolution API request timed out",
  );
});

Deno.test("Evolution event names normalize onto the registered subscription names", async (t) => {
  // Regression (2026-08-21): Direct QR connect linked on the phone but never activated in
  // Postora. Evolution subscribes with SCREAMING_SNAKE names but delivers the dot-lowercase
  // form in the webhook body, so the handler's raw `body.event === "CONNECTION_UPDATE"`
  // comparison never matched and every connection and message event was dropped.
  const deliveries: Array<[unknown, string]> = [
    ["connection.update", "CONNECTION_UPDATE"],
    ["messages.upsert", "MESSAGES_UPSERT"],
    ["qrcode.updated", "QRCODE_UPDATED"],
    ["CONNECTION_UPDATE", "CONNECTION_UPDATE"],
    ["connection-update", "CONNECTION_UPDATE"],
    [undefined, ""],
    [null, ""],
  ];

  for (const [delivered, registered] of deliveries) {
    await t.step(`${String(delivered)} matches ${registered || "nothing"}`, () => {
      assertEquals(normalizeEvolutionEvent(delivered), registered);
    });
  }
});

Deno.test("history reads unwrap the shapes Evolution actually returns", async (t) => {
  // Measured against v2.3.7: findChats and findContacts answer with a bare array, but
  // findMessages answers with a paged envelope. Treating the envelope as a list -- which
  // the original design assumed -- silently imports nothing.
  // findMessages returns { records, complete }; the others still return bare arrays, so
  // each case normalises to the record list before counting.
  const recordsOf = (value: any): any[] => Array.isArray(value) ? value : value.records;
  const cases: Array<[string, unknown, (api: ReturnType<typeof createEvolutionApi>) => Promise<any>, number]> = [
    ["findChats array", [{ remoteJid: "1@s.whatsapp.net" }], (api) => api.findChats("i"), 1],
    ["findContacts array", [{ remoteJid: "1@s.whatsapp.net" }, { remoteJid: "2@s.whatsapp.net" }], (api) => api.findContacts("i"), 2],
    // pages: 1 keeps this a single-page unwrapping case. Multi-page walking is covered
    // by its own test below, with a stub that actually serves different pages -- a stub
    // that returns the same page forever would just walk to the ceiling.
    ["findMessages envelope", { messages: { total: 1, pages: 1, records: [{ key: { id: "a" } }] } }, (api) => api.findMessages("i", "1@s.whatsapp.net"), 1],
    ["findMessages empty envelope", { messages: { total: 0, records: [] } }, (api) => api.findMessages("i", "1@s.whatsapp.net"), 0],
    ["unexpected payload", { error: "nope" }, (api) => api.findMessages("i", "1@s.whatsapp.net"), 0],
  ];

  for (const [label, payload, call, expected] of cases) {
    await t.step(label, async () => {
      const api = createEvolutionApi(async () => response(payload), {
        baseUrl: "https://wa.postora.cloud",
        apiKey: "k",
      });
      assertEquals(recordsOf(await call(api)).length, expected);
    });
  }
});

// The bug this guards: findMessages caps a page at ~40 rows regardless of the offset
// asked for, so stopping on `records.length < offset` ends every chat at page one and
// silently restores the single-page behaviour pagination exists to replace. These pages
// are all SHORTER than the offset of 50 and must still all be walked.
Deno.test("findMessages walks every page even when each is shorter than the offset", async () => {
  const pages: Record<number, unknown[]> = {
    1: Array.from({ length: 40 }, (_, i) => ({ key: { id: `p1-${i}` } })),
    2: Array.from({ length: 40 }, (_, i) => ({ key: { id: `p2-${i}` } })),
    3: Array.from({ length: 30 }, (_, i) => ({ key: { id: `p3-${i}` } })),
  };
  const requested: number[] = [];
  const api = createEvolutionApi(async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body));
    requested.push(body.page);
    return response({ messages: { total: 110, pages: 3, records: pages[body.page] ?? [] } });
  }, { baseUrl: "https://wa.postora.cloud", apiKey: "k" });

  const result = await api.findMessages("i", "1@s.whatsapp.net");

  assertEquals(requested, [1, 2, 3]);
  assertEquals(result.records.length, 110);
  assertEquals(result.complete, true);
});

Deno.test("findMessages reports incomplete when it stops at the page ceiling", async () => {
  // A server claiming more pages than the ceiling allows must not be reported as a
  // finished chat, or the caller records a partial import as a completed sweep.
  const api = createEvolutionApi(async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body));
    return response({
      messages: { total: 5000, pages: 100, records: [{ key: { id: `p${body.page}` } }] },
    });
  }, { baseUrl: "https://wa.postora.cloud", apiKey: "k" });

  const result = await api.findMessages("i", "1@s.whatsapp.net");

  assertEquals(result.records.length, 20);
  assertEquals(result.complete, false);
});

Deno.test("findMessages treats a bare array as one page and never re-requests it", async () => {
  // A deployment that ignores `page` answers with the bare array shape. Asking again
  // would accumulate the same rows nineteen more times.
  let calls = 0;
  const api = createEvolutionApi(async () => {
    calls += 1;
    return response([{ key: { id: "a" } }, { key: { id: "b" } }]);
  }, { baseUrl: "https://wa.postora.cloud", apiKey: "k" });

  const result = await api.findMessages("i", "1@s.whatsapp.net");

  assertEquals(calls, 1);
  assertEquals(result.records.length, 2);
  assertEquals(result.complete, true);
});
