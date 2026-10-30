import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDisableMfa } from "../ui/useDisableMfa";
import type { AssuranceLevel, MfaGateway } from "../infrastructure/mfaGateway";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

function fakeGateway(level: AssuranceLevel, overrides: Partial<MfaGateway> = {}) {
  return {
    currentLevel: vi.fn(overrides.currentLevel ?? (async () => level)),
    verify: vi.fn(overrides.verify ?? (async () => "verified" as const)),
    unenroll: vi.fn(overrides.unenroll ?? (async () => {})),
    refreshSession: vi.fn(overrides.refreshSession ?? (async () => {})),
  };
}

const VERIFIED = { id: "factor-1", status: "verified" };
const UNVERIFIED = { id: "factor-2", status: "unverified" };

function setup(gateway: MfaGateway) {
  const onDisabled = vi.fn();
  const onError = vi.fn();
  const hook = renderHook(() => useDisableMfa({ onDisabled, onError, gateway }));
  return { ...hook, onDisabled, onError };
}

describe("useDisableMfa", () => {
  it("removes the factor at once from an AAL2 session", async () => {
    const gateway = fakeGateway("aal2");
    const { result, onDisabled } = setup(gateway);

    await act(() => result.current.requestDisable(VERIFIED));

    expect(gateway.unenroll).toHaveBeenCalledWith("factor-1");
    expect(gateway.refreshSession).toHaveBeenCalled();
    expect(onDisabled).toHaveBeenCalledTimes(1);
    expect(result.current.pendingFactorId).toBeNull();
    expect(gateway.verify).not.toHaveBeenCalled();
  });

  it("asks for a code from an AAL1 session and removes nothing yet", async () => {
    const gateway = fakeGateway("aal1");
    const { result, onDisabled } = setup(gateway);

    await act(() => result.current.requestDisable(VERIFIED));

    expect(result.current.pendingFactorId).toBe("factor-1");
    expect(gateway.unenroll).not.toHaveBeenCalled();
    expect(onDisabled).not.toHaveBeenCalled();
  });

  it("steps up with the right code, then removes the factor", async () => {
    const gateway = fakeGateway("aal1");
    const { result, onDisabled } = setup(gateway);
    await act(() => result.current.requestDisable(VERIFIED));

    let removed = false;
    await act(async () => { removed = await result.current.submitCode("123456", "Invalid code"); });

    expect(removed).toBe(true);
    expect(gateway.verify).toHaveBeenCalledWith("factor-1", "123456");
    expect(gateway.verify.mock.invocationCallOrder[0]).toBeLessThan(gateway.unenroll.mock.invocationCallOrder[0]);
    expect(gateway.refreshSession).toHaveBeenCalled();
    expect(onDisabled).toHaveBeenCalledTimes(1);
    expect(result.current.pendingFactorId).toBeNull();
  });

  it("keeps the factor and the dialog open on a wrong code", async () => {
    const gateway = fakeGateway("aal1", { verify: async () => "invalid_code" as const });
    const { result, onDisabled, onError } = setup(gateway);
    await act(() => result.current.requestDisable(VERIFIED));

    let removed = true;
    await act(async () => { removed = await result.current.submitCode("000000", "Invalid code"); });

    expect(removed).toBe(false);
    expect(gateway.unenroll).not.toHaveBeenCalled();
    expect(result.current.codeError).toBe("Invalid code");
    expect(result.current.pendingFactorId).toBe("factor-1");
    expect(onDisabled).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("removes an unverified factor at once from an AAL1 session, with no code and no step-up", async () => {
    const gateway = fakeGateway("aal1");
    const { result, onDisabled, onError } = setup(gateway);

    await act(() => result.current.requestDisable(UNVERIFIED));

    expect(gateway.unenroll).toHaveBeenCalledWith("factor-2");
    expect(gateway.currentLevel).not.toHaveBeenCalled();
    expect(gateway.verify).not.toHaveBeenCalled();
    expect(gateway.refreshSession).not.toHaveBeenCalled();
    expect(result.current.pendingFactorId).toBeNull();
    expect(onDisabled).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a failure to remove an unverified factor", async () => {
    const gateway = fakeGateway("aal1", { unenroll: async () => { throw new Error("server error"); } });
    const { result, onDisabled, onError } = setup(gateway);

    await act(() => result.current.requestDisable(UNVERIFIED));

    expect(onError).toHaveBeenCalledWith("server error");
    expect(onDisabled).not.toHaveBeenCalled();
    expect(result.current.busyFactorId).toBeNull();
  });

  it("reports any failure other than a wrong code, closes the dialog and leaves the factor enrolled", async () => {
    const gateway = fakeGateway("aal1", { verify: async () => { throw new Error("Too many requests"); } });
    const { result, onDisabled, onError } = setup(gateway);
    await act(() => result.current.requestDisable(VERIFIED));

    let removed = true;
    await act(async () => { removed = await result.current.submitCode("123456", "Invalid code"); });

    expect(removed).toBe(false);
    expect(onError).toHaveBeenCalledWith("Too many requests");
    expect(gateway.unenroll).not.toHaveBeenCalled();
    expect(onDisabled).not.toHaveBeenCalled();
    expect(result.current.codeError).toBeNull();
    expect(result.current.pendingFactorId).toBeNull();
  });

  it("still reports success when the session refresh fails", async () => {
    const gateway = fakeGateway("aal2", { refreshSession: async () => { throw new Error("network"); } });
    const { result, onDisabled, onError } = setup(gateway);

    await act(() => result.current.requestDisable(VERIFIED));

    expect(onDisabled).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports an unenroll failure and closes the dialog", async () => {
    const gateway = fakeGateway("aal1", { unenroll: async () => { throw new Error("server error"); } });
    const { result, onDisabled, onError } = setup(gateway);
    await act(() => result.current.requestDisable(VERIFIED));

    await act(async () => { await result.current.submitCode("123456", "Invalid code"); });

    expect(onError).toHaveBeenCalledWith("server error");
    expect(onDisabled).not.toHaveBeenCalled();
    expect(result.current.pendingFactorId).toBeNull();
  });

  it("reports a failed assurance-level read without removing anything", async () => {
    const gateway = fakeGateway("aal2", { currentLevel: async () => { throw new Error("session missing"); } });
    const { result, onError } = setup(gateway);

    await act(() => result.current.requestDisable(VERIFIED));

    expect(onError).toHaveBeenCalledWith("session missing");
    expect(gateway.unenroll).not.toHaveBeenCalled();
    expect(result.current.busyFactorId).toBeNull();
  });

  it("cancel clears the pending factor and the error", async () => {
    const gateway = fakeGateway("aal1", { verify: async () => "invalid_code" as const });
    const { result } = setup(gateway);
    await act(() => result.current.requestDisable(VERIFIED));
    await act(async () => { await result.current.submitCode("000000", "Invalid code"); });

    act(() => result.current.cancel());

    expect(result.current.pendingFactorId).toBeNull();
    expect(result.current.codeError).toBeNull();
  });
});
