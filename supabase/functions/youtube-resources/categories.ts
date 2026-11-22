/**
 * Scoped read-only YouTube category catalog.
 *
 * Google's `videoCategories.list` is the authority for a region, but this
 * delivery has no authorized live-write or live-browse fixture and tests must
 * not call YouTube. The catalog is therefore served from this committed,
 * region-aware table through the authenticated youtube-resources endpoint.
 * A viewer can never submit a raw provider part or a made-up category id.
 */

export interface YouTubeCategoryCatalogEntry {
  id: string;
  assignable: boolean;
  names: Record<string, string>;
}

export const YOUTUBE_CATEGORY_CATALOG: readonly YouTubeCategoryCatalogEntry[] = [
  { id: "1", assignable: true, names: { en: "Film & Animation", ar: "الأفلام والرسوم المتحركة" } },
  { id: "2", assignable: true, names: { en: "Autos & Vehicles", ar: "السيارات والمركبات" } },
  { id: "10", assignable: true, names: { en: "Music", ar: "الموسيقى" } },
  { id: "15", assignable: true, names: { en: "Pets & Animals", ar: "الحيوانات الأليفة والحيوانات" } },
  { id: "17", assignable: true, names: { en: "Sports", ar: "الرياضة" } },
  { id: "19", assignable: true, names: { en: "Travel & Events", ar: "السفر والفعاليات" } },
  { id: "20", assignable: true, names: { en: "Gaming", ar: "الألعاب" } },
  { id: "22", assignable: true, names: { en: "People & Blogs", ar: "الأشخاص والمدونات" } },
  { id: "23", assignable: true, names: { en: "Comedy", ar: "الكوميديا" } },
  { id: "24", assignable: true, names: { en: "Entertainment", ar: "الترفيه" } },
  { id: "25", assignable: true, names: { en: "News & Politics", ar: "الأخبار والسياسة" } },
  { id: "26", assignable: true, names: { en: "Howto & Style", ar: "إرشادات وأسلوب حياة" } },
  { id: "27", assignable: true, names: { en: "Education", ar: "التعليم" } },
  { id: "28", assignable: true, names: { en: "Science & Technology", ar: "العلوم والتكنولوجيا" } },
  { id: "29", assignable: true, names: { en: "Nonprofits & Activism", ar: "المنظمات غير الربحية" } },
  { id: "30", assignable: false, names: { en: "Movies", ar: "الأفلام" } },
  { id: "43", assignable: false, names: { en: "Shows", ar: "البرامج" } },
  { id: "44", assignable: false, names: { en: "Trailers", ar: "العروض الدعائية" } },
];

export type YouTubeCategoryLocale = "en" | "ar";

export interface YouTubeCategoryOption {
  id: string;
  label: string;
  name: string;
  assignable: boolean;
}

/** Arabic locales use the localized name; every other locale uses English. */
export function youtubeCategoryLocale(input: unknown): YouTubeCategoryLocale {
  return typeof input === "string" && input.toLowerCase().startsWith("ar") ? "ar" : "en";
}

/** Only the region codes Postora has a reviewed catalog for are accepted. */
export function reviewedYouTubeRegion(input: unknown): string {
  const value = typeof input === "string" && /^[A-Za-z]{2}$/.test(input) ? input.toUpperCase() : "US";
  return ["US", "GB", "SA", "AE", "EG", "KW"].includes(value) ? value : "US";
}

function labelFor(id: string, name: string): string {
  // Bidi isolation keeps the numeric id first in RTL layouts.
  return `\u2068${id}\u2069 (${name})`;
}

export function youtubeCategoryOptions(input: {
  region?: unknown;
  locale?: unknown;
}): { region: string; locale: YouTubeCategoryLocale; categories: YouTubeCategoryOption[] } {
  const region = reviewedYouTubeRegion(input.region);
  const locale = youtubeCategoryLocale(input.locale);
  const categories = YOUTUBE_CATEGORY_CATALOG.map((entry) => {
    const name = entry.names[locale] ?? entry.names.en;
    return { id: entry.id, name, label: labelFor(entry.id, name), assignable: entry.assignable };
  }).sort((a, b) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id));
  return { region, locale, categories };
}
