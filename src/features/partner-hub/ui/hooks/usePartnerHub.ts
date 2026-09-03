import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createPartnerKey,
  fetchKeyActivity,
  fetchKeyDeliveries,
  fetchKeys,
  fetchOverview,
  fetchTargets,
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
