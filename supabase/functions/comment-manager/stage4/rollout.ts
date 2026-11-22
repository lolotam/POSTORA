// The rollout capability evaluator for Stage 4.
//
// It is a thin adapter over the two SQL functions:
//   youtube_comments_stage4_rollout_state()       -> the effective state
//   youtube_comments_stage4_capability_status(a)  -> per-capability decisions
//
// The SQL is the authority. This module never decides membership from a
// copied array, and it never caches the decision beyond the request.

import type { Stage4Capability, Stage4CapabilitiesPayload, Stage4Reason } from "./contracts.ts";

export interface RolloutAccountResult {
  capabilities: Record<Stage4Capability, { allowed: boolean; reason: Stage4Reason | null }>;
}

export async function readCapabilities(
  admin: any,
  accountId: string,
): Promise<RolloutAccountResult> {
  const { data, error } = await admin.rpc("youtube_comments_stage4_capability_status", {
    p_account_id: accountId,
  });
  if (error || !data) {
    // A failed read is an error, never a deny that looks like "off". Surface
    // it as a settings_unavailable refusal.
    return {
      capabilities: {
        read: { allowed: false, reason: "settings_unavailable" },
        held: { allowed: false, reason: "settings_unavailable" },
        write: { allowed: false, reason: "settings_unavailable" },
        ban: { allowed: false, reason: "settings_unavailable" },
      },
    };
  }
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

export async function admitsCapability(
  admin: any,
  accountId: string,
  capability: Stage4Capability,
): Promise<boolean> {
  const { data, error } = await admin.rpc("youtube_comments_stage4_admits", {
    p_account_id: accountId,
    p_capability: capability,
  });
  if (error) return false;
  return data === true;
}
