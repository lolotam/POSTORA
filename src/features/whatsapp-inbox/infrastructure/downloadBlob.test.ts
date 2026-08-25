import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadBlob } from "./downloadBlob";

describe("downloadBlob", () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let click: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    createObjectURL = vi.fn(() => "blob:export-1");
    revokeObjectURL = vi.fn();
    click = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(click);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Regression, 2026-08-25: a synchronous revoke after click() races in Safari and
  // yields an empty download. The object URL must survive into the next turn.
  it("revokes the object URL on the next tick rather than synchronously after click", () => {
    downloadBlob(new Blob(["hello"], { type: "text/plain" }), "chat.md");

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    vi.runOnlyPendingTimers();

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:export-1");
  });

  it("names the downloaded file", () => {
    downloadBlob(new Blob(["a"]), "Ada-1111.csv");
    const anchor = document.body.querySelector("a");
    expect(anchor).toBeNull();
    expect(click).toHaveBeenCalled();
  });
});
