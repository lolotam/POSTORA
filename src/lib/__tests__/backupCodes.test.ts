import { describe, expect, it } from "vitest";
import {
  hashBackupCode,
  isValidBackupCode,
  normalizeBackupCode,
} from "../../../supabase/functions/_shared/backup-codes";

describe("backup code helpers", () => {
  it("normalizes case and removes display separators", () => {
    expect(normalizeBackupCode(" abcd-2345 ")).toBe("ABCD2345");
  });

  it("accepts a normalized code from the UI character set", () => {
    expect(isValidBackupCode("ABCD-2345")).toBe(true);
  });

  it.each(["ABCI2345", "ABCO2345", "ABCD1234", "ABC2345"])(
    "rejects a code outside the UI format: %s",
    (code) => {
      expect(isValidBackupCode(code)).toBe(false);
    },
  );

  it("normalizes equivalent codes before hashing", async () => {
    const first = await hashBackupCode("ABCD-2345", "test-pepper");
    const same = await hashBackupCode("abcd2345", "test-pepper");

    expect(same).toBe(first);
  });

  it("changes the hash when the pepper changes", async () => {
    const first = await hashBackupCode("ABCD2345", "test-pepper");
    const differentPepper = await hashBackupCode("ABCD2345", "other-pepper");

    expect(differentPepper).not.toBe(first);
  });

  it("returns an opaque SHA-256 hex digest", async () => {
    const first = await hashBackupCode("ABCD2345", "test-pepper");

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain("ABCD2345");
  });
});
