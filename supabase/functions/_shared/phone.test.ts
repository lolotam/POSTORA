import { assertEquals } from "jsr:@std/assert@1";
import { parseCustomerPhone, whatsappConversationId } from "./phone.ts";

for (const [raw, country, expected] of [
  ["+965 5551 2345", null, "96555512345"],
  ["96555512345", "KW", "96555512345"],
  ["55512345", "KW", "96555512345"],
  ["0555123456", "SA", "966555123456"],
  ["5551234", "KW", null],
  ["55512345", null, null],
  ["1234567890123456", "US", null],
  ["+1 202 555 1234", null, "12025551234"],
  ["0096555512345", "KW", "96555512345"],
  ["07911123456", "GB", "447911123456"],
  ["(555) 123-4", "KW", null],
  ["5551.2345", "kw", "96555512345"],
  ["+20 10 1234 5678", "EG", "201012345678"],
  ["0501234567", "AE", "971501234567"],
  ["", "KW", null],
  ["++96555512345", "KW", null],
] as const) {
  Deno.test(`parseCustomerPhone ${JSON.stringify(raw)} ${country ?? "no country"}`, () => {
    assertEquals(parseCustomerPhone(raw, country), expected);
  });
}

Deno.test("whatsappConversationId keys Cloud and coexistence by phone number id, QR by platform user id", () => {
  const phone = "96555512345";
  assertEquals(
    whatsappConversationId({ mode: "cloud_api", phoneNumberId: "pn-1", platformUserId: "user-1" }, phone),
    "wa_pn-1_96555512345",
  );
  assertEquals(
    whatsappConversationId({ mode: "coexistence", phoneNumberId: "pn-2", platformUserId: "user-1" }, phone),
    "wa_pn-2_96555512345",
  );
  assertEquals(
    whatsappConversationId({ mode: "evolution_qr", phoneNumberId: "pn-1", platformUserId: "user-9" }, phone),
    "wa_user-9_96555512345",
  );
});
