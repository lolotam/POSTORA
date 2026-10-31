import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

export interface ThreadsCapabilities {
  connected: boolean;
  username: string | null;
  canPublish: boolean;
  // null = unknown (probe was inconclusive); false = verified missing; true = verified available
  canViewInsights: boolean | null;
  canUseDiscovery: boolean | null;
  canUseKeywordSearch: boolean | null;
  canCrossShareToIg: boolean | null;
  canUseLocationTagging: boolean | null;
  canDeleteThreadsPosts: boolean | null;
  grantedScopes: string[];
  probedAt: string | null;
}

const DEFAULT: ThreadsCapabilities = {
  connected: false,
  username: null,
  canPublish: false,
  canViewInsights: null,
  canUseDiscovery: null,
  canUseKeywordSearch: null,
  canCrossShareToIg: null,
  canUseLocationTagging: null,
  canDeleteThreadsPosts: null,
  grantedScopes: [],
  probedAt: null,
};

/** The account_metadata keys the capability probe writes for a Threads account. */
type ThreadsAccountMetadata = {
  capabilities?: {
    canPublish?: boolean;
    canViewInsights?: unknown;
    canUseDiscovery?: unknown;
    canUseKeywordSearch?: unknown;
    canCrossShareToIg?: unknown;
    canUseLocationTagging?: unknown;
    canDeleteThreadsPosts?: unknown;
  };
  granted_scopes?: string[];
  capability_probed_at?: string | null;
};

function tri(val: unknown): boolean | null {
  if (val === true) return true;
  if (val === false) return false;
  return null;
}

/**
 * Read Threads capability flags for the current user.
 * If `accountId` is provided, reads that specific account's caps.
 * Otherwise falls back to the most-recently-connected active Threads account.
 */
export function useThreadsCapabilities(accountId?: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["threads-capabilities", user?.id, accountId ?? "latest"],
    enabled: !!user?.id,
    queryFn: async (): Promise<ThreadsCapabilities> => {
      let query = supabase
        .from("social_accounts")
        .select("platform_username, account_metadata")
        .eq("user_id", user!.id)
        .eq("platform", "threads")
        .eq("is_active", true);

      if (accountId) {
        query = query.eq("id", accountId);
      } else {
        query = query.order("connected_at", { ascending: false, nullsFirst: false }).limit(1);
      }

      const { data } = await query.maybeSingle();

      if (!data) return DEFAULT;

      const meta: ThreadsAccountMetadata = (data.account_metadata as ThreadsAccountMetadata) || {};
      const caps = meta.capabilities || {};
      return {
        connected: true,
        username: data.platform_username,
        canPublish: caps.canPublish ?? true,
        canViewInsights: tri(caps.canViewInsights),
        canUseDiscovery: tri(caps.canUseDiscovery),
        canUseKeywordSearch: tri(caps.canUseKeywordSearch),
        canCrossShareToIg: tri(caps.canCrossShareToIg),
        canUseLocationTagging: tri(caps.canUseLocationTagging),
        canDeleteThreadsPosts: tri(caps.canDeleteThreadsPosts),
        grantedScopes: meta.granted_scopes || [],
        probedAt: meta.capability_probed_at || null,
      };
    },
  });
}
