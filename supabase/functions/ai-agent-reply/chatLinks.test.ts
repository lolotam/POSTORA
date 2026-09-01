import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { flattenChatLinks } from "./chatLinks.ts";

Deno.test("the exact reply that reached a customer is repaired", () => {
  // Verbatim from ai_agent_logs, 2026-08-31 20:19 UTC.
  const sent = "تفضل، تقدر تزور موقعنا الرئيسي XsellPoint: " +
    "[https://xsellpoint.com/](https://xsellpoint.com/)";
  assertEquals(
    flattenChatLinks(sent),
    "تفضل، تقدر تزور موقعنا الرئيسي XsellPoint: https://xsellpoint.com/",
  );
});

Deno.test("a labelled link keeps its label, on the line above the URL", () => {
  assertEquals(
    flattenChatLinks("See [our best sellers](https://xsellpoint.com/best/)"),
    "See our best sellers\nhttps://xsellpoint.com/best/",
  );
});

Deno.test("two links in one message stay two separate addresses", () => {
  // The reported symptom was "two links connected together".
  const flattened = flattenChatLinks(
    "[https://a.example/](https://a.example/) and [https://b.example/](https://b.example/)",
  );
  assertEquals(flattened, "https://a.example/ and https://b.example/");
  assertEquals(flattened.includes("]("), false);
});

Deno.test("a trailing-slash-only difference is not treated as a label", () => {
  assertEquals(
    flattenChatLinks("[https://xsellpoint.com](https://xsellpoint.com/)"),
    "https://xsellpoint.com/",
  );
});

Deno.test("angle brackets around the target are stripped", () => {
  assertEquals(flattenChatLinks("[shop](<https://a.example/>)"), "shop\nhttps://a.example/");
});

Deno.test("a reply with no markdown link is returned byte-identical", () => {
  // This runs on every reply; it must not rewrite text it has no reason to touch.
  for (
    const untouched of [
      "أغلى العطور من ماركة Strange Love، وسعرها 243 دينار.",
      "Visit https://xsellpoint.com/ for more.",
      "Prices [subject to change] and stock (limited).",
      "",
    ]
  ) {
    assertEquals(flattenChatLinks(untouched), untouched);
  }
});

Deno.test("a nested bracket cannot swallow the rest of the message", () => {
  const flattened = flattenChatLinks("[a [b] c](https://x.example/) tail");
  assertEquals(flattened.endsWith("tail"), true);
  assertEquals(flattened.includes("https://x.example/"), true);
});

import { flattenChatMarkdown, repairChatReply } from "./chatLinks.ts";

/**
 * 2026-09-01 11:10 UTC: a price answer went to a WhatsApp customer as a
 * markdown table with **bold** cells, despite two prompt rules against it.
 * The customer sees raw pipes and asterisks. This is the deterministic layer.
 */
Deno.test("the price table that reached a customer becomes plain lines", () => {
  const sent = [
    "| الصنف | السعر |",
    "|-------|-------|",
    "| **كتاكيت بلدي** | ١٠ جنيه |",
    "| **كتاكيت جميزة** | ١٨ جنيه |",
  ].join("\n");

  assertEquals(
    flattenChatMarkdown(sent),
    "*كتاكيت بلدي*: ١٠ جنيه\n*كتاكيت جميزة*: ١٨ جنيه",
  );
});

Deno.test("double-asterisk bold becomes WhatsApp's single-asterisk bold", () => {
  assertEquals(
    flattenChatMarkdown("**أسعار اليوم** محدثة، و__التوصيل__ متاح"),
    "*أسعار اليوم* محدثة، و*التوصيل* متاح",
  );
});

Deno.test("a heading becomes an emphasised line", () => {
  assertEquals(flattenChatMarkdown("### الأسعار\nكتكوت: ١٨"), "*الأسعار*\nكتكوت: ١٨");
});

Deno.test("plain text and WhatsApp's own formatting come back byte-identical", () => {
  for (
    const untouched of [
      "أسعار اليوم: جميزة ١٨ جنيه\nساسو ٢٠ جنيه",
      "*عرض خاص* على _الكتاكيت_ اليوم",
      "السعر 10 | التوصيل مجاني", // a lone pipe mid-sentence is not a table
      "2 ** 3 يعني أس",
      "",
    ]
  ) {
    assertEquals(flattenChatMarkdown(untouched), untouched);
  }
});

Deno.test("repairChatReply fixes links and tables in one pass", () => {
  const sent = "| المتجر | الرابط |\n|---|---|\n| متجرنا | [https://x.co/](https://x.co/) |";
  const repaired = repairChatReply(sent);
  assertEquals(repaired.includes("|"), false);
  assertEquals(repaired.includes("]("), false);
  assertEquals(repaired.includes("https://x.co/"), true);
});
