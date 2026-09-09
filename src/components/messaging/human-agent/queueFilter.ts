// Pure logic behind the Human Agent waiting-queue platform filter. Kept out of
// the component file so Fast Refresh keeps working and so each rule below can be
// unit-tested without rendering anything.

export type Platform = "whatsapp" | "facebook" | "instagram";

export type QueueFilter = Platform | "all";

// Brand casing, not title-casing — "WhatsApp", never "Whatsapp". Exhaustive by
// type, so widening Platform is a compile error here rather than a display bug.
const PLATFORM_LABELS: Record<Platform, string> = {
  whatsapp: "WhatsApp",
  facebook: "Facebook",
  instagram: "Instagram",
};

export function platformLabel(platform: Platform): string {
  return PLATFORM_LABELS[platform];
}

// A filter survives only while its platform still has a connected account.
// Derived at render time, never written back into state, so a disconnected
// account can never leave the queue pinned to a platform whose chip is no
// longer rendered — there would be no way to clear it.
export function resolveQueueFilter(selected: QueueFilter, available: Platform[]): QueueFilter {
  if (selected === "all") return "all";
  return available.includes(selected) ? selected : "all";
}

// Copy for the empty waiting queue. The reassuring "everything is handled" line
// is only true when the WHOLE queue is empty: filtered to one platform while
// others still have a backlog, it would tell the agent to stop looking.
export function emptyQueueCopy(
  activeFilter: QueueFilter,
  totalWaiting: number,
): { title: string; subtitle: string } {
  return {
    title: activeFilter === "all" ? "Nothing waiting" : `Nothing waiting on ${platformLabel(activeFilter)}`,
    subtitle: totalWaiting === 0
      ? "All conversations are either claimed or handled by auto-reply."
      : "Other platforms still have conversations waiting.",
  };
}
