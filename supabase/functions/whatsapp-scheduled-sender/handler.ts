// Due WhatsApp scheduled messages. The claim RPC has already moved each row to
// `claimed`. Every later status change is a compare-and-set on that claim token,
// and a miss means the row was cancelled, expired, or reclaimed — never send.
import { digitsOnly, type SendRefusedInput } from "../_shared/optOutLookup.ts";
import { EvolutionApiError } from "../_shared/evolutionApi.ts";
import { sanitizeMediaFilename } from "../_shared/mediaFilename.ts";
import { whatsappConversationId } from "../_shared/phone.ts";
import { WhatsAppCloudApiError } from "../_shared/whatsappTransport.ts";
import type {
  WhatsAppSendMediaInput,
  WhatsAppTransport,
  WhatsAppTransportAccount,
} from "../_shared/whatsappTransport.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

const MEDIA_TYPES = new Set(["image", "video", "document", "audio"]);
const CONNECTION_MODES = new Set(["cloud_api", "coexistence", "evolution_qr"]);
const ERROR_LIMIT = 300;

export interface ClaimedScheduledMessage {
  id: string;
  user_id: string;
  social_account_id: string;
  recipient_phone: string;
  message_text: string | null;
  media_url: string | null;
  media_type: string | null;
  media_filename: string | null;
  claim_token: string;
  /** Claims so far, including this one. */
  attempts: number;
  account_connection_mode: string | null;
  account_platform_user_id: string | null;
  account_access_token: string | null;
  account_metadata: Record<string, unknown> | null;
  account_is_active: boolean | null;
}

export interface ScheduledTransition {
  id: string;
  claimToken: string;
  expectedStatus: "claimed" | "sending";
  patch: Record<string, unknown>;
}

export interface ScheduledLog {
  /** Null for tick-level events that belong to no single user. */
  userId: string | null;
  level: "info" | "warn" | "error";
  message: string;
  metadata: Record<string, unknown>;
}

export interface ScheduledSenderDeps {
  authorize(req: Request): { ok: true } | { ok: false; response: Response };
  loadDue(): Promise<{ messages: ClaimedScheduledMessage[] } | { error: string }>;
  optedOutPhones(userId: string, phones: string[]): Promise<Set<string>>;
  logSendRefused(input: SendRefusedInput): Promise<void>;
  logEvent(entry: ScheduledLog): Promise<void>;
  /** True when the fenced update changed a row. False when the claim is gone. */
  transition(input: ScheduledTransition): Promise<boolean>;
  insertOutbound(row: Record<string, unknown>): Promise<void>;
  resolveTransport(account: WhatsAppTransportAccount): Promise<WhatsAppTransport>;
  now(): Date;
  budgetMs: number;
  sendTimeoutMs: number;
}

export interface ScheduledTickSummary {
  processed: number;
  skipped: number;
  failed: number;
  released: number;
  total: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function emptySummary(total: number): ScheduledTickSummary {
  return { processed: 0, skipped: 0, failed: 0, released: 0, total };
}

export function redactSensitive(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  const redacted = collapsed.replace(/\+?\d[\d\s-]{6,}\d/g, "[redacted]");
  return redacted || "send_failed";
}

function outsideSessionWindow(message: string, code: unknown): boolean {
  if (code === 131047 || code === "131047") return true;
  const normalized = message.toLowerCase().replace(/-/g, " ");
  return normalized.includes("131047") || normalized.includes("24 hour") || normalized.includes("re-engagement");
}

function providerDetails(error: unknown): { message: string; code: unknown } {
  if (error instanceof Error) {
    const code = "code" in error ? (error as { code?: unknown }).code : undefined;
    return { message: error.message, code };
  }
  return { message: "send_failed", code: undefined };
}

function storedProviderError(error: unknown): string {
  const details = providerDetails(error);
  if (outsideSessionWindow(details.message, details.code)) return "outside_session_window";
  return redactSensitive(details.message).slice(0, ERROR_LIMIT);
}

/**
 * True when the provider may have accepted the message: our own timeout, the
 * Evolution client's timeout, an abort, a network failure (fetch TypeError),
 * an Evolution 5xx, or anything unrecognised. Such a row stays `sending` and
 * the lease turns it indeterminate; it is never marked failed or resent.
 * Only a definite refusal (a provider response, or a pre-send config error)
 * is recorded as failed.
 */
function sendOutcomeUnknown(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  if (error instanceof EvolutionApiError || error instanceof WhatsAppCloudApiError) return error.status >= 500;
  if (error.name === "TypeError" || error.name === "AbortError") return true;
  return error.message === "provider_timeout" || /timed out|aborted/i.test(error.message);
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("provider_timeout")), timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function rejectionReason(row: ClaimedScheduledMessage): string | null {
  if (row.account_is_active === false) return "account_inactive";
  if (row.media_type) {
    const url = row.media_url?.trim() ?? "";
    if (!MEDIA_TYPES.has(row.media_type) || !url) return "invalid_media";
  }
  if (!row.media_type && !row.message_text?.trim()) return "empty_message";
  if (!acceptableRecipient(row.recipient_phone)) return "invalid_recipient";
  if (!supportedMode(row.account_connection_mode) || !row.account_platform_user_id) return "unsupported_account";
  return null;
}

// Digits with optional leading +, spaces, dashes, dots and brackets only. Letters,
// "ext", '@' and anything else are refused: stripping them would send to a different number.
const PHONE_FORMAT = /^\+?[0-9][0-9\s\-().]*$/;

function acceptableRecipient(raw: string | null): boolean {
  if (!raw || !PHONE_FORMAT.test(raw.trim())) return false;
  const digits = digitsOnly(raw);
  return digits.length >= 8 && digits.length <= 15;
}

function supportedMode(mode: string | null): mode is "cloud_api" | "coexistence" | "evolution_qr" {
  return mode !== null && CONNECTION_MODES.has(mode);
}

function transportAccount(row: ClaimedScheduledMessage): WhatsAppTransportAccount {
  const mode = row.account_connection_mode;
  return {
    id: row.social_account_id,
    platform_user_id: row.account_platform_user_id ?? "",
    access_token: row.account_access_token,
    connection_mode: supportedMode(mode) ? mode : null,
    account_metadata: row.account_metadata,
  };
}

function mediaInput(row: ClaimedScheduledMessage, recipientPhone: string): WhatsAppSendMediaInput {
  const mediaType = row.media_type as WhatsAppSendMediaInput["mediaType"];
  const input: WhatsAppSendMediaInput = {
    recipientPhone,
    mediaUrl: row.media_url!.trim(),
    mediaType,
  };
  if (mediaType !== "audio") {
    const caption = row.message_text?.trim();
    if (caption) input.caption = caption;
  }
  if (mediaType === "document") {
    // The customer sees the original name when present, otherwise today's
    // name from the URL; both go through the shared sanitiser.
    input.fileName = sanitizeMediaFilename(row.media_filename?.trim() ? row.media_filename : input.mediaUrl);
  }
  return input;
}

async function dispatchSend(transport: WhatsAppTransport, row: ClaimedScheduledMessage): Promise<{ messageId: string | null }> {
  const recipientPhone = digitsOnly(row.recipient_phone);
  if (row.media_type) {
    const sent = await transport.sendMedia(mediaInput(row, recipientPhone));
    return { messageId: sent.messageId };
  }
  const sent = await transport.sendText({ recipientPhone, text: row.message_text!.trim() });
  return { messageId: sent.messageId };
}

async function note(deps: ScheduledSenderDeps, row: ClaimedScheduledMessage, level: ScheduledLog["level"], message: string, metadata: Record<string, unknown>): Promise<void> {
  try {
    await deps.logEvent({
      userId: row.user_id,
      level,
      message,
      metadata: { scheduled_message_id: row.id, social_account_id: row.social_account_id, ...metadata },
    });
  } catch {
    console.error("[scheduled-sender] log failed", row.id);
  }
}

type FenceOutcome = "applied" | "lost" | "error";

async function compareAndSet(
  deps: ScheduledSenderDeps,
  row: ClaimedScheduledMessage,
  expectedStatus: "claimed" | "sending",
  patch: Record<string, unknown>,
): Promise<FenceOutcome> {
  try {
    const applied = await deps.transition({
      id: row.id,
      claimToken: row.claim_token,
      expectedStatus,
      patch,
    });
    return applied ? "applied" : "lost";
  } catch {
    return "error";
  }
}

async function noteClaimLost(deps: ScheduledSenderDeps, row: ClaimedScheduledMessage, expectedStatus: string): Promise<void> {
  await note(deps, row, "warn", "Scheduled claim no longer valid", { expected_status: expectedStatus });
}

// A released row goes back to `pending` and is claimed again next tick. Without a cap, a row that
// fails the same way every tick (e.g. a QR account with no instance) would be retried forever and,
// being oldest, fill the claim limit ahead of newer messages.
const MAX_CLAIM_ATTEMPTS = 5;

/** Releases the claim for a retry, or fails the row once it has used its attempts. */
async function releaseClaim(
  deps: ScheduledSenderDeps,
  row: ClaimedScheduledMessage,
  summary: ScheduledTickSummary,
  reason: string,
): Promise<void> {
  if (row.attempts >= MAX_CLAIM_ATTEMPTS) {
    if (await refuseBeforeSend(deps, row, reason)) summary.failed += 1;
    return;
  }
  if (await releaseForRetry(deps, row)) summary.released += 1;
}

async function releaseForRetry(deps: ScheduledSenderDeps, row: ClaimedScheduledMessage): Promise<boolean> {
  const outcome = await compareAndSet(deps, row, "claimed", {
    status: "pending",
    claim_token: null,
    claimed_at: null,
  });
  if (outcome === "applied") return true;
  if (outcome === "lost") await noteClaimLost(deps, row, "claimed");
  else await note(deps, row, "error", "Scheduled claim release failed", { reason: "release_failed" });
  return false;
}

function groupByUser(rows: ClaimedScheduledMessage[]): Map<string, ClaimedScheduledMessage[]> {
  const byUser = new Map<string, ClaimedScheduledMessage[]>();
  for (const row of rows) {
    const list = byUser.get(row.user_id) ?? [];
    list.push(row);
    byUser.set(row.user_id, list);
  }
  return byUser;
}

async function applyOptOut(
  deps: ScheduledSenderDeps,
  rows: ClaimedScheduledMessage[],
  summary: ScheduledTickSummary,
): Promise<Set<string>> {
  const finished = new Set<string>();
  for (const [userId, messages] of groupByUser(rows)) {
    let optedOut: Set<string>;
    try {
      optedOut = await deps.optedOutPhones(userId, messages.map((row) => row.recipient_phone));
    } catch {
      await deps.logSendRefused({
        source: "whatsapp-scheduled-sender",
        userId,
        reason: "opt_out_lookup_failed",
        metadata: { count: messages.length },
      });
      for (const row of messages) {
        finished.add(row.id);
        await releaseClaim(deps, row, summary, "opt_out_lookup_failed");
      }
      continue;
    }
    for (const row of messages) {
      if (!optedOut.has(digitsOnly(row.recipient_phone))) continue;
      finished.add(row.id);
      const outcome = await compareAndSet(deps, row, "claimed", {
        status: "skipped",
        error_message: "opted_out",
        claim_token: null,
      });
      if (outcome === "lost") {
        await noteClaimLost(deps, row, "claimed");
        continue;
      }
      if (outcome === "error") {
        await deps.logSendRefused({
          source: "whatsapp-scheduled-sender",
          userId,
          reason: "opt_out_skip_failed",
          metadata: { scheduled_message_id: row.id },
        });
        continue;
      }
      summary.skipped += 1;
      await deps.logSendRefused({
        source: "whatsapp-scheduled-sender",
        userId,
        reason: "opted_out",
        metadata: { scheduled_message_id: row.id },
      });
    }
  }
  return finished;
}

async function refuseBeforeSend(
  deps: ScheduledSenderDeps,
  row: ClaimedScheduledMessage,
  reason: string,
): Promise<boolean> {
  const outcome = await compareAndSet(deps, row, "claimed", {
    status: "failed",
    error_message: reason,
    claim_token: null,
  });
  if (outcome === "lost") {
    await noteClaimLost(deps, row, "claimed");
    return false;
  }
  if (outcome === "error") {
    await note(deps, row, "error", "Scheduled refusal could not be saved", { reason });
    return false;
  }
  await note(deps, row, "warn", "Scheduled send refused", { reason });
  return true;
}

function outboundRow(row: ClaimedScheduledMessage, messageId: string | null, sentAt: string): Record<string, unknown> {
  const mode = row.account_connection_mode as "cloud_api" | "coexistence" | "evolution_qr";
  const platformUserId = row.account_platform_user_id ?? "";
  const recipientPhone = digitsOnly(row.recipient_phone);
  return {
    user_id: row.user_id,
    social_account_id: row.social_account_id,
    conversation_id: whatsappConversationId({
      mode,
      phoneNumberId: platformUserId,
      platformUserId,
    }, recipientPhone),
    message_id: messageId || `sched_${row.id}`,
    from_phone: platformUserId,
    from_name: "You (Scheduled)",
    to_phone: recipientPhone,
    message_text: row.message_text || `[${row.media_type || "scheduled"}]`,
    message_type: row.media_type || "text",
    direction: "outbound",
    status: "sent",
    timestamp: sentAt,
  };
}

async function recordAcceptedSend(
  deps: ScheduledSenderDeps,
  row: ClaimedScheduledMessage,
  messageId: string | null,
): Promise<boolean> {
  const sentAt = deps.now().toISOString();
  const outcome = await compareAndSet(deps, row, "sending", {
    status: "sent",
    sent_at: sentAt,
    claim_token: null,
  });
  if (outcome !== "applied") {
    // The provider already accepted. A failed sent-write must not be retried and must not be marked failed.
    await note(deps, row, "error", "Scheduled sent status could not be saved", { reason: "sent_write_failed" });
    return false;
  }
  try {
    await deps.insertOutbound(outboundRow(row, messageId, sentAt));
  } catch {
    await note(deps, row, "error", "Scheduled outbound record could not be saved", { reason: "outbound_insert_failed" });
  }
  return true;
}

async function recordProviderRefusal(deps: ScheduledSenderDeps, row: ClaimedScheduledMessage, error: unknown): Promise<boolean> {
  const errorMessage = storedProviderError(error);
  const outcome = await compareAndSet(deps, row, "sending", {
    status: "failed",
    error_message: errorMessage,
    claim_token: null,
  });
  if (outcome === "lost") {
    await noteClaimLost(deps, row, "sending");
    return false;
  }
  if (outcome === "error") {
    await note(deps, row, "error", "Scheduled provider refusal could not be saved", { reason: "provider_refusal_write_failed" });
    return false;
  }
  await note(deps, row, "warn", "Scheduled provider refused the send", {
    reason: errorMessage === "outside_session_window" ? "outside_session_window" : "provider_rejected",
  });
  return true;
}

async function sendClaimed(deps: ScheduledSenderDeps, row: ClaimedScheduledMessage, summary: ScheduledTickSummary): Promise<void> {
  // Resolved before `sending`: a resolver failure (e.g. the QR instance lookup) never reached the
  // provider, so the claim is released for a retry instead of being discarded.
  let transport: WhatsAppTransport;
  try {
    transport = await withTimeout(deps.resolveTransport(transportAccount(row)), deps.sendTimeoutMs);
  } catch {
    await note(deps, row, "warn", "Scheduled transport could not be resolved", { reason: "transport_unavailable" });
    await releaseClaim(deps, row, summary, "transport_unavailable");
    return;
  }
  const markedSending = await compareAndSet(deps, row, "claimed", { status: "sending" });
  if (markedSending === "lost") {
    await noteClaimLost(deps, row, "claimed");
    return;
  }
  if (markedSending === "error") {
    await note(deps, row, "error", "Scheduled sending status could not be saved", { reason: "sending_write_failed" });
    return;
  }
  let messageId: string | null;
  try {
    const sent = await withTimeout(dispatchSend(transport, row), deps.sendTimeoutMs);
    messageId = sent.messageId;
  } catch (error) {
    // A timeout means the provider may already have accepted. Leave `sending` so the lease can mark it indeterminate.
    if (sendOutcomeUnknown(error)) {
      await note(deps, row, "warn", "Scheduled send outcome unknown", { reason: "send_outcome_unknown" });
      return;
    }
    if (await recordProviderRefusal(deps, row, error)) summary.failed += 1;
    return;
  }
  if (await recordAcceptedSend(deps, row, messageId)) summary.processed += 1;
}

function budgetSpent(deps: ScheduledSenderDeps, startedMs: number): boolean {
  return deps.now().getTime() - startedMs >= deps.budgetMs;
}

async function deliverDue(rows: ClaimedScheduledMessage[], deps: ScheduledSenderDeps): Promise<ScheduledTickSummary> {
  const summary = emptySummary(rows.length);
  if (rows.length === 0) return summary;
  const startedMs = deps.now().getTime();
  const finished = await applyOptOut(deps, rows, summary);
  for (const row of rows) {
    if (finished.has(row.id)) continue;
    if (budgetSpent(deps, startedMs)) {
      await releaseClaim(deps, row, summary, "attempts_exhausted");
      continue;
    }
    const reason = rejectionReason(row);
    if (reason) {
      if (await refuseBeforeSend(deps, row, reason)) summary.failed += 1;
      continue;
    }
    await sendClaimed(deps, row, summary);
  }
  return summary;
}

export async function handleScheduledSender(req: Request, deps: ScheduledSenderDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const cronAuth = deps.authorize(req);
  if (!cronAuth.ok) return cronAuth.response;

  try {
    const loaded = await deps.loadDue();
    if ("error" in loaded) {
      try {
        await deps.logEvent({ userId: null, level: "error", message: "Scheduled claim failed", metadata: { reason: "claim_failed" } });
      } catch {
        console.error("[scheduled-sender] claim-failure log failed");
      }
      return json({ error: "scheduled_query_failed" }, 500);
    }
    return json(await deliverDue(loaded.messages, deps));
  } catch {
    console.error("[scheduled-sender] Fatal error");
    return json({ error: "scheduled_send_failed" }, 500);
  }
}
