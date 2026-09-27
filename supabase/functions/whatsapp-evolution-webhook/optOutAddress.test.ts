import { assertEquals } from "jsr:@std/assert@1";
import { evolutionOptOutTarget } from "./optOutAddress.ts";

const ACCOUNT = { id: "acc-1", user_id: "user-1", platform_user_id: "96597950350" };

Deno.test("an @lid chat records the remoteJidAlt subscriber digits", () => {
  const target = evolutionOptOutTarget(ACCOUNT, {
    key: {
      id: "3EB088496DD5BCE31F6874",
      fromMe: false,
      remoteJid: "166095025660123@lid",
      remoteJidAlt: "96555683677@s.whatsapp.net",
    },
    messageType: "conversation",
    message: { conversation: "stop" },
    messageTimestamp: 1787268633,
  });
  assertEquals(target, {
    phone: "96555683677",
    conversationId: "wa_96597950350_96555683677",
  });
});
