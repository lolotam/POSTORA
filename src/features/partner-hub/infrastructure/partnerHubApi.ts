import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { generatePartnerKey, type PartnerEnvironment } from "../domain/partnerKeyMint";

/**
 * Supabase adapters for the Admin Partner Hub. Every read is an admin-gated
 * SECURITY DEFINER RPC (migration 20260902200000); a refused read raises in
 * SQL and is rethrown here — a failed read must never look like an empty one.
 */

type Fns = Database["public"]["Functions"];
export type PartnerHubOverview = Fns["admin_partner_hub_overview"]["Returns"][number];
export type PartnerKeyRow = Fns["admin_partner_keys"]["Returns"][number];
export type PartnerKeyTarget = Fns["admin_partner_key_targets"]["Returns"][number];
export type PartnerKeyActivityRow = Fns["admin_partner_key_activity"]["Returns"][number];
export type PartnerWebhookDeliveryRow = Fns["admin_partner_key_webhook_deliveries"]["Returns"][number];

export async function fetchOverview(): Promise<PartnerHubOverview> {
  const { data, error } = await supabase.rpc("admin_partner_hub_overview");
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("admin_partner_hub_overview returned no row");
  return row as PartnerHubOverview;
}

export async function fetchKeys(): Promise<PartnerKeyRow[]> {
  const { data, error } = await supabase.rpc("admin_partner_keys");
  if (error) throw error;
  return (data ?? []) as PartnerKeyRow[];
}

export async function fetchTargets(): Promise<PartnerKeyTarget[]> {
  const { data, error } = await supabase.rpc("admin_partner_key_targets");
  if (error) throw error;
  return (data ?? []) as PartnerKeyTarget[];
}

export async function fetchKeyActivity(keyId: string, limit = 50): Promise<PartnerKeyActivityRow[]> {
  const { data, error } = await supabase.rpc("admin_partner_key_activity", { p_key_id: keyId, p_limit: limit });
  if (error) throw error;
  return (data ?? []) as PartnerKeyActivityRow[];
}

export async function fetchKeyDeliveries(keyId: string, limit = 50): Promise<PartnerWebhookDeliveryRow[]> {
  const { data, error } = await supabase.rpc("admin_partner_key_webhook_deliveries", { p_key_id: keyId, p_limit: limit });
  if (error) throw error;
  return (data ?? []) as PartnerWebhookDeliveryRow[];
}

export interface CreatePartnerKeyInput {
  name: string;
  workspaceId: string;
  socialAccountId: string;
  environment: PartnerEnvironment;
  scopes: string[];
  /** null = unlimited */
  monthlyQuota: number | null;
  rateLimitPerMin: number;
}

export interface CreatedPartnerKey {
  id: string;
  /** Plaintext. Exists only in the caller's memory; never persisted or logged. */
  key: string;
  prefix: string;
  createdAt: string;
}

/**
 * Mint in the browser, store only the digest (spec D3). The RPC runs under
 * the admin's JWT so created_by and the audit actor are the administrator.
 */
export async function createPartnerKey(input: CreatePartnerKeyInput): Promise<CreatedPartnerKey> {
  const minted = await generatePartnerKey(input.environment);
  const { data, error } = await supabase.rpc("create_partner_key", {
    p_workspace_id: input.workspaceId,
    p_social_account_id: input.socialAccountId,
    p_name: input.name,
    p_key_prefix: minted.prefix,
    p_key_hash: minted.hash,
    p_scopes: input.scopes,
    p_rate_limit_per_min: input.rateLimitPerMin,
    p_monthly_quota: input.monthlyQuota,
    p_environment: input.environment,
  });
  if (error) throw error;
  return { id: data as string, key: minted.key, prefix: minted.prefix, createdAt: new Date().toISOString() };
}

/** One-way. The RPC returns false when nothing changed (already revoked, or
 *  not permitted); that is a failure to the caller, not a silent success. */
export async function revokePartnerKey(keyId: string, reason: string): Promise<void> {
  const { data, error } = await supabase.rpc("revoke_partner_key", { p_key_id: keyId, p_reason: reason });
  if (error) throw error;
  if (data !== true) throw new Error("Key was not revoked (already revoked or not permitted)");
}

/**
 * Connector reads for the Hub (migration 20260903120000). Same rule as every
 * other reader here: a refused or failed read raises, so it can never be
 * mistaken for "this platform has no connector traffic".
 */

export type ConnectorOverview = Fns["admin_connector_overview"]["Returns"][number];
export type ConnectorUsageByTypeRow = Fns["admin_connector_usage_by_type"]["Returns"][number];
export type ConnectorUsageByKeyRow = Fns["admin_connector_usage_by_key"]["Returns"][number];
export type AdminConnectorConnectionRow = Fns["admin_connector_connections"]["Returns"][number];
export type KeyConnectorActivityRow = Fns["admin_partner_key_connector_activity"]["Returns"][number];

export async function fetchConnectorOverview(): Promise<ConnectorOverview> {
  const { data, error } = await supabase.rpc("admin_connector_overview");
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("admin_connector_overview returned no row");
  return row as ConnectorOverview;
}

export async function fetchConnectorUsageByType(days = 30): Promise<ConnectorUsageByTypeRow[]> {
  const { data, error } = await supabase.rpc("admin_connector_usage_by_type", { p_days: days });
  if (error) throw error;
  return (data ?? []) as ConnectorUsageByTypeRow[];
}

export async function fetchConnectorUsageByKey(days = 30): Promise<ConnectorUsageByKeyRow[]> {
  const { data, error } = await supabase.rpc("admin_connector_usage_by_key", { p_days: days });
  if (error) throw error;
  return (data ?? []) as ConnectorUsageByKeyRow[];
}

export async function fetchConnectorConnections(workspaceId?: string | null): Promise<AdminConnectorConnectionRow[]> {
  const { data, error } = await supabase.rpc("admin_connector_connections", {
    p_workspace_id: workspaceId ?? null,
  });
  if (error) throw error;
  return (data ?? []) as AdminConnectorConnectionRow[];
}

export async function fetchKeyConnectorActivity(keyId: string, limit = 50): Promise<KeyConnectorActivityRow[]> {
  const { data, error } = await supabase.rpc("admin_partner_key_connector_activity", {
    p_key_id: keyId,
    p_limit: limit,
  });
  if (error) throw error;
  return (data ?? []) as KeyConnectorActivityRow[];
}

/** One-way, and run under the administrator's own JWT so the RPC's admin gate
 *  and the audit actor are both the person who clicked. */
export async function revokeConnection(connectionId: string): Promise<void> {
  const { error } = await supabase.rpc("revoke_connector_connection", { p_connection_id: connectionId });
  if (error) throw error;
}
