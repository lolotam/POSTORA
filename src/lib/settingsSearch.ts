// Search over the admin settings catalog.
//
// Kept free of React so the matching rules can be tested without rendering a
// page whose sections each open their own Supabase queries.

export const SETTINGS_TABS = ["general", "integrations", "ai"] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

export const DEFAULT_SETTINGS_TAB: SettingsTab = "general";

export const SETTINGS_TAB_LABELS: Record<SettingsTab, string> = {
  general: "General",
  integrations: "Integrations",
  ai: "AI",
};

/** Anything unrecognised falls back to the default rather than rendering an empty page. */
export function readSettingsTab(value: string | null): SettingsTab {
  return SETTINGS_TABS.includes(value as SettingsTab) ? (value as SettingsTab) : DEFAULT_SETTINGS_TAB;
}

export interface SearchableSection {
  id: string;
  tab: SettingsTab;
  /** Shown in the results summary, so it reads as a person would name the section. */
  title: string;
  /** Field labels and synonyms someone might type instead of the title. */
  keywords: readonly string[];
}

/**
 * Every whitespace-separated term must match somewhere in the section, so "tiktok
 * sandbox" narrows rather than widening the way a single substring test would.
 *
 * A blank query matches everything: the caller renders whatever comes back, and only
 * the results summary is conditional on someone having actually typed.
 */
export function searchSettings<T extends SearchableSection>(
  sections: readonly T[],
  query: string,
): T[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...sections];

  return sections.filter((section) => {
    const haystack = [section.title, ...section.keywords].join(" ").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** Match counts per tab, with every tab present so a zero can be rendered as "none here". */
export function countMatchesByTab(
  matches: readonly SearchableSection[],
): Record<SettingsTab, number> {
  const counts = { general: 0, integrations: 0, ai: 0 };
  for (const match of matches) counts[match.tab] += 1;
  return counts;
}
