// Recovery for AI agent replies whose worker died -- cron-invoked, service role, no user auth.
//
// The webhooks enqueue a work item before they start the ~50s of best-effort background work
// that produces a reply. When that worker is killed (timeout, crash, redeploy) the row's lease
// lapses, and this job picks it up. What it does depends ONLY on the state the row lapsed in:
//
//   pending        nothing external has happened      -> re-invoke the agent
//   running        a tool MAY have fired; unknowable   -> hand to a human, never re-run
//   ready_to_send  text exists, no delivery attempted  -> deliver the stored text
//   sending        an attempt was in flight            -> delivery_unknown, never re-send
//
// Both of the actions that send go through the same door -- a POST to ai-agent-reply carrying
// outbox_id -- so this job holds no transport logic and no second copy of the credential
// resolution. ai-agent-reply reads the row's state and either redelivers or generates.
//
// Rows are claimed ONE AT A TIME, and only when a full row's worth of budget remains. Claiming
// charges an attempt, and a row the deadline cut off would otherwise pay for recovery that
// never happened.
//
// Design: docs/superpowers/plans/2026-08-27-durable-reply-outbox.md, Task 6.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyCronAuth } from "../_shared/cron-auth.ts";
import { advanceReply, type PendingReplyStatus } from "../_shared/pendingReplies.ts";
import type { AgentReplyOutcome } from "../_shared/agentReplyResult.ts";
import { dispatchAgentReply } from "../_shared/agentReplyDispatch.ts";
import { runInboundMediaUnderstanding } from "../_shared/inboundMediaPipeline.ts";
import { MetaMessagingFetcher } from "../_shared/inboundMediaFetchers.ts";
import type { MediaKind } from "../_shared/inboundMediaUnderstanding.ts";
import { noteUnreadAttachments } from "../facebook-instagram-webhook/attachments.ts";
import {
  canStartAnotherRow,
  decideRecovery,
  isOutsideSendWindow,
  RECOVERY_LIMITS,
  type RecoveryAction,
} from "./recovery.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface OutboxRow {
  id: string;
  social_account_id: string;
  user_id: string;
  platform: string;
  message_id: string;
  conversation_id: string;
  recipient_id: string;
  inbound_text: string;
  media_url: string | null;
  media_kind: string | null;
  media_caption: string | null;
  unread_attachments: number;
  language_hint: string | null;
  comment_id: string | null;
  inbound_at: string;
  generated_reply: string | null;
  status: string;
  attempts: number;
}

interface AccountRow {
  id: string;
  user_id: string;
  platform_user_id: string | null;
  connection_mode: string | null;
  access_token: string | null;
  account_metadata: Record<string, unknown> | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Makes a terminal problem visible where a human already looks.
 *
 * pending_agent_replies has deny-all RLS and no UI, so a state that only exists there is not
 * observable by anyone. The customer's owner reads ai_agent_logs (the Logs tab); the operator
 * reads system_logs (/admin/logs). Both get a row.
 */
async function surfaceToHumans(admin: any, row: OutboxRow, status: string, detail: string): Promise<void> {
  const { error } = await admin.from("ai_agent_logs").insert({
    user_id: row.user_id,
    platform: row.platform,
    conversation_id: row.conversation_id,
    inbound_text: row.inbound_text.slice(0, 2000),
    reply_text: row.generated_reply?.slice(0, 4000) ?? null,
    status,
    error: detail.slice(0, 500),
    idempotency_key: row.id,
  });
  if (error) console.error(`[recovery] could not write ai_agent_logs for ${row.id}: ${error.message}`);

  const { error: systemError } = await admin.from("system_logs").insert({
    source: "process-pending-replies",
    category: "ai",
    level: "error",
    message: `AI agent reply ${status} (${row.platform}): ${detail}`,
    user_id: row.user_id,
    metadata: {
      outbox_id: row.id,
      platform: row.platform,
      conversation_id: row.conversation_id,
      status,
      attempts: row.attempts,
    },
  });
  if (systemError) console.error(`[recovery] could not write system_logs for ${row.id}: ${systemError.message}`);
}

/**
 * Hands the conversation to a person.
 *
 * The mode flip is the platform-agnostic core of the escalation path: it is what silences
 * the AI for this conversation from the next inbound message on, and it is the part the
 * outage floor depends on. The WhatsApp-shaped assignment tables and the admin notification
 * need a sender and a tool context this job does not have; the log rows written by the
 * caller are what puts the conversation in front of someone.
 */
async function handToHuman(admin: any, row: OutboxRow): Promise<void> {
  const { error } = await admin.from("ai_conversation_modes").upsert(
    {
      user_id: row.user_id,
      platform: row.platform,
      conversation_id: row.conversation_id,
      mode: "human_first",
    },
    { onConflict: "user_id,platform,conversation_id" },
  );
  if (error) console.error(`[recovery] could not hand ${row.id} to a human: ${error.message}`);
}

async function loadContext(admin: any, row: OutboxRow) {
  const [{ data: modeRow }, { count: newer }] = await Promise.all([
    admin
      .from("ai_conversation_modes")
      .select("mode")
      .eq("user_id", row.user_id)
      .eq("platform", row.platform)
      .eq("conversation_id", row.conversation_id)
      .maybeSingle(),
    admin
      .from("pending_agent_replies")
      .select("id", { count: "exact", head: true })
      .eq("social_account_id", row.social_account_id)
      .eq("conversation_id", row.conversation_id)
      .gt("inbound_at", row.inbound_at)
      .in("status", ["pending", "running", "ready_to_send", "sending"]),
  ]);
  return {
    humanTookOver: modeRow?.mode === "human_first",
    newerPendingInConversation: (newer ?? 0) > 0,
    outsideSendWindow: isOutsideSendWindow(row, Date.now()),
  };
}

async function loadAccount(admin: any, row: OutboxRow): Promise<AccountRow | null> {
  const { data } = await admin
    .from("social_accounts")
    .select("id, user_id, platform_user_id, connection_mode, access_token, account_metadata")
    .eq("id", row.social_account_id)
    .maybeSingle();
  return data ?? null;
}

/**
 * Redoes the media understanding the original attempt may never have finished.
 *
 * Same call the webhooks make, with the same platform-specific fetcher choice: Meta's
 * signed CDN URLs need no credential and must not be handed the page token, so FB/IG use
 * MetaMessagingFetcher; WhatsApp Cloud's lookaside URLs need the account token, which the
 * default fetchers supply. An expired URL surfaces as a fetch failure and the text falls
 * back to the placeholder -- said so in the log, not silently.
 */
async function understandMedia(admin: any, row: OutboxRow, account: AccountRow): Promise<{ text: string; languageHint: string | null }> {
  const placeholder = { text: noteUnreadAttachments(row.inbound_text, row.unread_attachments), languageHint: row.language_hint };
  if (!row.media_url || !row.media_kind) return placeholder;

  const isMeta = row.platform === "facebook" || row.platform === "instagram";
  const outcome = await runInboundMediaUnderstanding(admin, {
    account: isMeta
      ? { id: account.id, user_id: account.user_id, platform_user_id: account.platform_user_id, account_metadata: account.account_metadata }
      : account,
    senderId: row.recipient_id,
    messageRowId: null,
    mediaUrl: row.media_url,
    kindHint: row.media_kind as MediaKind,
    caption: row.media_caption,
    platform: row.platform as "whatsapp" | "facebook" | "instagram",
  }, isMeta ? { fetchers: [new MetaMessagingFetcher()] } : {});

  if (!outcome.understood) {
    console.warn(`[recovery] media understanding skipped for ${row.id}: ${outcome.reason}`);
    return placeholder;
  }
  return {
    text: noteUnreadAttachments(outcome.agentText, row.unread_attachments),
    languageHint: outcome.languageCode ?? row.language_hint,
  };
}

function invokeAgent(row: OutboxRow, account: AccountRow, inboundText: string, languageHint: string | null) {
  return dispatchAgentReply({
    userId: row.user_id,
    platform: row.platform,
    socialAccountId: row.social_account_id,
    conversationId: row.conversation_id,
    recipientId: row.recipient_id,
    inboundText,
    // The business number: the row does not carry it, and the sender falls back to the
    // account's own id for exactly this case.
    phoneNumberId: row.platform === "whatsapp" ? account.platform_user_id : null,
    languageHint,
    commentId: row.comment_id,
    outboxId: row.id,
  });
}

/** Settles a row after ai-agent-reply answered. The agent already moved the row on success. */
async function settle(admin: any, row: OutboxRow, from: PendingReplyStatus, outcome: AgentReplyOutcome) {
  switch (outcome.kind) {
    case "sent":
    case "redelivered":
      return;
    case "skipped":
    case "outage_handled":
      // The agent cancelled the row itself on these paths. If it did not (older build), the
      // row stays where it was and lapses into the reaper with the reason recorded.
      return;
    case "retryable":
      // The agent released the row back to pending when nothing external happened. Nothing
      // to do here: the lease lapses and the next run tries again.
      console.warn(`[recovery] ${row.id} retryable: ${outcome.detail}`);
      return;
    case "permanent":
      await advanceReply(admin, { id: row.id, from, to: "failed", error: outcome.detail });
      await surfaceToHumans(admin, row, "recovery_failed", outcome.detail);
      return;
  }
}

async function processRow(admin: any, row: OutboxRow): Promise<string> {
  const action: RecoveryAction = decideRecovery(row, await loadContext(admin, row));
  const from = row.status as PendingReplyStatus;

  switch (action.kind) {
    case "delivery_unknown":
      await advanceReply(admin, { id: row.id, from, to: "delivery_unknown", error: "lease lapsed during a delivery attempt" });
      await surfaceToHumans(admin, row, "delivery_unknown", "a reply may or may not have reached the customer");
      return action.kind;
    case "hand_to_human":
      await advanceReply(admin, { id: row.id, from, to: "delivery_unknown", error: "lease lapsed while the agent was running" });
      await handToHuman(admin, row);
      await surfaceToHumans(admin, row, "delivery_unknown", "the agent was interrupted; a tool or escalation may have run");
      return action.kind;
    case "cancel":
      await advanceReply(admin, { id: row.id, from, to: "cancelled", error: action.reason });
      return `${action.kind}:${action.reason}`;
    case "deliver_stored":
    case "rerun_agent": {
      const account = await loadAccount(admin, row);
      if (!account) {
        await advanceReply(admin, { id: row.id, from, to: "failed", error: "social account no longer exists" });
        await surfaceToHumans(admin, row, "recovery_failed", "social account no longer exists");
        return "failed:no_account";
      }
      const input = action.kind === "rerun_agent"
        ? await understandMedia(admin, row, account)
        : { text: row.inbound_text, languageHint: row.language_hint };
      const outcome = await invokeAgent(row, account, input.text, input.languageHint);
      await settle(admin, row, from, outcome);
      return `${action.kind}:${outcome.kind}`;
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const cronAuth = verifyCronAuth(req);
  if (!cronAuth.ok) return cronAuth.response;

  const startedAt = Date.now();
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const results: Record<string, string> = {};

  // Exhausted rows leave the working set first, and each becomes visible to a person.
  const { data: reaped, error: reapError } = await admin.rpc("reap_exhausted_agent_replies", {
    p_max_attempts: RECOVERY_LIMITS.maxAttempts,
  });
  if (reapError) console.error(`[recovery] reap failed: ${reapError.message}`);
  for (const row of (reaped ?? []) as OutboxRow[]) {
    await surfaceToHumans(admin, row, row.status === "failed" ? "recovery_failed" : "delivery_unknown", "attempts exhausted");
    results[row.id] = `reaped:${row.status}`;
  }

  while (canStartAnotherRow(Date.now() - startedAt)) {
    const { data: claimed, error: claimError } = await admin.rpc("claim_agent_replies", {
      p_limit: 1,
      p_lease_seconds: RECOVERY_LIMITS.leaseSeconds,
      p_max_attempts: RECOVERY_LIMITS.maxAttempts,
    });
    if (claimError) {
      console.error(`[recovery] claim failed: ${claimError.message}`);
      break;
    }
    const row = (claimed as OutboxRow[] | null)?.[0];
    if (!row) break;
    try {
      results[row.id] = await processRow(admin, row);
    } catch (error) {
      // The row keeps its lease and its state; the next run reads that state and decides
      // again. Throwing here would abandon the rows behind it for nothing.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[recovery] ${row.id} threw: ${message}`);
      results[row.id] = `error:${message.slice(0, 120)}`;
    }
  }

  return json({ success: true, processed: Object.keys(results).length, results, elapsed_ms: Date.now() - startedAt });
});
