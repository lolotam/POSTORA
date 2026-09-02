import { describe, expect, it } from "vitest";
import {
  countMatchesByTab,
  readSettingsTab,
  searchSettings,
  type SearchableSection,
} from "@/lib/settingsSearch";
import { SETTINGS_SECTIONS } from "@/components/admin/settings/settingsCatalog";

const SECTIONS: SearchableSection[] = [
  { id: "identity", tab: "general", title: "Identity", keywords: ["app name", "logo", "favicon"] },
  { id: "theme", tab: "general", title: "Theme", keywords: ["dark mode", "palette"] },
  { id: "sandbox", tab: "integrations", title: "TikTok sandbox mode", keywords: ["tiktok", "production"] },
  { id: "cdn", tab: "integrations", title: "CDN and storage", keywords: ["cloudinary", "uploads"] },
  { id: "models", tab: "ai", title: "AI models and providers", keywords: ["openai", "gemini", "tiktok caption"] },
];

describe("searchSettings", () => {
  it.each([
    ["", 5, "a blank query leaves the page unfiltered"],
    ["   ", 5, "whitespace is not a search"],
    ["logo", 1, "a keyword the title never mentions still finds its section"],
    ["IDENTITY", 1, "matching ignores case"],
    ["stor", 1, "a partial word matches, so results appear while typing"],
    ["tiktok", 2, "one term spanning two tabs returns both"],
    ["tiktok sandbox", 1, "a second term narrows rather than widens"],
    ["  tiktok   sandbox  ", 1, "stray whitespace between terms is ignored"],
    ["sandbox tiktok", 1, "term order does not matter"],
    ["nonexistent", 0, "an unmatched query returns nothing rather than everything"],
    ["tiktok gemini", 1, "terms may match different fields of the same section"],
  ])("query %j matches %i sections — %s", (query, expected) => {
    expect(searchSettings(SECTIONS, query)).toHaveLength(expected);
  });

  it("returns a new array, so a caller cannot mutate the catalog by sorting results", () => {
    const results = searchSettings(SECTIONS, "");
    expect(results).not.toBe(SECTIONS);
    expect(results).toEqual(SECTIONS);
  });
});

describe("countMatchesByTab", () => {
  it("reports a zero for tabs with no hits, so the UI can say 'none in this tab'", () => {
    expect(countMatchesByTab(searchSettings(SECTIONS, "tiktok"))).toEqual({
      general: 0,
      integrations: 1,
      ai: 1,
    });
  });
});

describe("readSettingsTab", () => {
  it.each([
    ["integrations", "integrations"],
    ["ai", "ai"],
    ["nope", "general"],
    [null, "general"],
  ])("%j reads as %j", (input, expected) => {
    expect(readSettingsTab(input)).toBe(expected);
  });
});

describe("the settings catalog", () => {
  // The catalog is what the page renders from, so a duplicate id would silently render
  // one section twice under the same React key.
  it("has a unique id per section", () => {
    const ids = SETTINGS_SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every section searchable keywords", () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(section.keywords.length, `${section.id} has no keywords`).toBeGreaterThan(0);
    }
  });
});
