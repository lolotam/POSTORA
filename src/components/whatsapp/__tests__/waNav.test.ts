import { describe, expect, it } from "vitest";
import {
  whatsappAutomationTabs,
  whatsappNavItems,
  whatsappSectionRoute,
  WHATSAPP_BASE_PATH,
} from "../waNav";

// The path slugs are a URL contract: they must match the child routes registered in
// AnimatedRoutes.tsx and the legacy /messaging/whatsapp?tab=<slug> deep links.
describe("whatsappNavItems", () => {
  it("keeps the route slugs that external deep links and legacy ?tab= URLs depend on", () => {
    expect(whatsappNavItems.map((item) => item.path)).toEqual([
      "",
      "pipelines",
      "conversations",
      "contacts",
      "templates",
      "analytics",
      "automation",
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

describe("whatsappAutomationTabs", () => {
  it("groups the automation sub-sections, keeping their original route slugs", () => {
    const relativeTabs = whatsappAutomationTabs.filter((tab) => !tab.absolute);
    expect(relativeTabs.map((tab) => tab.path)).toEqual([
      "ai-agent",
      "quick-replies",
      "auto-replies",
      "agents",
      "broadcasts",
    ]);
  });

  it("links Human Agent to the Ad Manager page, not a duplicate of Agents", () => {
    const humanAgent = whatsappAutomationTabs.find((tab) => tab.label === "Human Agent");
    expect(humanAgent?.absolute).toBe(true);
    expect(humanAgent?.path).toBe("/human-agent");
  });
});
