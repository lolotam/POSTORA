import { describe, it, expect } from "vitest";
import { quotaPercent, quotaTone } from "../quotaUsage";

describe("quotaPercent", () => {
  it("is null when the quota is unlimited", () => {
    expect(quotaPercent(10, null)).toBeNull();
  });
  it("rounds to a whole percent and caps at 100", () => {
    expect(quotaPercent(1, 3)).toBe(33);
    expect(quotaPercent(120, 100)).toBe(100);
  });
  it("treats a zero quota as fully used once anything is charged", () => {
    expect(quotaPercent(0, 0)).toBe(0);
    expect(quotaPercent(1, 0)).toBe(100);
  });
});

describe("quotaTone", () => {
  it("is ok below 80, warning at 80, critical at 95", () => {
    expect(quotaTone(79)).toBe("ok");
    expect(quotaTone(80)).toBe("warning");
    expect(quotaTone(94)).toBe("warning");
    expect(quotaTone(95)).toBe("critical");
  });
  it("is ok for an unlimited quota", () => {
    expect(quotaTone(null)).toBe("ok");
  });
});
