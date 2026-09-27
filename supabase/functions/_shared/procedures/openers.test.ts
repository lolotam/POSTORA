import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { OPENER_BODIES, openerLanguage, openerText, openerValues } from "./openers.ts";

const payload = {
  first_name: "سارة",
  order_number: "1042",
  total: "12.500",
  currency: "KWD",
  product_name: "زيت الورد",
};

Deno.test("opener text fills the same placeholders the templates use", () => {
  const cod = openerText("cod_confirm", "ar", payload);
  assertStringIncludes(cod, "سارة");
  assertStringIncludes(cod, "1042");
  assertStringIncludes(cod, "12.500 KWD");
  assertEquals(cod.includes("{{"), false);
  assertEquals(openerText("review_request", "en", payload), OPENER_BODIES.review_request.en.replace("{{1}}", "سارة").replace("{{2}}", "1042"));
  assertStringIncludes(openerText("back_in_stock", "en", payload), "زيت الورد");
  assertEquals(openerValues("cod_confirm", "en", {}).length, 3);
  assertEquals(openerLanguage("en"), "en");
  assertEquals(openerLanguage("auto"), "ar");
});
