/** The admin-selected upload limits in app_settings `media_upload_limits`. */

import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { parseUploadLimits, type UploadLimits } from "@/lib/mediaTypes";

const LIMITS_KEY = "media_upload_limits";

/** Readable by every signed-in user; a missing or malformed row reads as the defaults. */
export async function fetchUploadLimits(): Promise<UploadLimits> {
  const { data, error } = await supabase.from("app_settings").select("value").eq("key", LIMITS_KEY).maybeSingle();
  if (error) throw error;
  return parseUploadLimits(data?.value);
}

/** Admin only: RLS refuses anyone else. */
export async function saveUploadLimits(limits: UploadLimits): Promise<void> {
  const { image_max_mb, video_max_mb } = parseUploadLimits(limits);
  const value: Json = { image_max_mb, video_max_mb };
  const { error } = await supabase
    .from("app_settings")
    .upsert({ key: LIMITS_KEY, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw error;
}
