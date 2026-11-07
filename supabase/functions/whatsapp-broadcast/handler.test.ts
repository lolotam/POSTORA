import { assertEquals } from "jsr:@std/assert@1";
import { handleWhatsAppBroadcast, type BroadcastDeps } from "./handler.ts";

const USER = "user-1";
const BROADCAST_ID = "11111111-1111-4111-8111-111111111111";

function deps(extra: Partial<BroadcastDeps> = {}) {
  const gate = {
    kicks: 0,
    refusals: [] as Array<{ userId: string; broadcastId: string }>,
    logRecipientReadFailure: async (userId: string, broadcastId: string) => {
      gate.refusals.push({ userId, broadcastId });
    },
    starts: [] as string[],
    authenticate: async () => ({ userId: USER }),
    loadBroadcast: async () => ({
      id: BROADCAST_ID,
      status: "pending",
      name: "Promo",
      template_name: "hello",
      template_components: { language: "en_US" },
      sent_count: 0,
      failed_count: 0,
    }),
    loadWhatsAppAccounts: async () => [
      { access_token: "cloud-token", platform_user_id: "phone-number-id", account_metadata: {} },
    ],
    hasPendingRecipients: async () => true,
    startBroadcast: async (_userId: string, broadcastId: string) => {
      gate.starts.push(broadcastId);
      return "job-1";
    },
    kickWorker: async () => {
      gate.kicks += 1;
    },
  };
  return Object.assign(gate, extra);
}

function request(body: Record<string, unknown> = { broadcast_id: BROADCAST_ID }): Request {
  return new Request("https://api.example/whatsapp-broadcast", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

Deno.test("a valid send answers 202 with the job id and kicks the worker", async () => {
  const gate = deps();

  const response = await handleWhatsAppBroadcast(request(), gate);

  assertEquals(response.status, 202);
  assertEquals(await response.json(), {
    accepted: true,
    jobId: "job-1",
    broadcast_id: BROADCAST_ID,
    status: "sending",
  });
  assertEquals(gate.kicks, 1);
  assertEquals(gate.starts, [BROADCAST_ID]);
});

Deno.test("a broadcast that is not pending answers 400 as before", async () => {
  const gate = deps({
    loadBroadcast: async () => ({
      id: BROADCAST_ID,
      status: "sending",
      name: "Promo",
      template_name: "hello",
      template_components: null,
      sent_count: 0,
      failed_count: 0,
    }),
  });

  const response = await handleWhatsAppBroadcast(request(), gate);

  assertEquals(response.status, 400);
  assertEquals(await response.json(), { error: "Broadcast already sending" });
  assertEquals(gate.kicks, 0);
});

Deno.test("a missing broadcast answers 404", async () => {
  const gate = deps({ loadBroadcast: async () => null });

  const response = await handleWhatsAppBroadcast(request(), gate);

  assertEquals(response.status, 404);
  assertEquals(await response.json(), { error: "Broadcast not found" });
});

Deno.test("the loser of two starts answers 409 and never kicks", async () => {
  const gate = deps({ startBroadcast: async () => null });

  const response = await handleWhatsAppBroadcast(request(), gate);

  assertEquals(response.status, 409);
  assertEquals(await response.json(), { error: "Broadcast already started" });
  assertEquals(gate.kicks, 0);
});

Deno.test("QR-only credentials keep their 400 code", async () => {
  const gate = deps({
    loadWhatsAppAccounts: async () => [
      { access_token: null, platform_user_id: null, account_metadata: { connection_mode: "evolution_qr" } },
    ],
  });

  const response = await handleWhatsAppBroadcast(request(), gate);

  assertEquals(response.status, 400);
  const body = await response.json() as { code: string };
  assertEquals(body.code, "BROADCAST_REQUIRES_CLOUD_API");
});

Deno.test("incomplete cloud credentials keep their 400 code", async () => {
  const gate = deps({
    loadWhatsAppAccounts: async () => [
      { access_token: "cloud-token", platform_user_id: null, account_metadata: {} },
    ],
  });

  const response = await handleWhatsAppBroadcast(request(), gate);

  assertEquals(response.status, 400);
  const body = await response.json() as { code: string };
  assertEquals(body.code, "BROADCAST_REQUIRES_CLOUD_API");
});

Deno.test("no connected whatsapp account keeps its 400 code", async () => {
  const gate = deps({ loadWhatsAppAccounts: async () => [] });

  const response = await handleWhatsAppBroadcast(request(), gate);

  assertEquals(response.status, 400);
  const body = await response.json() as { code: string };
  assertEquals(body.code, "NO_WHATSAPP_ACCOUNT");
});

Deno.test("no pending recipients answers 400", async () => {
  const gate = deps({ hasPendingRecipients: async () => false });

  const response = await handleWhatsAppBroadcast(request(), gate);

  assertEquals(response.status, 400);
  assertEquals(await response.json(), { error: "No pending recipients" });
  assertEquals(gate.kicks, 0);
});

Deno.test("a recipient read error records its refusal before answering 500", async () => {
  const gate = deps({ hasPendingRecipients: async () => null });

  const response = await handleWhatsAppBroadcast(request(), gate);

  assertEquals(response.status, 500);
  assertEquals(gate.refusals, [{ userId: USER, broadcastId: BROADCAST_ID }]);
  assertEquals(gate.starts, []);
  assertEquals(await response.json(), { error: "Could not read recipients" });
  assertEquals(gate.kicks, 0);
});

Deno.test("a non-uuid broadcast_id answers 400", async () => {
  const gate = deps();

  const response = await handleWhatsAppBroadcast(request({ broadcast_id: "b1" }), gate);

  assertEquals(response.status, 400);
  assertEquals(await response.json(), { error: "broadcast_id required" });
  assertEquals(gate.kicks, 0);
});

Deno.test("a missing broadcast_id answers 400", async () => {
  const gate = deps();

  const response = await handleWhatsAppBroadcast(request({}), gate);

  assertEquals(response.status, 400);
  assertEquals(await response.json(), { error: "broadcast_id required" });
});

Deno.test("a kick that throws still answers 202", async () => {
  const gate = deps({
    kickWorker: async () => {
      throw new Error("kick failed");
    },
  });

  const response = await handleWhatsAppBroadcast(request(), gate);

  assertEquals(response.status, 202);
  assertEquals((await response.json() as { accepted: boolean }).accepted, true);
});

Deno.test("an unauthenticated request answers 401", async () => {
  const gate = deps({
    authenticate: async () => ({ response: new Response("{}", { status: 401 }) }),
  });

  const response = await handleWhatsAppBroadcast(request(), gate);

  assertEquals(response.status, 401);
  assertEquals(gate.kicks, 0);
});

Deno.test("a refusal log write failure still refuses dispatch", async () => {
  const gate = deps({
    hasPendingRecipients: async () => null,
    logRecipientReadFailure: async () => { throw new Error("audit unavailable"); },
  });
  const response = await handleWhatsAppBroadcast(request(), gate);
  assertEquals(response.status, 500);
  assertEquals(gate.starts, []);
  assertEquals(gate.kicks, 0);
});
