export function messagingTabFromSearch<T extends string>(
  search: string,
  fallback: T,
  supportedTabs: readonly T[],
): T {
  const tab = new URLSearchParams(search).get("tab");
  return supportedTabs.includes(tab as T) ? (tab as T) : fallback;
}
