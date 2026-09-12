import { describe, expect, it } from "vitest";
import { draftFields, websiteIndexingMessage } from "@/lib/websiteSetup";

describe("website import feedback", () => {
  it("does not announce indexing completion for an accepted queued page", () => {
    expect(websiteIndexingMessage({ queued: true })).toMatch(/queued/i);
    expect(websiteIndexingMessage({ queued: true })).not.toMatch(/page indexed/i);
  });
  it("announces completion only for a completed response", () => {
    expect(websiteIndexingMessage({ chunk_count: 31 })).toBe("Page indexed");
    expect(websiteIndexingMessage({})).not.toBe("Page indexed");
  });
});

describe("website draft review", () => {
  it("preserves existing business and behavior values by default", () => {
    const fields = draftFields({
      business_profile: { products: "New shoes", policies: { returns: "14 days" } },
      agent_behavior: { tone: "formal" }, evidence: {},
      coverage: { mode: "page", pages: 1, truncated: false },
    }, { products: "Existing shoes" }, { tone: "concise" });
    expect(fields.find((field) => field.path === "business_profile.products")?.selected).toBe(false);
    expect(fields.find((field) => field.path === "agent_behavior.tone")?.selected).toBe(false);
    expect(fields.find((field) => field.path === "business_profile.policies.returns")?.selected).toBe(true);
  });
  it("does not select missing or unchanged values", () => {
    const fields = draftFields({
      business_profile: { products: "Shoes" }, agent_behavior: {}, evidence: {},
      coverage: { mode: "page", pages: 1, truncated: false },
    }, { products: "Shoes" }, {});
    expect(fields.some((field) => field.selected)).toBe(false);
    expect(fields.find((field) => field.path === "business_profile.policies.warranty")?.proposed).toBe("");
  });
  it("does not offer a sourced policy the effective business type hides", () => {
    // Codex P2 on PR #175: a restaurant draft citing a cancellation policy was
    // auto-selected, stored, and then left out of the indexed text.
    const fields = draftFields({
      business_profile: { industry: "restaurant", policies: { cancellation: "24h notice", menu: "Halal" } },
      agent_behavior: {}, evidence: {},
      coverage: { mode: "page", pages: 1, truncated: false },
    }, { industry: "ecommerce" }, {});
    expect(fields.some((field) => field.path === "business_profile.policies.cancellation")).toBe(false);
    expect(fields.find((field) => field.path === "business_profile.policies.menu")?.selected).toBe(true);
  });
});
