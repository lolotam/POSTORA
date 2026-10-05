import { describe, expect, it } from "vitest";
import {
  countMatchesByTab,
  groupSectionsBySubTab,
  readSettingsTab,
  resolveSubTab,
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

describe("groupSectionsBySubTab", () => {
  const GROUPED: SearchableSection[] = [
    { id: "chat", tab: "ai", title: "Chat", keywords: ["chat"], subTab: "Chat Models" },
    { id: "image", tab: "ai", title: "Image", keywords: ["image"], subTab: "Image Generation" },
    { id: "notes", tab: "ai", title: "Notes", keywords: ["notes"] },
    { id: "chat-extra", tab: "ai", title: "Chat extra", keywords: ["extra"], subTab: "Chat Models" },
  ];

  it("keeps sections without a sub-tab out of the strip so they stay stacked", () => {
    expect(groupSectionsBySubTab(GROUPED).ungrouped.map((s) => s.id)).toEqual(["notes"]);
  });

  it("collects every section sharing a label into one panel", () => {
    const chat = groupSectionsBySubTab(GROUPED).subTabs.find((g) => g.label === "Chat Models");
    expect(chat?.sections.map((s) => s.id)).toEqual(["chat", "chat-extra"]);
  });

  it("orders sub-tabs by first appearance, so reordering the catalog reorders the strip", () => {
    expect(groupSectionsBySubTab(GROUPED).subTabs.map((g) => g.label)).toEqual([
      "Chat Models",
      "Image Generation",
    ]);
  });
});

describe("resolveSubTab", () => {
  it.each<[string[], string | null, string | null, string]>([
    [["A", "B"], "B", "B", "an offered sub-tab is honoured"],
    // A label the search has just filtered away is indistinguishable from a stale
    // bookmark, and both want the same answer: show something rather than nothing.
    [["A", "B"], "Z", "A", "a label not on offer falls back rather than rendering an empty panel"],
    [["A", "B"], null, "A", "no request opens the first sub-tab"],
    [[], "A", null, "nothing on offer resolves to nothing"],
  ])("%j + %j resolves to %j — %s", (available, requested, expected) => {
    expect(resolveSubTab(available, requested)).toBe(expected);
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

  it("renders the AI sub-tab strip as these thirteen labels, in catalog order", () => {
    const aiSections = SETTINGS_SECTIONS.filter((section) => section.tab === "ai");
    expect(groupSectionsBySubTab(aiSections).subTabs.map((group) => group.label)).toEqual([
      "Search Models",
      "Embedding",
      "AI Agent",
      "Speech to Text",
      "Image & Document Understanding",
      "Text to Speech",
      "Video Generation",
      "Chat Models",
      "Image Generation",
      "Providers",
      "Brand Intelligence",
      "Higgsfield",
      "Per-user Overrides",
    ]);
  });

  // Every AI section sits behind a sub-tab. One that did not would render underneath
  // whichever panel happened to be open, which is what the sub-tabs exist to stop.
  it("leaves no AI section stacked under every panel", () => {
    const aiSections = SETTINGS_SECTIONS.filter((section) => section.tab === "ai");
    expect(groupSectionsBySubTab(aiSections).ungrouped).toEqual([]);
  });

  // The search placeholder suggests "model", and every card carries a temperature knob,
  // so both queries have to reach all nine category cards. Splitting the categories into
  // separate keyword lists is what nearly cost that: each generic term survived only
  // wherever it happened to be retyped.
  it.each<[string]>([["model"], ["temperature"], ["fallback"]])(
    "generic query %j still reaches every model card",
    (query) => {
      const hits = searchSettings(SETTINGS_SECTIONS, query).map((section) => section.id);
      const categoryIds = SETTINGS_SECTIONS.filter(
        (section) => section.tab === "ai" && section.id.startsWith("ai-") && section.id !== "ai-providers",
      ).map((section) => section.id);

      expect(categoryIds).toHaveLength(9);
      for (const id of categoryIds) expect(hits).toContain(id);
    },
  );

  // "embedding" and "transcription" matched nothing at all while the seven categories
  // shared one section's keyword list; "hashtags" and "video generation" matched, but
  // only reached a section that was not the card they name. Splitting the categories
  // apart is what routes each query to its own card.
  it.each<[string, string]>([
    ["embedding", "ai-embedding-models"],
    ["transcription", "ai-stt-models"],
    ["receipt", "ai-vision-models"],
    ["pdf", "ai-vision-models"],
    ["video generation", "ai-video-models"],
    ["hashtags", "ai-chat-models"],
  ])("search for %j reaches %j", (query, expectedId) => {
    expect(searchSettings(SETTINGS_SECTIONS, query).map((s) => s.id)).toContain(expectedId);
  });
});
