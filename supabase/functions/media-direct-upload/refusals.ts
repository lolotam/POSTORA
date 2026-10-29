/**
 * Fail-closed reads and logged refusals for media-direct-upload.
 *
 * Kept apart from index.ts so they can be tested without a running server.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { restrictedJsonResponse } from "../_shared/cors.ts";
import { logToDatabase } from "../_shared/logging.ts";
import { parseUploadLimits, type UploadLimits } from "../_shared/mediaTypes.ts";

/**
 * The admin's choice from Settings → Media upload limits. Defaults apply only when the row
 * is absent; a failed read returns null, so an admin's lower cap is never silently lifted.
 */
export async function readUploadLimits(adminDb: SupabaseClient): Promise<UploadLimits | null> {
  const { data, error } = await adminDb.from("app_settings").select("value").eq("key", "media_upload_limits").maybeSingle();
  if (error) return null;
  return parseUploadLimits(data?.value);
}

export interface Refusal {
  status: number;
  reason: string;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

/** Every refusal leaves a system_logs row (AGENTS.md rule 4); never signatures, tokens or URLs. */
export async function refuse(
  req: Request,
  adminDb: SupabaseClient | null,
  userId: string | null,
  refusal: Refusal,
  log: typeof logToDatabase = logToDatabase,
): Promise<Response> {
  console.warn(`[media-direct-upload] refused (${refusal.status}): ${refusal.reason}`);
  if (adminDb) {
    await log(adminDb, {
      level: refusal.status >= 500 ? "error" : "warn",
      category: "edge",
      source: "media-direct-upload",
      message: `Direct upload refused: ${refusal.reason}`,
      user_id: userId ?? undefined,
      metadata: { reason: refusal.reason, status: refusal.status, ...refusal.metadata },
    });
  }
  const response = restrictedJsonResponse(req, refusal.body, refusal.status);
  for (const [name, value] of Object.entries(refusal.headers ?? {})) response.headers.set(name, value);
  return response;
}
