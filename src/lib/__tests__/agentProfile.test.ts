import { describe, expect, it } from "vitest";
import { renderBusinessProfileText } from "@/lib/agentProfile";

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
