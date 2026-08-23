import { describe, it, expect } from "vitest";
import { formatQuotaValue, parseQuotaFieldInput, validateQuotaFieldInput } from "../AdminUsers";

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

// F8 (CodeRabbit round 1, 2026-08-23): parseQuotaFieldInput() used
// Number.parseInt(), which silently coerces fractional/malformed strings:
// parseInt("-1.5", 10) === -1 (the unlimited sentinel — an admin typing a
// decimal by mistake could accidentally grant unlimited), and
// parseInt("0.5", 10) === 0 (a real, enforced zero — not what was typed).
// validateQuotaFieldInput() must keep empty as inherit (null, no error),
// but reject any non-integer or any value below -1 with a visible error
// message instead of silently coercing it.
describe("validateQuotaFieldInput", () => {
  it("accepts an empty field as inherit (null), with no error", () => {
    expect(validateQuotaFieldInput("")).toEqual({ value: null, error: null });
  });

  it("accepts a whitespace-only field as inherit (null), with no error", () => {
    expect(validateQuotaFieldInput("   ")).toEqual({ value: null, error: null });
  });

  it("accepts a typed whole number with no error", () => {
    expect(validateQuotaFieldInput("15")).toEqual({ value: 15, error: null });
  });

  it("accepts -1 (unlimited sentinel) with no error", () => {
    expect(validateQuotaFieldInput("-1")).toEqual({ value: -1, error: null });
  });

  it("accepts 0 as a real value with no error", () => {
    expect(validateQuotaFieldInput("0")).toEqual({ value: 0, error: null });
  });

  it("rejects a fractional value that would silently coerce to the -1 unlimited sentinel", () => {
    const result = validateQuotaFieldInput("-1.5");
    expect(result.value).toBeNull();
    expect(result.error).not.toBeNull();
  });

  it("rejects a fractional value that would silently coerce to a real zero", () => {
    const result = validateQuotaFieldInput("0.5");
    expect(result.value).toBeNull();
    expect(result.error).not.toBeNull();
  });

  it("rejects any value below -1 (not a valid unlimited/real quota)", () => {
    const result = validateQuotaFieldInput("-2");
    expect(result.value).toBeNull();
    expect(result.error).not.toBeNull();
  });

  it("rejects a non-numeric field with a visible error, not a silent null", () => {
    const result = validateQuotaFieldInput("abc");
    expect(result.value).toBeNull();
    expect(result.error).not.toBeNull();
  });
});
