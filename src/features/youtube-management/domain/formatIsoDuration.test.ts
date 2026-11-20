import { describe, expect, it } from "vitest";
import { formatIsoDuration } from "./formatIsoDuration";

describe("formatIsoDuration", () => {
  it("renders minutes and seconds", () => {
    expect(formatIsoDuration("PT4M13S")).toBe("4:13");
  });

  it("keeps zero-padded minutes under an hour", () => {
    expect(formatIsoDuration("PT2M5S")).toBe("2:05");
  });

  it("renders hours with padded minutes and seconds", () => {
    expect(formatIsoDuration("PT1H2M3S")).toBe("1:02:03");
  });

  it("folds days into hours", () => {
    expect(formatIsoDuration("P1DT1H1M1S")).toBe("25:01:01");
  });

  it("returns null for null or unparseable values", () => {
    expect(formatIsoDuration(null)).toBeNull();
    expect(formatIsoDuration("4 minutes")).toBeNull();
    expect(formatIsoDuration("PT")).toBeNull();
  });
});
