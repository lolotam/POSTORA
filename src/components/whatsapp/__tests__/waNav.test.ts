import { describe, expect, it } from "vitest";
import {
  whatsappLegacyTabTarget,
  whatsappNavItems,
  whatsappRetiredRoutes,
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
      "quick-replies",
      "broadcasts",
      "agents",
      "profile",
      "scheduled",
      "response-stats",
      "catalog",
      "setup",
      "docs",
    ]);
  });

  it("drops Webhooks from the nav without breaking its URL", () => {
    // Webhooks moved into Setup as a tab. The slug keeps working because AnimatedRoutes
    // redirects it to /setup?tab=webhooks, so existing links must not be treated as free to
    // repurpose even though nothing in the sidebar points at them any more.
    expect(whatsappNavItems.some((item) => item.path === "webhooks")).toBe(false);
    expect(whatsappSectionRoute("webhooks")).toBe(`${WHATSAPP_BASE_PATH}/webhooks`);
  });
});

describe("whatsappLegacyTabTarget", () => {
  it("still resolves ?tab= for a section that left the nav", () => {
    // Resolving against the visible nav alone is what broke this: removing Webhooks from the
    // sidebar silently stranded /messaging/whatsapp?tab=webhooks on the dashboard.
    expect(whatsappLegacyTabTarget("webhooks")).toBe(whatsappRetiredRoutes.webhooks);
  });

  it("resolves ?tab= for sections still in the nav", () => {
    expect(whatsappLegacyTabTarget("contacts")).toBe(`${WHATSAPP_BASE_PATH}/contacts`);
  });

  it("ignores an absent or unknown tab so the dashboard renders normally", () => {
    expect(whatsappLegacyTabTarget(null)).toBeNull();
    expect(whatsappLegacyTabTarget("")).toBeNull();
    expect(whatsappLegacyTabTarget("not-a-section")).toBeNull();
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "treats the inherited key %s as an unknown tab",
    (inheritedKey) => {
      // The value arrives from the query string, so a lookup that honoured the prototype chain
      // would hand a function to <Navigate to={...}> for ?tab=constructor.
      expect(whatsappLegacyTabTarget(inheritedKey)).toBeNull();
    },
  );

  it("points every retired route at a destination inside the section", () => {
    for (const target of Object.values(whatsappRetiredRoutes)) {
      expect(target.startsWith(`${WHATSAPP_BASE_PATH}/`)).toBe(true);
    }
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
