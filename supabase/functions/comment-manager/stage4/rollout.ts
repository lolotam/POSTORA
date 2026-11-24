// The rollout capability evaluator for Stage 4.
//
// It is a thin adapter over the two SQL functions:
//   youtube_comments_stage4_rollout_state()       -> the effective state
//   youtube_comments_stage4_capability_status(a)  -> per-capability decisions
//
// The SQL is the authority. This module never decides membership from a
// copied array, and it never caches the decision beyond the request.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import type { Stage4Capability, Stage4CapabilitiesPayload, Stage4Reason } from "./contracts.ts";

export interface RolloutAccountResult {
  capabilities: Record<Stage4Capability, { allowed: boolean; reason: Stage4Reason | null }>;
}

/** The rollout settings could not be read at all (RPC error or empty answer). */
export class SettingsReadError extends Error {
  constructor() {
    super("stage4 rollout settings unreadable");
    this.name = "SettingsReadError";
  }
}

/**
 * Per-capability decisions for one account. A failed read THROWS
 * `SettingsReadError`: it is an error, never a "not allowed" payload that
 * looks like the rollout being off (spec 13). The caller maps it to the
 * `upstream` refusal.
 */
export async function readCapabilities(
  admin: SupabaseClient,
  accountId: string,
): Promise<RolloutAccountResult> {
  const { data, error } = await admin.rpc("youtube_comments_stage4_capability_status", {
    p_account_id: accountId,
  });
  if (error || !data) throw new SettingsReadError();
  const caps: Record<Stage4Capability, { allowed: boolean; reason: Stage4Reason | null }> = {
    read: { allowed: false, reason: null },
    held: { allowed: false, reason: null },
    write: { allowed: false, reason: null },
    ban: { allowed: false, reason: null },
  };
  for (const c of ["read", "held", "write", "ban"] as Stage4Capability[]) {
    const entry = data[c];
    caps[c] = {
      allowed: entry?.allowed === true,
      reason: entry?.reason ?? null,
    };
  }
  return { capabilities: caps };
}

/** Whether the capability is admitted; throws `SettingsReadError` when the setting cannot be read. */
export async function admitsCapability(
  admin: SupabaseClient,
  accountId: string,
  capability: Stage4Capability,
): Promise<boolean> {
  const { data, error } = await admin.rpc("youtube_comments_stage4_admits", {
    p_account_id: accountId,
    p_capability: capability,
  });
  // An RPC error is NOT "no": it is an unreadable setting.
  if (error) throw new SettingsReadError();
  return data === true;
}
