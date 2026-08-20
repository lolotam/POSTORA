import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { EvolutionApi } from "./evolutionApi.ts";
import { createEvolutionTransport } from "./whatsappTransport.ts";

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
