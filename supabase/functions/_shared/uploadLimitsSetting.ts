/** The admin's upload limits from app_settings `media_upload_limits`, read fail-closed. */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parseUploadLimits, type UploadLimits } from "./mediaTypes.ts";

/**
 * The admin's choice from Settings → Media upload limits. Defaults apply only when the row
 * is absent; a failed read returns null, so an admin's lower cap is never silently lifted.
 */
export async function readUploadLimits(adminDb: SupabaseClient): Promise<UploadLimits | null> {
  const { data, error } = await adminDb.from("app_settings").select("value").eq("key", "media_upload_limits").maybeSingle();
  if (error) return null;
  return parseUploadLimits(data?.value);
}
