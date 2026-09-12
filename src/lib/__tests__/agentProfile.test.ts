import { describe, expect, it } from "vitest";
import { INDUSTRY_OPTIONS, POLICY_KEYS, policyKeysForIndustry, renderBusinessProfileText } from "@/lib/agentProfile";

// These fixtures are copied VERBATIM from
// supabase/functions/_shared/businessProfileText.test.ts. That is the point:
// the client preview decides whether a save would blank a stored profile, and
// the server decides whether to refuse it. If the two renderers disagree about
// what "empty" means, the client omits confirm_clear, the server renders "" and
// returns 409 -- and the user can never clear their profile, however many times
// they retry.
describe("renderBusinessProfileText matches the server renderer", () => {
  it("renders an empty profile to the empty string", () => {
    expect(renderBusinessProfileText({})).toBe("");
  });

  it("renders blank-only fields to the empty string", () => {
    expect(renderBusinessProfileText({ products: "   ", notes: "\n" })).toBe("");
  });

  it("labels and separates each section", () => {
    const text = renderBusinessProfileText({
      industry: "ecommerce",
      products: "Running shoes, trainers",
      policies: { returns: "14 days", shipping: "Free over 20 KWD" },
      faqs: [{ q: "Do you ship abroad?", a: "Yes, GCC only." }],
      notes: "Family business since 1998",
    });
    expect(text.split("\n\n")).toEqual([
      "Business type: E-commerce store",
      "Products and services:\nRunning shoes, trainers",
      "Returns policy:\n14 days",
      "Shipping policy:\nFree over 20 KWD",
      "FAQ: Do you ship abroad?\nYes, GCC only.",
      "Additional notes:\nFamily business since 1998",
    ]);
  });

  it("gives each FAQ its own paragraph", () => {
    expect(
      renderBusinessProfileText({ faqs: [{ q: "A?", a: "1" }, { q: "B?", a: "2" }] }),
    ).toBe("FAQ: A?\n1\n\nFAQ: B?\n2");
  });

  it("drops a FAQ missing either half", () => {
    expect(renderBusinessProfileText({ faqs: [{ q: "A?", a: "  " }] })).toBe("");
  });
});

// Copied verbatim from the server suite, for the same reason as above: the
// client preview and the server must hide the same fields for the same type.
describe("business-type-aware fields match the server renderer", () => {
  it("renders only the selected business type's fields", () => {
    const text = renderBusinessProfileText({
      industry: "clinic",
      policies: { shipping: "Free over 20 KWD", booking: "WhatsApp, 24h ahead" },
    });
    expect(text.split("\n\n")).toEqual([
      "Business type: Clinic or medical practice",
      "Booking and appointments:\nWhatsApp, 24h ahead",
    ]);
  });

  it("renders every filled field when no type is chosen", () => {
    expect(renderBusinessProfileText({ policies: { leasing: "1 year minimum", returns: "14 days" } }))
      .toBe("Returns policy:\n14 days\n\nViewing and leasing terms:\n1 year minimum");
  });

  it("maps every industry to known fields in the fixed render order", () => {
    for (const { value } of INDUSTRY_OPTIONS) {
      const keys = policyKeysForIndustry(value);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys).toEqual(POLICY_KEYS.filter((key) => keys.includes(key)));
    }
  });
});
