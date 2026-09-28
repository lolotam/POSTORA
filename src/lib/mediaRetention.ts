import { supabase } from "@/integrations/supabase/client";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days until `expiresAt`, rounded up. Already past is 0. */
export function daysUntilDeletion(expiresAt: string, now: Date): number {
  const delta = new Date(expiresAt).getTime() - now.getTime();
  if (!Number.isFinite(delta)) return 0;
  return Math.max(0, Math.ceil(delta / DAY_MS));
}

/** Red at one day or less. Longer warnings stay amber. */
export function retentionBadgeTone(days: number): "amber" | "red" {
  return days <= 1 ? "red" : "amber";
}

/** What the library may claim about the server delete switch. A failed read stays unknown. */
export type DeleteEnabledReading = true | false | "unknown";

export function readDeleteEnabled(result: {
  error: unknown;
  data: { delete_enabled?: boolean | null } | null;
}): DeleteEnabledReading {
  if (result.error || !result.data || typeof result.data.delete_enabled !== "boolean") return "unknown";
  return result.data.delete_enabled;
}

/** Fewer updated rows than requested is a partial keep, including a count of zero. */
export function keepUpdateNotice(requested: number, updated: number): "success" | "partial" {
  return updated < requested ? "partial" : "success";
}

export async function setMediaKeep(
  ids: string[],
  keep: boolean,
): Promise<{ error: string | null; updated: number }> {
  if (ids.length === 0) return { error: null, updated: 0 };
  const { data, error } = await supabase.rpc("media_set_keep", { p_ids: ids, p_keep: keep });
  if (error) return { error: "keep failed", updated: 0 };
  return { error: null, updated: typeof data === "number" ? data : 0 };
}
