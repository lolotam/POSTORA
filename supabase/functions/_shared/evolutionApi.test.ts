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

Deno.test("Evolution API client sends text and media through the instance routes", async () => {
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
  ]);
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
