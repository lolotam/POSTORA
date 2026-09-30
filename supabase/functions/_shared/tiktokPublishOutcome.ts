/**
 * Reconciles a TikTok Content Posting outcome onto platform_posts.
 *
 * Webhooks and the status reader both call this. Terminal writes go through
 * partner_settle_platform_post so posts.status and partner webhooks stay in
 * one place. A failed read throws; it is never reported as "unmatched".
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

export type TikTokOutcome =
  | { kind: "published"; providerPostId: string | null }
  | { kind: "failed"; reason: string };

export type ApplyOutcomeResult = "applied" | "already_terminal" | "unmatched";

type AccountRow = {
  platform_user_id: string | null;
  platform_username: string | null;
  account_metadata: Record<string, unknown> | null;
};

type PlatformPostMatch = {
  id: string;
  post_id: string;
  social_account_id: string;
  status: string;
  platform_post_url: string | null;
  social_accounts: AccountRow | AccountRow[] | null;
};

function accountOf(row: PlatformPostMatch): AccountRow | null {
  const joined = row.social_accounts;
  if (Array.isArray(joined)) return joined[0] ?? null;
  return joined;
}

function publicHandle(account: AccountRow): string {
  const fromMetadata = account.account_metadata?.tiktok_username;
  const raw = typeof fromMetadata === "string" && fromMetadata.length > 0
    ? fromMetadata
    : (account.platform_username ?? "");
  return raw.startsWith("@") ? raw.slice(1) : raw;
}

function providerPostUrl(providerPostId: string | null, handle: string): string | null {
  if (!providerPostId) return null;
  return `https://www.tiktok.com/@${handle}/video/${providerPostId}`;
}

function contradicts(status: string, outcome: TikTokOutcome): boolean {
  return (status === "success" && outcome.kind === "failed") ||
    (status === "failed" && outcome.kind === "published");
}

async function fillPublishedUrl(
  admin: SupabaseClient,
  rowId: string,
  providerPostId: string,
  url: string,
): Promise<void> {
  const { error } = await admin
    .from("platform_posts")
    .update({
      platform_post_id: providerPostId,
      platform_post_url: url,
    })
    .eq("id", rowId)
    .is("platform_post_url", null);
  if (error) throw new Error("tiktok_outcome_url_update_failed");
}

async function settleRow(
  admin: SupabaseClient,
  row: PlatformPostMatch,
  outcome: TikTokOutcome,
  url: string | null,
): Promise<"applied" | "already_terminal"> {
  const providerPostId = outcome.kind === "published" ? outcome.providerPostId : null;
  const { data, error } = await admin.rpc("partner_settle_platform_post", {
    p_platform_post_id: row.id,
    p_post_id: row.post_id,
    p_social_account_id: row.social_account_id,
    p_platform: "tiktok",
    p_status: outcome.kind === "published" ? "success" : "failed",
    p_provider_post_id: providerPostId,
    p_provider_post_url: outcome.kind === "published" ? url : null,
    p_error_message: outcome.kind === "failed"
      ? `TikTok publish failed: ${outcome.reason}`
      : null,
    p_response_data: null,
  });
  if (error) throw new Error("tiktok_outcome_settle_failed");

  const reason = typeof data === "object" && data !== null && "reason" in data
    ? (data as { reason?: unknown }).reason
    : null;
  if (reason === "already terminal") return "already_terminal";
  return "applied";
}

export async function applyTikTokPublishOutcome(
  admin: SupabaseClient,
  input: { publishId: string; userOpenId: string | null; outcome: TikTokOutcome },
): Promise<ApplyOutcomeResult> {
  const { data, error } = await admin
    .from("platform_posts")
    .select(
      "id, post_id, social_account_id, status, platform_post_url, social_accounts!inner(platform_user_id, platform_username, account_metadata)",
    )
    .eq("platform", "tiktok")
    .eq("response_data->>tiktok_publish_id", input.publishId);
  if (error) throw new Error("tiktok_outcome_read_failed");

  const rows = (data ?? []) as PlatformPostMatch[];
  if (rows.length === 0) return "unmatched";

  let sawApplied = false;
  let sawTerminal = false;
  let sawOwned = false;

  for (const row of rows) {
    const account = accountOf(row);
    if (!account) continue;
    if (input.userOpenId !== null && input.userOpenId !== account.platform_user_id) {
      console.error(JSON.stringify({
        event: "tiktok_openid_mismatch",
        publish_id: input.publishId,
      }));
      continue;
    }

    sawOwned = true;
    const handle = publicHandle(account);
    const providerPostId = input.outcome.kind === "published"
      ? input.outcome.providerPostId
      : null;
    const url = providerPostUrl(providerPostId, handle);

    if (row.status === "pending") {
      const settled = await settleRow(admin, row, input.outcome, url);
      if (settled === "applied") sawApplied = true;
      else sawTerminal = true;
      continue;
    }

    if (
      row.status === "success" &&
      input.outcome.kind === "published" &&
      providerPostId &&
      url &&
      row.platform_post_url === null
    ) {
      await fillPublishedUrl(admin, row.id, providerPostId, url);
      sawTerminal = true;
      continue;
    }

    if (contradicts(row.status, input.outcome)) {
      console.error(JSON.stringify({
        event: "tiktok_outcome_conflict",
        publish_id: input.publishId,
        status: row.status,
        outcome: input.outcome.kind,
      }));
    }
    sawTerminal = true;
  }

  if (!sawOwned) return "unmatched";
  if (sawApplied) return "applied";
  if (sawTerminal) return "already_terminal";
  return "unmatched";
}

type WebhookEventRow = {
  id: number;
  event: string;
  user_openid: string | null;
  provider_post_id: string | null;
  reason: string | null;
};

function terminalOutcome(row: WebhookEventRow): TikTokOutcome | null {
  if (row.event === "post.publish.complete") {
    return { kind: "published", providerPostId: null };
  }
  if (row.event === "post.publish.publicly_available") {
    return { kind: "published", providerPostId: row.provider_post_id };
  }
  if (row.event === "post.publish.failed") {
    const reason = typeof row.reason === "string" && row.reason.length > 0
      ? row.reason
      : "unknown";
    return { kind: "failed", reason };
  }
  return null;
}

export async function applyPendingWebhookEvents(
  admin: SupabaseClient,
  publishId: string,
): Promise<ApplyOutcomeResult | "none"> {
  const { data, error } = await admin
    .from("tiktok_webhook_events")
    .select("id, event, user_openid, provider_post_id, reason, create_time")
    .eq("publish_id", publishId)
    .is("applied_at", null)
    .order("create_time", { ascending: true });
  if (error) throw new Error("tiktok_webhook_events_read_failed");

  const rows = (data ?? []) as WebhookEventRow[];
  if (rows.length === 0) return "none";

  let last: ApplyOutcomeResult | null = null;
  for (const row of rows) {
    const outcome = terminalOutcome(row);
    if (!outcome) continue;
    const userOpenId = typeof row.user_openid === "string" ? row.user_openid : null;
    last = await applyTikTokPublishOutcome(admin, {
      publishId,
      userOpenId,
      outcome,
    });
    if (last === "applied" || last === "already_terminal") {
      const { error: markError } = await admin
        .from("tiktok_webhook_events")
        .update({ applied_at: new Date().toISOString() })
        .eq("id", row.id);
      if (markError) throw new Error("tiktok_webhook_events_mark_failed");
    }
  }

  return last ?? "none";
}
