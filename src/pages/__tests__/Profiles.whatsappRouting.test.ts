import { describe, expect, it } from "vitest";
import { routeAccountRemoval } from "@/pages/profilesRemoval";

describe("routeAccountRemoval", () => {
  it("routes whatsapp account removal to whatsapp-dialog", () => {
    expect(routeAccountRemoval("whatsapp")).toBe("whatsapp-dialog");
  });

  it("routes non-whatsapp account removal to direct", () => {
    expect(routeAccountRemoval("facebook")).toBe("direct");
  });
});
