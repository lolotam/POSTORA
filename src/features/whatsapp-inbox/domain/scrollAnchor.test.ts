import { describe, expect, it } from "vitest";
import { anchorOffsetAfterPrepend, shouldStickToBottom } from "./scrollAnchor";

describe("shouldStickToBottom", () => {
  it("is true at the bottom", () => {
    expect(shouldStickToBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
  });

  it("is false while reading history", () => {
    expect(shouldStickToBottom({ scrollTop: 100, scrollHeight: 1000, clientHeight: 100 })).toBe(false);
  });

  it("tolerates sub-pixel rounding", () => {
    expect(shouldStickToBottom({ scrollTop: 899.6, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
  });
});

describe("anchorOffsetAfterPrepend", () => {
  it("pins the read position when older messages prepend", () => {
    expect(anchorOffsetAfterPrepend(1000, 1400, 0)).toBe(400);
  });
});
