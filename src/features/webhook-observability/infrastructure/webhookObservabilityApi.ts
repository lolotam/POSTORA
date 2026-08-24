import { supabase } from "@/integrations/supabase/client";

/**
 * Supabase adapters for the webhook observability feature.
 *
 * All three reads go through RPCs rather than table selects. For subscriptions that is a
 * security requirement, not a preference: the n8n registry lives in `app_settings` rows
 * whose jsonb value also holds `webhook_secret`, and RLS is row-level, so no policy could
 * expose the row while hiding the secret. The function projects explicitly instead.
 */

export interface WebhookSubscription {
  /** 'n8n' for the app_settings registry, 'legacy' for whatsapp_webhooks. */
  registry: string;
  webhook_id: string;
  webhook_url: string;
  events: string[] | null;
  platform: string | null;
  social_account_id: string | null;
  is_active: boolean;
  failure_count: number;
  created_at: string | null;
}

export interface InboundActivity {
  social_account_id: string;
  last_event_at: string;
  events_7d: number;
}

export interface UnmatchedObservationRow {
  id: string;
  platform: string;
  recipient_id: string;
  event_kind: string;
  reason: string;
  observed_on: string;
  first_seen_at: string;
  last_seen_at: string;
  attempts: number;
  social_account_id: string | null;
  user_id: string | null;
}

export async function fetchWebhookSubscriptions(): Promise<WebhookSubscription[]> {
  const { data, error } = await supabase.rpc("list_my_webhook_subscriptions");
  if (error) throw error;
  return (data ?? []) as WebhookSubscription[];
}

/**
 * Last inbound event per account, keyed by social_account_id.
 *
 * Returned as a Map because every consumer looks accounts up one at a time, and an
 * account missing from the map is meaningful: it has never received an inbound event,
 * which is the headline diagnostic rather than an absence to paper over.
 */
export async function fetchInboundActivity(): Promise<Map<string, InboundActivity>> {
  const { data, error } = await supabase.rpc("social_account_inbound_activity");
  if (error) throw error;
  return new Map((data ?? []).map((row) => [row.social_account_id, row as InboundActivity]));
}

/** Admin-only: RLS returns nothing to a non-admin rather than erroring. */
export async function fetchUnmatchedObservations(limit = 100): Promise<UnmatchedObservationRow[]> {
  const { data, error } = await supabase
    .from("webhook_unmatched_observations")
    .select("id, platform, recipient_id, event_kind, reason, observed_on, first_seen_at, last_seen_at, attempts, social_account_id, user_id")
    .order("last_seen_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as UnmatchedObservationRow[];
}
