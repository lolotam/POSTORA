import { describe, it, expect } from "vitest";
import {
  ENDPOINT_LABELS,
  ENDPOINT_CATEGORY_ORDER,
  groupByEndpointCategory,
} from "../AdminRateLimits";

// The 14 endpoints seeded by supabase/migrations/20260823120000_unify_rate_limits.sql.
// Duplicated here on purpose: this test pins the migration contract, so a
// migration change that forgets the UI must fail right here.
const SEEDED_ENDPOINTS = [
  "/api/v1/messages/reply",
  "/api/v1/comments/reply",
  "/api/v1/comments/hide",
  "/api/v1/comments/delete",
  "/api/v1/post",
  "/api/v1/upload-media",
  "/api/v1/webhooks",
  "/api/v1/accounts",
  "/api/v1/posts",
  "/api/v1/media",
  "generate-caption",
  "generate-image",
  "generate-hashtags",
  "post-create",
];

const setting = (endpoint: string) => ({ endpoint });

describe("AdminRateLimits endpoint labels", () => {
  it("gives every endpoint seeded in the migration a label", () => {
    for (const endpoint of SEEDED_ENDPOINTS) {
      const label = ENDPOINT_LABELS[endpoint];
      expect(typeof label, `missing ENDPOINT_LABELS entry for ${endpoint}`).toBe("string");
      expect(label!.length, `empty label for ${endpoint}`).toBeGreaterThan(0);
    }
  });
});

describe("AdminRateLimits category bucketing", () => {
  it("puts every seeded endpoint in the right category and preserves category order", () => {
    const groups = groupByEndpointCategory(SEEDED_ENDPOINTS.map(setting));

    expect(groups.map((g) => g.category)).toEqual([
      "AI Generation",
      "Postora Web App",
      "n8n / REST API",
    ]);

    const byCategory = Object.fromEntries(groups.map((g) => [g.category, g.items.map((i) => i.endpoint)]));
    expect(byCategory["AI Generation"]).toEqual(["generate-caption", "generate-image", "generate-hashtags"]);
    expect(byCategory["Postora Web App"]).toEqual(["post-create"]);
    expect(byCategory["n8n / REST API"]).toEqual(SEEDED_ENDPOINTS.filter((e) => e.startsWith("/api/v1/")));
    // No "Other" group when everything is recognised.
    expect(groups.some((g) => g.category === "Other")).toBe(false);
    // The order constant matches the rendered grouping.
    expect(ENDPOINT_CATEGORY_ORDER).toEqual(["AI Generation", "Postora Web App", "n8n / REST API"]);
  });

  it("keeps items in their original relative order within a category", () => {
    const groups = groupByEndpointCategory([
      setting("/api/v1/post"),
      setting("generate-image"),
      setting("/api/v1/webhooks"),
      setting("generate-caption"),
    ]);
    expect(groups.map((g) => g.category)).toEqual(["AI Generation", "n8n / REST API"]);
    expect(groups[0].items.map((i) => i.endpoint)).toEqual(["generate-image", "generate-caption"]);
    expect(groups[1].items.map((i) => i.endpoint)).toEqual(["/api/v1/post", "/api/v1/webhooks"]);
  });

  it("lands an unrecognised endpoint in the trailing Other group", () => {
    const groups = groupByEndpointCategory([
      setting("generate-caption"),
      setting("/api/v1/some-future-endpoint"),
    ]);
    expect(groups.map((g) => g.category)).toEqual(["AI Generation", "Other"]);
    expect(groups[groups.length - 1].items.map((i) => i.endpoint)).toEqual(["/api/v1/some-future-endpoint"]);
  });
});
