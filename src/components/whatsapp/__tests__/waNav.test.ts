import { describe, expect, it } from "vitest";
import { whatsappNavItems, whatsappSectionRoute, WHATSAPP_BASE_PATH } from "../waNav";

// The path slugs are a URL contract: they must match the child routes registered in
// AnimatedRoutes.tsx and the legacy /messaging/whatsapp?tab=<slug> deep links.
describe("whatsappNavItems", () => {
  it("keeps the route slugs that external deep links and legacy ?tab= URLs depend on", () => {
    expect(whatsappNavItems.map((item) => item.path)).toEqual([
      "",
      "conversations",
      "contacts",
      "templates",
      "analytics",
      "quick-replies",
      "auto-replies",
      "broadcasts",
      "agents",
      "profile",
      "webhooks",
      "scheduled",
      "response-stats",
      "catalog",
      "setup",
      "docs",
    ]);
  });

  it("marks only the dashboard index route with end so it doesn't stay active on child routes", () => {
    const endItems = whatsappNavItems.filter((item) => item.end);
    expect(endItems.map((item) => item.path)).toEqual([""]);
  });

  it("builds absolute section routes under the mini-app base path", () => {
    expect(whatsappSectionRoute("")).toBe(WHATSAPP_BASE_PATH);
    expect(whatsappSectionRoute("broadcasts")).toBe(`${WHATSAPP_BASE_PATH}/broadcasts`);
  });
});
