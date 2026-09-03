import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import {
  fetchAccountWorkspaceId,
  fetchPersonalWorkspaceId,
} from "../../infrastructure/connectorsApi";

export interface ConnectorWorkspace {
  /** Null while resolving, and also when the selected account belongs to no
   *  workspace — callers distinguish the two with `isLoading`. */
  workspaceId: string | null;
  isLoading: boolean;
  error: Error | null;
}

/**
 * Which workspace a connectors surface belongs to: the selected account's
 * workspace when the surface has an account, otherwise the signed-in user's
 * personal workspace. The account branch never falls back to the personal
 * workspace — an account with no workspace must say so (plan Task 1), not
 * quietly write connections somewhere else.
 */
export function useConnectorWorkspace(accountId: string | null): ConnectorWorkspace {
  const userId = useAuth().user?.id ?? null;
  const query = useQuery({
    queryKey: ["connectors", "workspace", accountId ?? `personal:${userId ?? ""}`],
    queryFn: () =>
      accountId !== null
        ? fetchAccountWorkspaceId(accountId)
        : fetchPersonalWorkspaceId(userId as string),
    enabled: accountId !== null || userId !== null,
  });

  return {
    workspaceId: query.data ?? null,
    isLoading: query.isLoading && query.fetchStatus !== "idle",
    error: (query.error as Error | null) ?? null,
  };
}
