import { describe, it, expect, beforeAll } from "vitest";
import i18next from "../index";

describe("i18n bootstrap", () => {
  beforeAll(async () => {
    if (!i18next.isInitialized) {
      await new Promise((resolve) => i18next.on("initialized", resolve));
    }
  });

  // The defect this file exists for: importing the module must leave a real
  // translator behind. An uninitialised i18next still renders copy through a
  // stub, so the failure is invisible until a second language is added.
  it("importing the module leaves i18next initialised", () => {
    expect(i18next.isInitialized).toBe(true);
  });

  // Guards nonExplicitSupportedLngs. Without it a browser reporting "en-US"
  // matches nothing in supportedLngs and no language is ever negotiated.
  it("folds a region subtag onto its supported base language", () => {
    expect(i18next.languages).toContain("en");
  });

  // Guards the empty-namespace design: English lives in the t(key, default)
  // second argument, so a regression here renders "endpoints.fullUrl" as UI copy.
  it.each([
    ["endpoints.fullUrl", "Full URL"],
    ["header.title", "MCP & API"],
    ["nothing.defines.this", "Fallback copy"],
  ])("renders the call-site default for %s rather than the key path", (key, fallback) => {
    expect(i18next.t(key, fallback)).toBe(fallback);
  });

  // Regression guard: this was written against resolvedLanguage, which is
  // undefined even after a successful init, so the document was pinned to ltr
  // regardless of language and the RTL styling in the UI primitives was dead.
  it("mirrors the live language and its direction onto the document", () => {
    expect(i18next.language).toBeTruthy();
    expect(document.documentElement.lang).toBe(i18next.language);
    expect(document.documentElement.dir).toBe(i18next.dir());
  });
});
