import { renderHook } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { useDirtyForm } from "@/hooks/useDirtyForm";

describe("useDirtyForm", () => {
  it("is clean when the value matches the baseline", () => {
    const baseline = { persona: "friendly", temperature: 0.7 };
    const { result } = renderHook(() => useDirtyForm({ persona: "friendly", temperature: 0.7 }, baseline));
    expect(result.current).toBe(false);
  });

  it("is dirty once a field differs", () => {
    const baseline = { persona: "friendly", temperature: 0.7 };
    const { result } = renderHook(() => useDirtyForm({ persona: "blunt", temperature: 0.7 }, baseline));
    expect(result.current).toBe(true);
  });

  it("is clean again when the edit is reverted", () => {
    // Proves value comparison, not reference: an equal-but-new object must read clean.
    const baseline = { persona: "friendly", temperature: 0.7 };
    const { result, rerender } = renderHook(
      ({ current }) => useDirtyForm(current, baseline),
      { initialProps: { current: { persona: "blunt", temperature: 0.7 } } },
    );
    expect(result.current).toBe(true);
    rerender({ current: { persona: "friendly", temperature: 0.7 } });
    expect(result.current).toBe(false);
  });

  it("is never dirty while the baseline is null", () => {
    // The config has not loaded yet; the user has not seen the form, so nothing is at risk.
    const { result } = renderHook(() => useDirtyForm({ persona: "anything" }, null));
    expect(result.current).toBe(false);
  });

  it("detects a nested change", () => {
    const baseline = { persona: "a", tools: { search: true } };
    const { result } = renderHook(() => useDirtyForm({ persona: "a", tools: { search: false } }, baseline));
    expect(result.current).toBe(true);
  });
});
