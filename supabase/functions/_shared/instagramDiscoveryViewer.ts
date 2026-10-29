/**
 * Canonical viewer selection for Instagram Business Discovery API.
 * Sourced from spec §R0.1 (`docs/specs/2026-10-26-instagram-insights-and-competitor-tracking.md`).
 *
 * Used by `brand-scrape` and `competitor-snapshot-sync` to find the best
 * page-linked Instagram account owned by the user that can execute
 * Business Discovery queries on third-party competitor handles.
 */

import { isDirectInstagramAccount } from "./messengerCredentials.ts";

export interface ViewerCandidate {
  id: string;
  user_id: string;
  platform: string;
  platform_user_id: string;
  access_token: string;
  is_active: boolean;
  needs_reauth?: boolean | null;
  ig_auth_type?: string | null;
  account_metadata?: Record<string, unknown> | null;
  connected_at?: string | null;
}

export function pickBusinessDiscoveryViewer(accounts: ViewerCandidate[]): ViewerCandidate | null {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return null;
  }

  const validCandidates: { candidate: ViewerCandidate; priority: number; connectedTime: number }[] = [];

  for (const acc of accounts) {
    // 1. Must be active Instagram account
    if (acc.platform !== "instagram" || !acc.is_active) {
      continue;
    }

    // 2. Needs reauth must not be true
    if (acc.needs_reauth === true) {
      continue;
    }

    // 3. Must not be direct Instagram login (Business Discovery requires Facebook page-linked token)
    if (isDirectInstagramAccount(acc)) {
      continue;
    }

    // 4. Must have access token and platform_user_id
    if (!acc.access_token || !acc.platform_user_id) {
      continue;
    }

    // 5. Inspect granted_scopes
    const meta = acc.account_metadata ?? {};
    const scopes = meta.granted_scopes;

    let priority = 2; // Default: unknown scopes

    if (Array.isArray(scopes)) {
      if (scopes.includes("instagram_manage_insights")) {
        priority = 1; // Preferred: explicitly granted
      } else {
        // Explicitly lacks required scope -> reject completely
        continue;
      }
    }

    const connectedTime = acc.connected_at ? new Date(acc.connected_at).getTime() : 0;

    validCandidates.push({
      candidate: acc,
      priority,
      connectedTime: Number.isFinite(connectedTime) ? connectedTime : 0,
    });
  }

  if (validCandidates.length === 0) {
    return null;
  }

  // Sort by priority (1 before 2), then tie-break by newest connected_at
  validCandidates.sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return b.connectedTime - a.connectedTime;
  });

  return validCandidates[0].candidate;
}
