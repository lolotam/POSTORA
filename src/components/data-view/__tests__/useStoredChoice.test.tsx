import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStoredChoice } from "../useStoredChoice";

describe("useStoredChoice", () => {
  beforeEach(() => localStorage.clear());

  it("validates stored values and persists changes", () => {
    localStorage.setItem("columns", "6");
    const { result } = renderHook(() => useStoredChoice("columns", [4, 5, 6] as const, 5));
    expect(result.current[0]).toBe(6);
    act(() => result.current[1](4));
    expect(localStorage.getItem("columns")).toBe("4");
  });

  it("falls back for invalid or unavailable storage", () => {
    localStorage.setItem("view", "invalid");
    const { result } = renderHook(() => useStoredChoice("view", ["grid", "table"] as const, "table"));
    expect(result.current[0]).toBe("table");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    const blocked = renderHook(() => useStoredChoice("view", ["grid", "table"] as const, "grid"));
    expect(blocked.result.current[0]).toBe("grid");
    vi.restoreAllMocks();
  });
});
