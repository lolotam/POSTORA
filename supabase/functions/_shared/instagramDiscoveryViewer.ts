/**
 * Canonical viewer selection for Instagram Business Discovery API.
 * Sourced from spec §R0.1 (`docs/specs/2026-10-26-instagram-insights-and-competitor-tracking.md`).
 *
 * Used by `brand-scrape` and `competitor-snapshot-sync` to find the best
 * page-linked Instagram account owned by the user that can execute
 * Business Discovery queries on third-party competitor handles.
 */

import type { InstagramAccountCapability } from "./facebookUserCredentialStore.ts";

export interface ViewerCandidate {
  id: string;
  user_id: string;
  platform: string;
  platform_user_id: string;
  access_token: string;
  platform_username?: string | null;
  is_active: boolean;
  needs_reauth?: boolean | null;
  ig_auth_type?: string | null;
  account_metadata?: Record<string, unknown> | null;
  connected_at?: string | null;
  /** Service-only capability read. Legacy metadata is never authoritative. */
  capability?: InstagramAccountCapability;
}

export function isBusinessDiscoveryViewerCandidate(acc: ViewerCandidate): boolean {
  // 1. Must be active Instagram account
  if (acc.platform !== "instagram" || !acc.is_active) {
    return false;
  }

  // 2. Needs reauth must not be true
  if (acc.needs_reauth === true) {
    return false;
  }

  // 3. Must not be direct Instagram login (Business Discovery requires Facebook Login on a page-linked account)
  if (acc.capability?.loginKind === "direct" ||
    (acc.ig_auth_type && !["facebook_page", "facebook_business"].includes(acc.ig_auth_type))) {
    return false;
  }

  // 4. The protected adapter supplies the token after selection.
  if (!acc.platform_user_id) {
    return false;
  }
  return true;
}

export function pickBusinessDiscoveryViewer(accounts: ViewerCandidate[]): ViewerCandidate | null {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return null;
  }

  const validCandidates: { candidate: ViewerCandidate; priority: number; connectedTime: number }[] = [];

  for (const acc of accounts) {
    if (!isBusinessDiscoveryViewerCandidate(acc)) continue;

    let priority = 2; // Default: unknown scopes
    const capability = acc.capability;
    if (capability?.permissionReadState === "ok" && capability.scopesAuthoritative) {
      if (capability.grantedScopes.includes("instagram_manage_insights")) {
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
    return b.connectedTime - a.connectedTime || a.candidate.id.localeCompare(b.candidate.id);
  });

  return validCandidates[0].candidate;
}
