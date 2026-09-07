import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ toast: toastMock }));
vi.mock("@/components/ui/toast", () => ({ ToastAction: () => null }));

import {
  installStaleChunkListener,
  isChunkLoadError,
  newVersionUrl,
  promptForNewVersion,
  resetStaleChunkPromptForTests,
} from "./staleChunk";

describe("isChunkLoadError", () => {
  it.each([
    "Failed to fetch dynamically imported module: https://postora.cloud/assets/Landing-fe6oemdW.js",
    "ChunkLoadError: Loading chunk 12 failed",
    "Importing a module script failed.",
    "error loading dynamically imported module",
  ])("recognises a stale-chunk failure: %s", (message) => {
    expect(isChunkLoadError(new Error(message))).toBe(true);
  });

  it("leaves ordinary errors and empty values alone", () => {
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe("newVersionUrl", () => {
  it("keeps path and hash and adds a fresh version query so the cached index.html is bypassed", () => {
    const url = new URL("https://postora.cloud/messaging/whatsapp?tab=inbox#thread-3");
    expect(newVersionUrl(url, 1700000000000)).toBe(
      "https://postora.cloud/messaging/whatsapp?tab=inbox&v=1700000000000#thread-3",
    );
  });

  it("replaces an earlier version query instead of stacking them", () => {
    const url = new URL("https://postora.cloud/?v=1");
    expect(newVersionUrl(url, 2)).toBe("https://postora.cloud/?v=2");
  });
});

describe("stale chunk prompt", () => {
  beforeEach(() => {
    toastMock.mockClear();
    resetStaleChunkPromptForTests();
  });
  afterEach(() => resetStaleChunkPromptForTests());

  it("shows the new-version toast once even when several imports fail", () => {
    promptForNewVersion();
    promptForNewVersion();
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0][0].title).toMatch(/new version/i);
  });

  it("turns vite:preloadError for a stale chunk into the prompt and suppresses the default crash", () => {
    const remove = installStaleChunkListener(window);
    const event = new Event("vite:preloadError", { cancelable: true });
    (event as Event & { payload: Error }).payload = new Error(
      "Failed to fetch dynamically imported module: https://postora.cloud/assets/x.js",
    );
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(toastMock).toHaveBeenCalledTimes(1);
    remove();
  });

  it("ignores a preload error that is not a stale chunk", () => {
    const remove = installStaleChunkListener(window);
    const event = new Event("vite:preloadError", { cancelable: true });
    (event as Event & { payload: Error }).payload = new Error("SyntaxError: unexpected token");
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(toastMock).not.toHaveBeenCalled();
    remove();
  });
});
