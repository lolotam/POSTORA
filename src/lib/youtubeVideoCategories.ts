/**
 * YouTube video-category catalog shared by the Create Post editor and the
 * published-video editor.
 *
 * Google's `videoCategories.list` is the authority for the categories of a
 * region and for which of them a creator may assign. Both editors must show
 * the same ordered list, keep non-assignable entries visible but disabled,
 * and never replace a category a video already carries with a different one
 * just because the catalog no longer lists it.
 */

export type YouTubeCategoryLocale = "en" | "ar";

export interface YouTubeCategoryOption {
  /** The numeric YouTube category ID, persisted and sent as-is. */
  id: string;
  /** `ID (Name)`, with the ID first even in an RTL locale. */
  label: string;
  name: string;
  /** False for catalog entries Google marks as non-assignable. */
  assignable: boolean;
  /** True for a video's existing category that the catalog did not return. */
  unavailable: boolean;
}

export interface YouTubeCategoryApiEntry {
  id: string;
  snippet?: {
    title?: string;
    assignable?: boolean;
    localized?: Record<string, { title?: string }>;
  };
}

interface CatalogEntry {
  id: string;
  en: string;
  ar: string;
  assignable: boolean;
}

/**
 * The standard YouTube category catalog. Entries Google reports as
 * non-assignable (Movies, Shows, Trailers) stay in the list for a video that
 * already uses them, but cannot be chosen for a new upload or edit.
 */
export const YOUTUBE_CATEGORY_CATALOG: readonly CatalogEntry[] = [
  { id: "1", en: "Film & Animation", ar: "الأفلام والرسوم المتحركة", assignable: true },
  { id: "2", en: "Autos & Vehicles", ar: "السيارات والمركبات", assignable: true },
  { id: "10", en: "Music", ar: "الموسيقى", assignable: true },
  { id: "15", en: "Pets & Animals", ar: "الحيوانات الأليفة والحيوانات", assignable: true },
  { id: "17", en: "Sports", ar: "الرياضة", assignable: true },
  { id: "19", en: "Travel & Events", ar: "السفر والفعاليات", assignable: true },
  { id: "20", en: "Gaming", ar: "الألعاب", assignable: true },
  { id: "22", en: "People & Blogs", ar: "الأشخاص والمدونات", assignable: true },
  { id: "23", en: "Comedy", ar: "الكوميديا", assignable: true },
  { id: "24", en: "Entertainment", ar: "الترفيه", assignable: true },
  { id: "25", en: "News & Politics", ar: "الأخبار والسياسة", assignable: true },
  { id: "26", en: "Howto & Style", ar: "إرشادات وأسلوب حياة", assignable: true },
  { id: "27", en: "Education", ar: "التعليم", assignable: true },
  { id: "28", en: "Science & Technology", ar: "العلوم والتكنولوجيا", assignable: true },
  { id: "29", en: "Nonprofits & Activism", ar: "المنظمات غير الربحية والنشاط الاجتماعي", assignable: true },
  { id: "30", en: "Movies", ar: "الأفلام", assignable: false },
  { id: "43", en: "Shows", ar: "البرامج", assignable: false },
  { id: "44", en: "Trailers", ar: "العروض الدعائية", assignable: false },
];

const BIDI_ISOLATE_START = "\u2068";
const BIDI_ISOLATE_END = "\u2069";

/**
 * Formats one option label. The numeric ID is isolated with bidi marks so an
 * RTL layout still renders `22 (People & Blogs)` rather than moving the number
 * to the other side of the name.
 */
export function formatYouTubeCategoryLabel(id: string, name: string): string {
  return `${BIDI_ISOLATE_START}${id}${BIDI_ISOLATE_END} (${name})`;
}

const ARABIC_CATEGORY_NAMES: Record<string, string> = Object.fromEntries(
  YOUTUBE_CATEGORY_CATALOG.map((entry) => [entry.id, entry.ar]),
);

function numericId(id: string): number {
  const value = Number(id);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function labelFor(id: string, name: string): string {
  return formatYouTubeCategoryLabel(id, name);
}

/**
 * Builds the ordered options for a region from Google's catalog response.
 *
 * A missing or empty response falls back to the bundled catalog, so a failed
 * catalog read degrades to a usable list instead of an empty editor. An API
 * entry's localized title wins over the bundled translation when Google
 * supplied one.
 */
export function youtubeCategoryOptions(
  entries: readonly YouTubeCategoryApiEntry[] | null | undefined,
  locale: YouTubeCategoryLocale = "en",
): YouTubeCategoryOption[] {
  const source = entries && entries.length > 0 ? entries : YOUTUBE_CATEGORY_CATALOG;
  const localized = locale === "ar";

  return source
    .map((entry) => {
      const id = "id" in entry ? String(entry.id) : String((entry as CatalogEntry).id);
      const name = localized
        ? (entry.snippet?.localized?.ar?.title ?? ARABIC_CATEGORY_NAMES[id] ?? entry.snippet?.title ?? id)
        : (entry.snippet?.title ?? (entry as CatalogEntry).en ?? id);
      const assignable = "snippet" in entry
        ? entry.snippet?.assignable !== false
        : (entry as CatalogEntry).assignable;
      return { id, name, assignable, label: labelFor(id, name) };
    })
    .sort((a, b) => numericId(a.id) - numericId(b.id) || a.id.localeCompare(b.id))
    .map((option) => ({ ...option, unavailable: false }));
}

/**
 * Adds a video's existing category when the catalog no longer lists it.
 *
 * The entry stays visible and disabled: the editor can explain that the value
 * is preserved from the video rather than silently replacing it, and the save
 * payload continues to carry the original ID unchanged.
 */
export function preserveYouTubeCategory(
  options: readonly YouTubeCategoryOption[],
  existingId: string | null | undefined,
  locale: YouTubeCategoryLocale = "en",
  providerName?: string | null,
): YouTubeCategoryOption[] {
  if (!existingId || options.some((option) => option.id === existingId)) {
    return [...options];
  }
  const unavailableLabel = locale === "ar" ? "غير متاح حالياً" : "Currently unavailable";
  const name = providerName?.trim() || unavailableLabel;
  const preserved: YouTubeCategoryOption = {
    id: existingId,
    name,
    label: labelFor(existingId, name),
    assignable: false,
    unavailable: true,
  };
  return [...options, preserved].sort(
    (a, b) => numericId(a.id) - numericId(b.id) || a.id.localeCompare(b.id),
  );
}
