import { describe, it, expect } from "vitest";
import { validateQuotaFieldInput, QUOTA_FIELD_ERROR_MESSAGE } from "../quotaValidation";

// R4 (CodeRabbit round 2, 2026-08-23): the quota columns are Postgres
// `integer` (max 2147483647), but validateQuotaFieldInput() previously only
// rejected values below -1 - a value ABOVE the column's max slipped through
// validation here and would fail (or silently overflow, depending on
// driver/coercion behaviour) only when it hit the database, far from where
// the admin typed it. Reject anything above INT32_MAX with the same visible
// error message used for every other invalid quota input.
const INT32_MAX = 2147483647;

describe("validateQuotaFieldInput - PostgreSQL integer upper bound (R4)", () => {
  it("accepts the exact PostgreSQL integer max with no error", () => {
    expect(validateQuotaFieldInput(String(INT32_MAX))).toEqual({
      value: INT32_MAX,
      error: null,
    });
  });

  it("rejects one above the PostgreSQL integer max", () => {
    const result = validateQuotaFieldInput(String(INT32_MAX + 1));
    expect(result.value).toBeNull();
    expect(result.error).toBe(QUOTA_FIELD_ERROR_MESSAGE);
  });

  it("rejects a value far above the PostgreSQL integer max", () => {
    const result = validateQuotaFieldInput("9999999999");
    expect(result.value).toBeNull();
    expect(result.error).not.toBeNull();
  });

  it("still accepts -1 as the unlimited sentinel", () => {
    expect(validateQuotaFieldInput("-1")).toEqual({ value: -1, error: null });
  });

  it("still accepts an ordinary in-range value", () => {
    expect(validateQuotaFieldInput("500")).toEqual({ value: 500, error: null });
  });
});
