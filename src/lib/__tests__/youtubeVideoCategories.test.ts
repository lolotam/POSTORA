import { describe, expect, it } from "vitest";

import {
  preserveYouTubeCategory,
  YOUTUBE_CATEGORY_CATALOG,
  youtubeCategoryOptions,
  type YouTubeCategoryApiEntry,
} from "../youtubeVideoCategories";

const stripBidi = (label: string) => label.replace(/[\u2068\u2069]/g, "");

describe("YouTube video category catalog", () => {
  it("lists every catalog category in ascending numeric ID order", () => {
    const ids = youtubeCategoryOptions(null, "en").map((option) => option.id);

    expect(ids).toEqual(YOUTUBE_CATEGORY_CATALOG.map((entry) => entry.id));
    expect(ids).toEqual([...ids].sort((a, b) => Number(a) - Number(b)));
  });

  it.each([
    { id: "22", en: "People & Blogs" },
    { id: "1", en: "Film & Animation" },
    { id: "44", en: "Trailers" },
  ])("labels category $id as ID (Name) in English", ({ id, en }) => {
    const option = youtubeCategoryOptions(null, "en").find((entry) => entry.id === id);

    expect(stripBidi(option!.label)).toBe(`${id} (${en})`);
  });

  it("keeps the number first in Arabic using the provider's localized name", () => {
    const option = youtubeCategoryOptions(null, "ar").find((entry) => entry.id === "22")!;

    expect(stripBidi(option.label)).toBe("22 (الأشخاص والمدونات)");
    expect(option.label.startsWith("\u206822\u2069")).toBe(true);
  });

  it("shows non-assignable catalog entries as visible but disabled", () => {
    const options = youtubeCategoryOptions(null, "en");

    for (const id of ["30", "43", "44"]) {
      const option = options.find((entry) => entry.id === id)!;
      expect(option.assignable).toBe(false);
      expect(option.unavailable).toBe(false);
    }
    expect(options.find((entry) => entry.id === "22")!.assignable).toBe(true);
  });

  it("uses Google's localized title and assignable flag from a catalog response", () => {
    const response: YouTubeCategoryApiEntry[] = [
      { id: "27", snippet: { title: "Education", assignable: true, localized: { ar: { title: "تعليم" } } } },
      { id: "30", snippet: { title: "Movies", assignable: false } },
    ];

    const english = youtubeCategoryOptions(response, "en");
    const arabic = youtubeCategoryOptions(response, "ar");

    expect(english.map((option) => [option.id, option.label, option.assignable])).toEqual([
      ["27", "\u206827\u2069 (Education)", true],
      ["30", "\u206830\u2069 (Movies)", false],
    ]);
    expect(stripBidi(arabic[0].label)).toBe("27 (تعليم)");
  });

  it("preserves an absent legacy category with an unavailable label", () => {
    const options = youtubeCategoryOptions(null, "en");
    const withLegacy = preserveYouTubeCategory(options, "999", "en");

    expect(withLegacy).toHaveLength(options.length + 1);
    const legacy = withLegacy.find((option) => option.id === "999")!;
    expect(stripBidi(legacy.label)).toBe("999 (Currently unavailable)");
    expect(legacy.assignable).toBe(false);
    expect(legacy.unavailable).toBe(true);
  });

  it("uses the provider name for a preserved category and leaves listed categories alone", () => {
    const options = youtubeCategoryOptions(null, "en");

    expect(preserveYouTubeCategory(options, "22", "en", "Ignored")).toEqual(options);
    const preserved = preserveYouTubeCategory(options, "998", "en", "Old Category")!;
    expect(stripBidi(preserved.find((option) => option.id === "998")!.label)).toBe("998 (Old Category)");
  });
});
