import { describe, it, expect } from "vitest";
import { CONNECTOR_CATEGORY_LABELS, CONNECTOR_TYPES, type ConnectorType } from "@/lib/connectorRegistry";
import { CATEGORY_TABS, typesInCategory } from "../connectorCategories";

describe("connector category tabs", () => {
  it("offers the four registry categories in the spec's order with their registry labels", () => {
    expect(CATEGORY_TABS.map((tab) => tab.key)).toEqual([
      "ecommerce_payments",
      "productivity_crm",
      "databases",
      "automation",
    ]);
    for (const tab of CATEGORY_TABS) {
      expect(tab.label).toBe(CONNECTOR_CATEGORY_LABELS[tab.key]);
    }
  });

  it("places every registry connector type in exactly one category", () => {
    const placed: ConnectorType[] = CATEGORY_TABS.flatMap((tab) => typesInCategory(tab.key));
    expect([...placed].sort()).toEqual([...CONNECTOR_TYPES].sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  it("returns the types the registry assigns to a category", () => {
    expect(typesInCategory("productivity_crm")).toContain("google_sheets");
    expect(typesInCategory("productivity_crm")).not.toContain("shopify");
  });
});
