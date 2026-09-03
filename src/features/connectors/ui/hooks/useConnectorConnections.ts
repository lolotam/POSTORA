import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchConnections,
  initiateConnection,
  revokeConnection,
  type InitiateConnectionInput,
} from "../../infrastructure/connectorsApi";

const ROOT = ["connectors"] as const;

/** Omitting the workspace yields the prefix every workspace's entry shares —
 *  what a mutation invalidates when it cannot know which one changed. */
export const connectorKeys = {
  connections: (workspaceId?: string): readonly unknown[] =>
    workspaceId === undefined ? [...ROOT, "connections"] : [...ROOT, "connections", workspaceId],
  usage: (workspaceId?: string, days?: number): readonly unknown[] =>
    workspaceId === undefined ? [...ROOT, "usage"] : [...ROOT, "usage", workspaceId, days],
};

/** A workspace's Composio connections. Idle until the workspace is known —
 *  an unresolved workspace is not an empty one. */
export function useConnectorConnections(workspaceId: string | null) {
  return useQuery({
    queryKey: connectorKeys.connections(workspaceId ?? ""),
    queryFn: () => fetchConnections(workspaceId as string),
    enabled: workspaceId !== null,
  });
}

function useConnectorInvalidation() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: connectorKeys.connections() });
    queryClient.invalidateQueries({ queryKey: connectorKeys.usage() });
  };
}

export function useInitiateConnection() {
  const invalidate = useConnectorInvalidation();
  return useMutation({
    mutationFn: (input: InitiateConnectionInput) => initiateConnection(input),
    onSuccess: invalidate,
  });
}

export function useRevokeConnection() {
  const invalidate = useConnectorInvalidation();
  return useMutation({
    mutationFn: (connectionId: string) => revokeConnection(connectionId),
    onSuccess: invalidate,
  });
}
