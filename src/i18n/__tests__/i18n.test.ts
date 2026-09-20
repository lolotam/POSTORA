import { describe, it, expect, beforeAll, afterAll } from "vitest";
import i18next, { SUPPORTED_LANGUAGES } from "../index";

describe("i18n bootstrap", () => {
  beforeAll(async () => {
    if (!i18next.isInitialized) {
      await new Promise((resolve) => i18next.on("initialized", resolve));
    }
  });

  afterAll(async () => {
    // Restore language to "en" so subsequent test suites don't inherit an RTL document
    await i18next.changeLanguage("en");
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

  // Guards Arabic support: "ar" must be in SUPPORTED_LANGUAGES and changing to it
  // must resolve rather than folding back onto the English fallback.
  it("resolves Arabic instead of falling back to English", async () => {
    expect(SUPPORTED_LANGUAGES).toContain("ar");
    await i18next.changeLanguage("ar");
    expect(i18next.language).toBe("ar");
  });

  // Guards the whole RTL activation path: html[lang="ar"] and [dir="rtl"] are what
  // switch the UI onto the Cairo face in src/index.css, so a language that never
  // reaches the document element renders Arabic in the Latin font instead.
  // Each case sets its own language - these must not depend on test ordering.
  it.each([
    ["ar", "rtl"],
    ["en", "ltr"],
  ])("switching to %s puts the document in %s", async (language, direction) => {
    await i18next.changeLanguage(language);
    expect(document.documentElement.lang).toBe(language);
    expect(document.documentElement.dir).toBe(direction);
  });

  // Guards that the ar bundle is wired into `resources`, not merely present on disk.
  // An unregistered namespace silently returns the call-site English default, which
  // reads as a translation gap rather than the config bug it actually is.
  it("renders Arabic copy for a key in the ar bundle", async () => {
    await i18next.changeLanguage("ar");
    expect(i18next.t("sidebar.dashboard", { ns: "nav" })).toBe("لوحة التحكم");
  });
});
