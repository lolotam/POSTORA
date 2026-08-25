import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { EvolutionApi } from "./evolutionApi.ts";
import {
  CloudApiTransport,
  createEvolutionTransport,
  supportsMessageRevoke,
} from "./whatsappTransport.ts";

Deno.test("Evolution transport sends text and media through its server-resolved instance", async () => {
  const calls: string[] = [];
  const api = {
    sendText: async (instance: string) => {
      calls.push(`text:${instance}`);
      return { messageId: "text-id", raw: {} };
    },
    sendMedia: async (instance: string) => {
      calls.push(`media:${instance}`);
      return { messageId: "media-id", raw: {} };
    },
  } as unknown as EvolutionApi;
  const transport = createEvolutionTransport(api, "postora_instance");

  assertEquals(await transport.sendText({ recipientPhone: "recipient", text: "hello" }), { messageId: "text-id", raw: {} });
  assertEquals(await transport.sendMedia({ recipientPhone: "recipient", mediaUrl: "https://cdn.example/file", mediaType: "image" }), { messageId: "media-id", raw: {} });
  assertEquals(calls, ["text:postora_instance", "media:postora_instance"]);
});

Deno.test("revoke is a capability on EvolutionTransport only — CloudApiTransport has no stub", async () => {
  const calls: string[] = [];
  const api = {
    deleteMessageForEveryone: async (instance: string, key: { id: string }) => {
      calls.push(`revoke:${instance}:${key.id}`);
    },
  } as unknown as EvolutionApi;
  const evolution = createEvolutionTransport(api, "postora_instance");
  const cloud = new CloudApiTransport({
    id: "acc",
    platform_user_id: "1555",
    access_token: "tok",
    connection_mode: "cloud_api",
  });

  assertEquals(supportsMessageRevoke(evolution), true);
  assertEquals(supportsMessageRevoke(cloud), false);
  assertEquals("revokeMessage" in cloud, false);
  if (supportsMessageRevoke(evolution)) {
    await evolution.revokeMessage({ id: "3EB0", remoteJid: "1999@s.whatsapp.net", fromMe: true });
  }
  assertEquals(calls, ["revoke:postora_instance:3EB0"]);
});
