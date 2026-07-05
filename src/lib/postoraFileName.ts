import { supabase } from "@/integrations/supabase/client";

/**
 * Builds the Postora media file name: postora_<YYYY-MM-DD>_<userId>_<seq>.<ext>
 *
 * The sequence number is allocated atomically per user per day via the
 * next_media_seq database function; if that call fails the current timestamp
 * is used instead so uploads never block on naming.
 */
export async function buildPostoraFileName(userId: string, ext: string): Promise<string> {
  const date = new Date().toISOString().slice(0, 10);
  const { data: seq, error } = await supabase.rpc("next_media_seq", {
    p_user_id: userId,
    p_upload_date: date,
  });
  const sequencePart = error || seq == null ? Date.now() : seq;
  return `postora_${date}_${userId}_${sequencePart}.${ext}`;
}
