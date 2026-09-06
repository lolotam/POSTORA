import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { mergeDraft, parseDraft } from "./draft.ts";

const url = "https://example.com/products";
const coverage = { mode: "page" as const, pages: 1, truncated: false };
const draft = () =>
  parseDraft(
    {
      business_profile: { products: "Handmade mugs" },
      agent_behavior: { tone: "friendly_professional" },
      evidence: { "business_profile.products": [url] },
    },
    [url],
    coverage,
  );

Deno.test("extraction keeps unknown policies absent and requires real attribution for every fact", () => {
  assertEquals(draft().business_profile, { products: "Handmade mugs" });
  for (
    const input of [
      { business_profile: { products: "Mugs" }, evidence: {} },
      {
        business_profile: { products: "Mugs" },
        evidence: { "business_profile.products": ["https://fake.example/"] },
      },
      {
        business_profile: { policies: { shipping: "" } },
        evidence: { "business_profile.policies.shipping": [url] },
      },
      {
        business_profile: { faqs: [{ q: "Return policy?", a: "" }] },
        evidence: { "business_profile.faqs": [url] },
      },
    ]
  ) assertThrows(() => parseDraft(input, [url], coverage));
});

Deno.test("malformed and permission-shaped model output is rejected", () => {
  for (
    const input of [
      {
        business_profile: {},
        agent_behavior: { is_enabled: true },
        evidence: {},
      },
      { business_profile: { admin_phone_numbers: ["123"] }, evidence: {} },
      { business_profile: {}, is_enabled: true, evidence: {} },
      {
        business_profile: { industry: "__proto__" },
        evidence: { "business_profile.industry": [url] },
      },
      {
        business_profile: {},
        agent_behavior: { tone: "aggressive" },
        evidence: {},
      },
      {
        business_profile: { products: "x".repeat(17000) },
        evidence: { "business_profile.products": [url] },
      },
    ]
  ) assertThrows(() => parseDraft(input, [url], coverage));
});

Deno.test("selected merge preserves unrelated nested policies, behavior, and legacy prose", () => {
  const current = {
    business_profile: {},
    business_profile_text: "A private customer note",
    agent_behavior: { greeting: "Hello" },
  };
  const merged = mergeDraft(current, draft(), ["business_profile.products"]);
  assertEquals(merged.business_profile, {
    notes: "A private customer note",
    products: "Handmade mugs",
  });
  assertEquals(merged.agent_behavior, { greeting: "Hello" });
  assertEquals(current.business_profile, {});
  const policies = parseDraft(
    {
      business_profile: { policies: { shipping: "Next day" } },
      evidence: {
        "business_profile.policies.shipping": [url],
      },
    },
    [url],
    coverage,
  );
  const result = mergeDraft(
    {
      business_profile: { policies: { returns: "14 days" } },
      business_profile_text: "Returns policy:\n14 days",
    },
    policies,
    ["business_profile.policies.shipping"],
  );
  assertEquals(result.business_profile.policies, {
    returns: "14 days",
    shipping: "Next day",
  });
});

Deno.test("empty authoritative legacy text cannot resurrect stale structured profile", () => {
  const merged = mergeDraft(
    {
      business_profile: { products: "Deleted product" },
      business_profile_text: "",
    },
    draft(),
    ["agent_behavior.tone"],
  );
  assertEquals(merged.business_profile, { notes: "" });
  assertEquals(merged.business_profile_text, "");
});

Deno.test("selected merge refuses protected paths, absent fields and empty selections", () => {
  for (
    const fields of [
      ["is_enabled"],
      ["business_profile.policies"],
      ["business_profile.notes"],
      [],
      ["__proto__.polluted"],
    ]
  ) {
    assertThrows(() => mergeDraft(null, draft(), fields));
  }
});
