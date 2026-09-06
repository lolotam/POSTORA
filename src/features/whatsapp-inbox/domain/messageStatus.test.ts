import { describe, expect, it } from "vitest";
import { tickKindFor } from "./messageStatus";

describe("tickKindFor", () => {
  it("maps stored statuses to tick kinds and defaults to sent", () => {
    expect(tickKindFor("read")).toBe("read");
    expect(tickKindFor("delivered")).toBe("delivered");
    expect(tickKindFor("failed")).toBe("failed");
    expect(tickKindFor("sent")).toBe("sent");
    expect(tickKindFor("received")).toBe("sent");
    expect(tickKindFor(null)).toBe("sent");
  });
});
