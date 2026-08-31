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
