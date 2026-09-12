import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  BUSINESS_INDUSTRIES,
  BusinessProfileError,
  parseBusinessProfile,
  POLICY_KEYS,
  policyKeysForIndustry,
  renderBusinessProfileText,
} from "./businessProfileText.ts";

Deno.test("an empty profile renders to the empty string", () => {
  assertEquals(renderBusinessProfileText({}), "");
});

Deno.test("blank-only fields still render to the empty string", () => {
  // This is what makes confirm_clear fire. A profile the user emptied field by
  // field has to look exactly like a cleared textarea to blankedFields, or the
  // 2026-08-30 blanking guard stops protecting the column it was written for.
  assertEquals(renderBusinessProfileText({ products: "   ", notes: "\n" }), "");
});

Deno.test("sections are labelled and separated by blank lines", () => {
  const text = renderBusinessProfileText({
    industry: "ecommerce",
    products: "Running shoes, trainers",
    policies: { returns: "14 days", shipping: "Free over 20 KWD" },
    faqs: [{ q: "Do you ship abroad?", a: "Yes, GCC only." }],
    notes: "Family business since 1998",
  });
  assertEquals(text.split("\n\n"), [
    "Business type: E-commerce store",
    "Products and services:\nRunning shoes, trainers",
    "Returns policy:\n14 days",
    "Shipping policy:\nFree over 20 KWD",
    "FAQ: Do you ship abroad?\nYes, GCC only.",
    "Additional notes:\nFamily business since 1998",
  ]);
});

Deno.test("each FAQ is its own paragraph so chunkProfileText can split on them", () => {
  // chunkProfileText splits on blank lines. One FAQ per paragraph means a
  // retrieval hit returns that answer, not a window across three unrelated ones.
  assertEquals(
    renderBusinessProfileText({ faqs: [{ q: "A?", a: "1" }, { q: "B?", a: "2" }] }),
    "FAQ: A?\n1\n\nFAQ: B?\n2",
  );
});

Deno.test("a FAQ missing either half is dropped rather than rendered half-empty", () => {
  assertEquals(renderBusinessProfileText({ faqs: [{ q: "A?", a: "  " }] }), "");
});

Deno.test("parse rejects an unknown key by name", () => {
  const error = assertThrows(
    () => parseBusinessProfile({ industry: "clinic", sneaky: 1 }),
    BusinessProfileError,
  );
  assertEquals(error.message, "Unknown business_profile key: sneaky");
});

Deno.test("parse rejects an industry outside the enum", () => {
  assertThrows(() => parseBusinessProfile({ industry: "bakery" }), BusinessProfileError);
});

Deno.test("parse rejects an unknown policies key", () => {
  assertThrows(
    () => parseBusinessProfile({ policies: { refunds: "x" } }),
    BusinessProfileError,
  );
});

Deno.test("parse rejects a FAQ entry missing an answer", () => {
  assertThrows(() => parseBusinessProfile({ faqs: [{ q: "A?" }] }), BusinessProfileError);
});

Deno.test("parse rejects more than fifty FAQs", () => {
  const faqs = Array.from({ length: 51 }, (_, index) => ({ q: `q${index}`, a: "a" }));
  assertThrows(() => parseBusinessProfile({ faqs }), BusinessProfileError);
});

Deno.test("parse rejects a non-object", () => {
  assertThrows(() => parseBusinessProfile("shoes"), BusinessProfileError);
  assertThrows(() => parseBusinessProfile([{ products: "x" }]), BusinessProfileError);
});

Deno.test("parse accepts an empty object, null and undefined", () => {
  assertEquals(parseBusinessProfile({}), {});
  assertEquals(parseBusinessProfile(null), {});
  assertEquals(parseBusinessProfile(undefined), {});
});

Deno.test("parse round-trips a full profile unchanged", () => {
  const input = {
    industry: "clinic" as const,
    products: "Dermatology consultations",
    policies: { returns: "No refunds", shipping: "N/A", warranty: "None" },
    faqs: [{ q: "Do you take walk-ins?", a: "Mornings only." }],
    notes: "Two branches",
  };
  assertEquals(parseBusinessProfile(input), input);
});

Deno.test("only the selected business type's fields are rendered; the rest are kept by parse", () => {
  // A clinic that filled in a shipping policy while it was still set to
  // e-commerce must not index it: the agent would quote a policy the form no
  // longer shows. The value survives parse, so switching back restores it.
  const stored = {
    industry: "clinic" as const,
    policies: { shipping: "Free over 20 KWD", booking: "WhatsApp, 24h ahead" },
  };
  assertEquals(parseBusinessProfile(stored), stored);
  assertEquals(
    renderBusinessProfileText(parseBusinessProfile(stored)).split("\n\n"),
    ["Business type: Clinic or medical practice", "Booking and appointments:\nWhatsApp, 24h ahead"],
  );
});

Deno.test("no business type, or 'other', renders every filled field in the fixed order", () => {
  const policies = { leasing: "1 year minimum", returns: "14 days" };
  assertEquals(
    renderBusinessProfileText({ policies }),
    "Returns policy:\n14 days\n\nViewing and leasing terms:\n1 year minimum",
  );
  assertEquals(
    renderBusinessProfileText({ industry: "other", policies }).split("\n\n").length,
    3,
  );
});

Deno.test("every industry maps only to known fields and keeps the fixed render order", () => {
  for (const industry of BUSINESS_INDUSTRIES) {
    const keys = policyKeysForIndustry(industry);
    assertEquals(keys.length > 0, true, industry);
    assertEquals(keys, POLICY_KEYS.filter((key) => keys.includes(key)), industry);
  }
});

Deno.test("parse accepts every policy key regardless of industry", () => {
  const policies = Object.fromEntries(POLICY_KEYS.map((key) => [key, "x"])) as Record<string, string>;
  assertEquals(parseBusinessProfile({ industry: "hotel", policies }).policies, policies);
});
