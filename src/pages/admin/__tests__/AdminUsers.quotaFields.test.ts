import { describe, it, expect } from "vitest";
import { formatQuotaValue, parseQuotaFieldInput } from "../AdminUsers";

// C2 (2026-08-23 final review): NULL must round-trip as "inherit", never as
// a number. Before this fix, every display fallback (`?? 4`, `?? 30`, ...)
// and every save handler (`|| 1`, `|| 4`, ...) silently substituted a
// hardcoded number for NULL, so an admin who opened Edit Quota on a Pro user
// and clicked Save without changing anything would permanently pin that
// paying customer near the free tier.

describe("formatQuotaValue", () => {
  it("renders NULL as inherit, not a number", () => {
    expect(formatQuotaValue(null)).toBe("inherit");
  });

  it("renders undefined as inherit, not a number", () => {
    expect(formatQuotaValue(undefined)).toBe("inherit");
  });

  it("renders -1 as unlimited", () => {
    expect(formatQuotaValue(-1)).toBe("∞");
  });

  it("renders an ordinary override as its own number, not a hardcoded default", () => {
    expect(formatQuotaValue(7)).toBe("7");
  });

  it("renders 0 as a real value, not inherit", () => {
    expect(formatQuotaValue(0)).toBe("0");
  });
});

describe("parseQuotaFieldInput", () => {
  it("parses an empty field as inherit (null), never a hardcoded number", () => {
    expect(parseQuotaFieldInput("")).toBeNull();
  });

  it("parses a whitespace-only field as inherit (null)", () => {
    expect(parseQuotaFieldInput("   ")).toBeNull();
  });

  it("parses a typed number", () => {
    expect(parseQuotaFieldInput("15")).toBe(15);
  });

  it("parses -1 for unlimited", () => {
    expect(parseQuotaFieldInput("-1")).toBe(-1);
  });

  it("parses a typed 0 as a real zero, not inherit", () => {
    expect(parseQuotaFieldInput("0")).toBe(0);
  });

  it("parses an unparseable field as inherit (null), never NaN", () => {
    expect(parseQuotaFieldInput("abc")).toBeNull();
  });
});
