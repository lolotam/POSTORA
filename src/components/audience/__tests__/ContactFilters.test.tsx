import { describe, it, expect } from "vitest";

import { PLATFORM_OPTIONS as PLATFORMS } from "@/features/audience";

describe("ContactFilters platform options", () => {
  // social_contacts.platform accepts these four, and a platform with no option
  // here produces rows that can be read but never filtered to. YouTube ingest
  // landed mid-build and is already the largest source of captured contacts.
  it("offers every platform the contacts table can hold", () => {
    const values = PLATFORMS.map((p) => p.value);
    expect(values).toEqual(["all", "facebook", "instagram", "threads", "youtube"]);
  });

  it("labels each one for a reader rather than echoing the stored value", () => {
    expect(PLATFORMS.find((p) => p.value === "youtube")?.label).toBe("YouTube");
    expect(PLATFORMS.find((p) => p.value === "all")?.label).toBe("All platforms");
  });
});
