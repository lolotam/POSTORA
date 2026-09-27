import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { OPENER_BODIES, openerLanguage, openerText, openerValues } from "./openers.ts";

const payload = {
  first_name: "سارة",
  order_number: "1042",
  total: "12.500",
  currency: "KWD",
  product_name: "زيت الورد",
};

Deno.test("cod opener fills the name, order number, and total", () => {
  const cod = openerText("cod_confirm", "ar", payload);
  assertStringIncludes(cod, "سارة");
  assertStringIncludes(cod, "1042");
  assertStringIncludes(cod, "12.500 KWD");
  assertEquals(cod.includes("{{"), false);
});

Deno.test("review opener fills the english template", () => {
  assertEquals(
    openerText("review_request", "en", payload),
    OPENER_BODIES.review_request.en.replace("{{1}}", "سارة").replace("{{2}}", "1042"),
  );
});

Deno.test("back in stock opener names the product", () => {
  assertStringIncludes(openerText("back_in_stock", "en", payload), "زيت الورد");
});

Deno.test("cod values stay three long when the payload is empty", () => {
  assertEquals(openerValues("cod_confirm", "en", {}).length, 3);
});

Deno.test("opener language keeps en and maps auto to arabic", () => {
  assertEquals(openerLanguage("en"), "en");
  assertEquals(openerLanguage("auto"), "ar");
});
