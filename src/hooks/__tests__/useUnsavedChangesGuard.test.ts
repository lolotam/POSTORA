import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";

describe("useUnsavedChangesGuard", () => {
  it("runs the transition immediately when clean", () => {
    const proceed = vi.fn();
    const { result } = renderHook(() => useUnsavedChangesGuard(false));
    act(() => result.current.guard(proceed));
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBe(false);
  });

  it("holds the transition and opens the dialog when dirty", () => {
    const proceed = vi.fn();
    const { result } = renderHook(() => useUnsavedChangesGuard(true));
    act(() => result.current.guard(proceed));
    expect(proceed).not.toHaveBeenCalled();
    expect(result.current.pending).toBe(true);
  });

  it("confirmDiscard runs the held transition exactly once and closes", () => {
    const proceed = vi.fn();
    const { result } = renderHook(() => useUnsavedChangesGuard(true));
    act(() => result.current.guard(proceed));
    act(() => result.current.confirmDiscard());
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBe(false);
    act(() => result.current.confirmDiscard());
    expect(proceed).toHaveBeenCalledTimes(1); // not re-run
  });

  it("cancel drops the transition without running it", () => {
    const proceed = vi.fn();
    const { result } = renderHook(() => useUnsavedChangesGuard(true));
    act(() => result.current.guard(proceed));
    act(() => result.current.cancel());
    expect(proceed).not.toHaveBeenCalled();
    expect(result.current.pending).toBe(false);
  });

  it("registers beforeunload only while dirty", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");

    const { rerender, unmount } = renderHook(({ dirty }) => useUnsavedChangesGuard(dirty), {
      initialProps: { dirty: false },
    });
    expect(add.mock.calls.filter(([e]) => e === "beforeunload")).toHaveLength(0);

    rerender({ dirty: true });
    expect(add.mock.calls.filter(([e]) => e === "beforeunload")).toHaveLength(1);

    rerender({ dirty: false });
    expect(remove.mock.calls.filter(([e]) => e === "beforeunload")).toHaveLength(1);

    unmount();
    add.mockRestore();
    remove.mockRestore();
  });
});
