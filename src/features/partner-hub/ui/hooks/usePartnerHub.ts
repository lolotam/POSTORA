import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createPartnerKey,
  fetchConnectorConnections,
  fetchConnectorOverview,
  fetchConnectorUsageByKey,
  fetchConnectorUsageByType,
  fetchKeyActivity,
  fetchKeyConnectorActivity,
  fetchKeyDeliveries,
  fetchKeys,
  fetchOverview,
  fetchTargets,
  revokeConnection,
  revokePartnerKey,
  type CreatePartnerKeyInput,
} from "../../infrastructure/partnerHubApi";

const ROOT = ["admin", "partner-hub"] as const;
export const partnerHubKeys = {
  overview: () => [...ROOT, "overview"] as const,
  keys: () => [...ROOT, "keys"] as const,
  targets: () => [...ROOT, "targets"] as const,
  activity: (keyId: string) => [...ROOT, "activity", keyId] as const,
  deliveries: (keyId: string) => [...ROOT, "deliveries", keyId] as const,
  connectorOverview: () => [...ROOT, "connector-overview"] as const,
  // The window is part of the key so switching 7/30/90 refetches instead of
  // redrawing the previous window's numbers under a new label.
  connectorUsageByType: (days: number) => [...ROOT, "connector-usage-type", days] as const,
  connectorUsageByKey: (days: number) => [...ROOT, "connector-usage-key", days] as const,
  connectorConnections: (workspaceId: string | null) => [...ROOT, "connector-connections", workspaceId] as const,
  keyConnectorActivity: (keyId: string) => [...ROOT, "connector-activity", keyId] as const,
};

export function usePartnerHubOverview() {
  return useQuery({ queryKey: partnerHubKeys.overview(), queryFn: fetchOverview, refetchInterval: 60_000 });
}

export function usePartnerKeys() {
  return useQuery({ queryKey: partnerHubKeys.keys(), queryFn: fetchKeys, refetchInterval: 60_000 });
}

export function usePartnerKeyTargets(enabled: boolean) {
  return useQuery({ queryKey: partnerHubKeys.targets(), queryFn: fetchTargets, enabled });
}

export function usePartnerKeyActivity(keyId: string | null) {
  return useQuery({
    queryKey: partnerHubKeys.activity(keyId ?? ""),
    queryFn: () => fetchKeyActivity(keyId as string),
    enabled: keyId !== null,
    refetchInterval: 15_000,
  });
}

export function usePartnerKeyDeliveries(keyId: string | null) {
  return useQuery({
    queryKey: partnerHubKeys.deliveries(keyId ?? ""),
    queryFn: () => fetchKeyDeliveries(keyId as string),
    enabled: keyId !== null,
    refetchInterval: 15_000,
  });
}

export function useCreatePartnerKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePartnerKeyInput) => createPartnerKey(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: partnerHubKeys.keys() });
      qc.invalidateQueries({ queryKey: partnerHubKeys.overview() });
    },
  });
}

export function useRevokePartnerKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ keyId, reason }: { keyId: string; reason: string }) => revokePartnerKey(keyId, reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: partnerHubKeys.keys() });
      qc.invalidateQueries({ queryKey: partnerHubKeys.overview() });
    },
  });
}

export function useConnectorOverview() {
  return useQuery({ queryKey: partnerHubKeys.connectorOverview(), queryFn: fetchConnectorOverview, refetchInterval: 60_000 });
}

export function useConnectorUsageByType(days: number) {
  return useQuery({
    queryKey: partnerHubKeys.connectorUsageByType(days),
    queryFn: () => fetchConnectorUsageByType(days),
  });
}

export function useConnectorUsageByKey(days: number) {
  return useQuery({
    queryKey: partnerHubKeys.connectorUsageByKey(days),
    queryFn: () => fetchConnectorUsageByKey(days),
  });
}

export function useConnectorConnections(workspaceId: string | null = null) {
  return useQuery({
    queryKey: partnerHubKeys.connectorConnections(workspaceId),
    queryFn: () => fetchConnectorConnections(workspaceId),
  });
}

export function useKeyConnectorActivity(keyId: string | null) {
  return useQuery({
    queryKey: partnerHubKeys.keyConnectorActivity(keyId ?? ""),
    queryFn: () => fetchKeyConnectorActivity(keyId as string),
    enabled: keyId !== null,
    refetchInterval: 15_000,
  });
}

/** Named for the door it uses: the admin RPC, not the workspace owner's
 *  edge-function path in `src/features/connectors`. */
export function useAdminRevokeConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) => revokeConnection(connectionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...ROOT, "connector-connections"] });
      qc.invalidateQueries({ queryKey: partnerHubKeys.connectorOverview() });
    },
  });
}
