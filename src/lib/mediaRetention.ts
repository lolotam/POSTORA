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

export async function setMediaKeep(ids: string[], keep: boolean): Promise<{ error: string | null }> {
  if (ids.length === 0) return { error: null };
  const { error } = await supabase.rpc("media_set_keep", { p_ids: ids, p_keep: keep });
  return { error: error ? "keep failed" : null };
}
