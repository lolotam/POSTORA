import { describe, expect, it } from "vitest";

import {
  COMPETITOR_LABEL_MAX_LENGTH,
  displayInstagramHandle,
  isValidCompetitorLabel,
  isValidInstagramHandle,
  normalizeInstagramHandle,
  validateInstagramHandle,
} from "../domain/handle";

describe("competitor tracking handle rules", () => {
  describe("the normalisation", () => {
    it("mirrors the database: trim, drop the @, trim, lower-case", () => {
      expect(normalizeInstagramHandle("@Foo")).toBe("foo");
      expect(normalizeInstagramHandle("  @Foo  ")).toBe("foo");
      expect(normalizeInstagramHandle("@@Foo")).toBe("foo");
      expect(normalizeInstagramHandle("foo")).toBe("foo");
      expect(normalizeInstagramHandle("Foo.Bar")).toBe("foo.bar");
    });

    it("treats @Foo and foo as ONE identity", () => {
      expect(normalizeInstagramHandle("@Foo")).toBe(normalizeInstagramHandle("foo"));
    });
  });

  describe("the validation", () => {
    it("accepts the shapes the database accepts", () => {
      expect(isValidInstagramHandle("foo")).toBe(true);
      expect(isValidInstagramHandle("foo.bar_baz")).toBe(true);
      expect(isValidInstagramHandle("a".repeat(30))).toBe(true);
    });

    it("refuses an empty handle", () => {
      const result = validateInstagramHandle("   ");

      expect(result.outcome).toBe("invalid");
      if (result.outcome !== "invalid") return;
      expect(result.reason).toBe("empty");
    });

    it("refuses a handle the database would refuse", () => {
      for (const handle of ["a..b", "foo bar", "a".repeat(31), "foo-bar", "@@@"]) {
        expect(validateInstagramHandle(handle).outcome).toBe("invalid");
      }
    });

    it("names the reason of a refusal", () => {
      const result = validateInstagramHandle("a..b");

      expect(result.outcome).toBe("invalid");
      if (result.outcome !== "invalid") return;
      expect(result.reason).toBe("invalid");
    });
  });

  describe("the display form", () => {
    it("adds the @ for display only", () => {
      expect(displayInstagramHandle("foo")).toBe("@foo");
      expect(displayInstagramHandle("")).toBe("");
    });
  });

  describe("the label", () => {
    it("accepts a null label, because a null label preserves the stored one", () => {
      expect(isValidCompetitorLabel(null)).toBe(true);
      expect(isValidCompetitorLabel(undefined)).toBe(true);
    });

    it("accepts a label within the database's length", () => {
      expect(isValidCompetitorLabel("a".repeat(COMPETITOR_LABEL_MAX_LENGTH))).toBe(true);
    });

    it("refuses a label the database would refuse", () => {
      expect(isValidCompetitorLabel("a".repeat(COMPETITOR_LABEL_MAX_LENGTH + 1))).toBe(false);
    });
  });
});
