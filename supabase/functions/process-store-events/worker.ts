// Store-event opener worker (Spec B §8.3–8.5). Every I/O is a port.
import { whatsappConversationId, type WhatsAppAddressing } from "../_shared/phone.ts";
import { resolveEngagementMode } from "../ai-agent-reply/logic.ts";
import { expireIfStale, isPendingOpener, type ProcedureState } from "../_shared/procedures/engine.ts";
import {
  ensureEventTemplate,
  templateSendComponents,
  type TemplateGraph,
  type TemplateResolution,
} from "../_shared/procedures/eventTemplates.ts";
import { openerLanguage, openerText, type OpenerLanguage } from "../_shared/procedures/openers.ts";
import { TEMPLATES, type EventProcedureKey } from "../_shared/procedures/templates.ts";
import type { ProcedureSettings } from "../_shared/procedures/config.ts";

export const STORE_EVENT_LIMITS = {
  claimLimit: 20,
  lease: "2 minutes",
  tickBudgetMs: 40_000,
  qrDailyCap: 50,
} as const;

const STALE_AFTER_MS = 48 * 60 * 60 * 1000;
const PENDING_TEMPLATE_DEFER_MS = 15 * 60 * 1000;
export const DISCONNECTED_HOLD_MS = 24 * 60 * 60 * 1000;
const DISCONNECTED_RETRY_MS = 15 * 60 * 1000;
const ORDER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const COD_STATUSES = new Set(["pending", "on-hold", "processing"]);

export interface StoreEventRow {
  id: string;
  user_id: string;
  social_account_id: string;
  connector_id: string;
  binding_id: string;
  flow: EventProcedureKey;
  external_id: string;
  payload: Record<string, string>;
  status: "claimed" | "sending";
  claim_token: string;
  due_at: string;
  /** Set when the row is inserted. Deferral does not move it. */
  created_at: string;
  /** Claim already added one. A pending-template deferral gives that one back. */
  attempts: number;
  outbound_message_id: string | null;
}

export interface AccountContext {
  platform: string;
  connectionMode: "cloud_api" | "coexistence" | "evolution_qr" | null;
  phoneNumberId: string | null;
  platformUserId: string;
  languageMode: unknown;
  agentEnabled: boolean;
  defaultMode: string;
  settings: ProcedureSettings | null;
  connectorVisible: boolean;
  /** True unless this event's ai_agent_tools row has read_only_mode === false. */
  connectorReadOnly: boolean;
  optedOut: boolean;
  /** False when the row is inactive or its number was retired by a re-pair. */
  connected: boolean;
  /**
   * The binding's current social_account_id, when the binding still exists.
   * Differs from the event's account after a setup move; the worker then
   * re-points the event before any skip logic runs.
   */
  bindingAccountId?: string | null;
}

export interface StoreSnapshot {
  paymentMethod: string;
  status: string;
  phone: string | null;
  createdAt: string | null;
  stockStatus: string | null;
}

/** A Woo re-read. `transient` is released for the next tick; `absent` is a final skip. */
export type StoreRead =
  | { outcome: "snapshot"; snapshot: StoreSnapshot }
  | { outcome: "absent" }
  | { outcome: "transient" };

export interface ThreadRow {
  id: string;
  procedure_state: unknown;
}

export type SendOutcome =
  | { accepted: true; messageId: string }
  | { accepted: false; definite: true; reason: string }
  | { accepted: false; definite: false };

export interface SendOpenerInput {
  event: StoreEventRow;
  account: AccountContext;
  conversationId: string;
  language: OpenerLanguage;
  text: string;
  templateName: string | null;
  components: unknown[];
}

export interface RecordOpenerInput {
  event: StoreEventRow;
  account: AccountContext;
  threadId: string;
  conversationId: string;
  messageId: string;
  text: string;
}

/** One terminal skip or failure. Metadata never carries the phone or the payload. */
export interface StoreEventLog {
  source: "process-store-events";
  category: "ai";
  level: "info" | "warn";
  message: "Store event skipped" | "Store event failed" | "Store event deferred";
  user_id: string;
  metadata: {
    event_id: string;
    flow: string;
    social_account_id: string;
    reason: string;
  };
}

export interface WorkerPorts {
  now(): number;
  claim(limit: number, lease: string): Promise<StoreEventRow[]>;
  /** False when id + claim_token no longer match: the update touched nothing. */
  updateEvent(id: string, claimToken: string, patch: Record<string, unknown>): Promise<boolean>;
  releaseClaim(id: string, claimToken: string): Promise<boolean>;
  /**
   * One compare-and-set that re-points a claimed event to its binding's current
   * account and releases the claim (status pending, token cleared). False when
   * the id + claim_token fence no longer matches.
   */
  retargetEvent?: (id: string, claimToken: string, accountId: string) => Promise<boolean>;
  loadAccount(event: StoreEventRow): Promise<AccountContext | null>;
  readStore(event: StoreEventRow): Promise<StoreRead>;
  reserveQr(accountId: string, limit: number, eventId: string, claimToken: string): Promise<boolean>;
  releaseQr(accountId: string, eventId: string, claimToken: string): Promise<void>;
  ensureThread(input: { userId: string; conversationId: string }): Promise<ThreadRow>;
  /**
   * Read the thread if one exists. Unlike ensureThread this does not insert,
   * so a skip can look for an opener it stored on an earlier attempt without
   * creating a conversation.
   */
  findThread(input: { userId: string; conversationId: string }): Promise<ThreadRow | null>;
  persistState(threadId: string, expected: unknown, next: unknown): Promise<boolean>;
  templateStatus(event: StoreEventRow, language: OpenerLanguage): Promise<TemplateResolution>;
  /** Null when this account has no WABA id or token to submit a template with. */
  templateGraph(event: StoreEventRow): Promise<TemplateGraph | null>;
  sendOpener(input: SendOpenerInput): Promise<SendOutcome>;
  recordOpener(input: RecordOpenerInput): Promise<void>;
  deleteWaitlist(event: StoreEventRow): Promise<void>;
  alertAdmin(event: StoreEventRow, reason: string): Promise<void>;
  /** A failed insert is logged by the adapter and must not change the worker outcome. */
  logEvent(entry: StoreEventLog): Promise<void>;
  /** Raises the owner's disconnected-account alert. Best effort at the call site. */
  noteUndelivered(accountId: string): Promise<void>;
  /** Clears the undelivered flag once nothing is held for this account any more. */
  resolveUndelivered(accountId: string): Promise<void>;
}

export interface WorkerSummary {
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
  released: number;
}

export function sanitizeFailureReason(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  const redacted = collapsed.replace(/\+?\d[\d\s-]{5,}\d/g, "[redacted]");
  return (redacted || "send_failed").slice(0, 160);
}

export function accountSkipReason(event: StoreEventRow, account: AccountContext | null, nowMs: number): string | null {
  if (!account || account.platform !== "whatsapp") return account ? "not_whatsapp" : "account_unavailable";
  if (account.settings?.enabled !== true) return "flow_disabled";
  if (!account.agentEnabled) return "agent_disabled";
  if (resolveEngagementMode(null, account.defaultMode) === "human_first") return "engagement_mode";
  if (!account.connectorVisible) return "connector_not_visible";
  if (event.flow === "cod_confirm" && account.connectorReadOnly) return "connector_read_only";
  if (account.optedOut) return "opted_out";
  const origin = stalenessOriginMs(event);
  if (!Number.isFinite(origin) || origin + STALE_AFTER_MS < nowMs) return "expired";
  if (account.connectionMode === "evolution_qr" && !account.settings.qr_risk_acknowledged_at) return "qr_risk_unacknowledged";
  if ((event.flow === "cod_confirm" || event.flow === "review_request") && !account.settings.consent_attested_at) {
    return "consent_missing";
  }
  if (account.connectionMode !== "cloud_api" && account.connectionMode !== "coexistence" && account.connectionMode !== "evolution_qr") {
    return "account_unavailable";
  }
  if (!account.platformUserId) return "account_unavailable";
  if (account.connectionMode !== "evolution_qr" && !account.phoneNumberId) return "account_unavailable";
  return null;
}

export function storeSkipReason(
  flow: EventProcedureKey,
  payload: Record<string, string>,
  snapshot: StoreSnapshot | null,
  nowMs: number,
): string | null {
  if (!snapshot) return "store_unread";
  if (flow === "back_in_stock") return snapshot.stockStatus === "instock" ? null : "not_instock";
  if (flow === "review_request") {
    if (snapshot.status !== "completed") return "review_not_completed";
    // The review runs days after the webhook: never message a number the order no longer carries.
    return snapshot.phone && snapshot.phone === payload.phone ? null : "phone_changed";
  }
  if (snapshot.paymentMethod.toLowerCase() !== "cod") return "payment_method_changed";
  if (!COD_STATUSES.has(snapshot.status)) return "status_changed";
  if (!snapshot.phone || snapshot.phone !== payload.phone) return "phone_changed";
  const created = Date.parse(snapshot.createdAt ?? "");
  if (!Number.isFinite(created) || nowMs - created > ORDER_MAX_AGE_MS) return "order_too_old";
  return null;
}

function iso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

/**
 * 48h is measured from the original due time. COD and back-in-stock are due at
 * insert, so created_at is that time. A review's due_at moves when its template
 * is still in Meta review; the first deferral stores the original under
 * payload.original_due_at and later deferrals leave that key alone.
 */
function stalenessOriginMs(event: StoreEventRow): number {
  if (event.flow === "cod_confirm" || event.flow === "back_in_stock") return Date.parse(event.created_at);
  return Date.parse(event.payload.original_due_at || event.due_at);
}

function addressing(account: AccountContext): WhatsAppAddressing {
  return {
    mode: account.connectionMode === "evolution_qr"
      ? "evolution_qr"
      : account.connectionMode === "coexistence" ? "coexistence" : "cloud_api",
    phoneNumberId: account.phoneNumberId,
    platformUserId: account.platformUserId,
  };
}

function pendingState(event: StoreEventRow, nowMs: number, language: OpenerLanguage): ProcedureState {
  const at = iso(nowMs);
  return {
    run_id: event.id,
    key: event.flow,
    version: TEMPLATES[event.flow].version,
    step: 0,
    fields: {},
    off_script: 0,
    origin: "event",
    phase: "pending_opener",
    opener_language: language,
    started_at: at,
    updated_at: at,
  };
}

async function clearPending(ports: WorkerPorts, thread: ThreadRow, eventId: string, expected: ProcedureState | null): Promise<boolean> {
  const state = expected ?? (isPendingOpener(thread.procedure_state) ? thread.procedure_state as ProcedureState : null);
  if (!state || state.run_id !== eventId || state.phase !== "pending_opener") return true;
  return await ports.persistState(thread.id, state, null);
}

/** A compare-and-set miss and a thrown clear are the same failure: the opener is still stored. */
async function clearPendingOrLog(ports: WorkerPorts, thread: ThreadRow, event: StoreEventRow, expected: ProcedureState | null): Promise<boolean> {
  try {
    return await clearPending(ports, thread, event.id, expected);
  } catch (error) {
    console.error(
      `[process-store-events] ${event.id} state clear failed:`,
      sanitizeFailureReason(error instanceof Error ? error.message : "state_clear_failed"),
    );
    return false;
  }
}

async function releaseReservedQr(ports: WorkerPorts, event: StoreEventRow, reserved: boolean): Promise<void> {
  if (!reserved) return;
  try {
    await ports.releaseQr(event.social_account_id, event.id, event.claim_token);
  } catch {
    // The lease still returns the row; the cap slot is the smaller loss.
  }
}

interface OpenerClearance {
  account: AccountContext | null;
  /** The thread this attempt already loaded. Null asks for a read, not an insert. */
  thread: ThreadRow | null;
  expected: ProcedureState | null;
  reserved: boolean;
}

async function openerThread(
  ports: WorkerPorts,
  event: StoreEventRow,
  clearance: OpenerClearance,
): Promise<ThreadRow | null> {
  if (clearance.thread) return clearance.thread;
  const account = clearance.account;
  const phone = event.payload.phone;
  if (!account || account.platform !== "whatsapp" || !account.connectionMode || !account.platformUserId || !phone) {
    return null;
  }
  return await ports.findThread({
    userId: event.user_id,
    conversationId: whatsappConversationId(addressing(account), phone),
  });
}

/**
 * Terminal rows must drop an opener this event owns before the status write.
 * A failed clear leaves the row retryable: `sending` stays `sending` (the next
 * claim refreshes the lease and does not resend); every other status releases
 * the claim.
 */
async function refuseTerminal(
  ports: WorkerPorts,
  event: StoreEventRow,
  clearance: OpenerClearance,
  whenClearFails: "keep-sending" | "release",
): Promise<"go" | "released" | "left"> {
  let thread: ThreadRow | null;
  try {
    thread = await openerThread(ports, event, clearance);
  } catch (error) {
    console.error(
      `[process-store-events] ${event.id} state clear failed:`,
      sanitizeFailureReason(error instanceof Error ? error.message : "state_clear_failed"),
    );
    if (whenClearFails === "keep-sending") return "left";
    await releaseReservedQr(ports, event, clearance.reserved);
    return await releaseAfterClearFailure(ports, event);
  }
  if (!thread) return "go";
  const cleared = await clearPendingOrLog(ports, thread, event, clearance.expected);
  if (cleared) return "go";
  if (whenClearFails === "keep-sending") return "left";
  await releaseReservedQr(ports, event, clearance.reserved);
  return await releaseAfterClearFailure(ports, event);
}

/** releaseClaim matches claim_token. A released row stays subject to attempt exhaustion. */
async function releaseAfterClearFailure(ports: WorkerPorts, event: StoreEventRow): Promise<"released" | "left"> {
  console.error(`[process-store-events] ${event.id} opener clear failed; releasing the claim for retry`);
  try {
    return await ports.releaseClaim(event.id, event.claim_token) ? "released" : "left";
  } catch (error) {
    console.error(
      `[process-store-events] ${event.id} claim release failed:`,
      sanitizeFailureReason(error instanceof Error ? error.message : "release_failed"),
    );
    return "left";
  }
}

export async function runStoreEventWorker(
  ports: WorkerPorts,
  limits: typeof STORE_EVENT_LIMITS = STORE_EVENT_LIMITS,
): Promise<WorkerSummary> {
  const started = ports.now();
  const summary: WorkerSummary = { claimed: 0, sent: 0, skipped: 0, failed: 0, released: 0 };
  const rows = await ports.claim(limits.claimLimit, limits.lease);
  summary.claimed = rows.length;
  for (const event of rows) {
    if (event.status === "sending") {
      if (event.outbound_message_id) {
        const finished = await completeRecordedSend(ports, event);
        if (finished === "sent") summary.sent += 1;
        else if (finished === "failed") summary.failed += 1;
        else if (finished === "released") summary.released += 1;
      } else if (await settleIndeterminate(ports, event)) {
        summary.failed += 1;
      }
      continue;
    }
    if (ports.now() - started >= limits.tickBudgetMs) {
      if (await ports.releaseClaim(event.id, event.claim_token)) summary.released += 1;
      continue;
    }
    const outcome = await processClaimed(ports, event, limits.qrDailyCap);
    if (outcome !== "left") summary[outcome] += 1;
  }
  return summary;
}

function asProcedure(value: unknown): ProcedureState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as ProcedureState;
  if (typeof state.run_id !== "string" || typeof state.key !== "string") return null;
  return state;
}

function eventOwns(state: ProcedureState | null, event: StoreEventRow): boolean {
  return !!state && state.run_id === event.id && state.key === event.flow;
}

/** The provider already accepted. Finish activation and bookkeeping; do not send again. */
async function completeRecordedSend(ports: WorkerPorts, event: StoreEventRow): Promise<"sent" | "failed" | "released" | "left"> {
  const messageId = event.outbound_message_id;
  if (!messageId) return "left";
  try {
    const account = await ports.loadAccount(event);
    const phone = event.payload.phone;
    if (account?.platform === "whatsapp" && account.connectionMode && account.platformUserId && phone) {
      const conversationId = whatsappConversationId(addressing(account), phone);
      const thread = await ports.ensureThread({ userId: event.user_id, conversationId });
      const stored = asProcedure(thread.procedure_state);
      const pending = stored?.phase === "pending_opener" && eventOwns(stored, event) ? stored : null;
      const language = (eventOwns(stored, event) ? stored?.opener_language : undefined) ??
        openerLanguage(account.languageMode);
      return await finishAccepted(ports, {
        event,
        account,
        threadId: thread.id,
        conversationId,
        messageId,
        text: openerText(event.flow, language, event.payload),
      }, thread, pending);
    }
    console.error(
      `[process-store-events] ${event.id} accepted send has no WhatsApp thread to activate`,
    );
    return "left";
  } catch (error) {
    console.error(
      `[process-store-events] ${event.id} accepted send was not finished:`,
      sanitizeFailureReason(error instanceof Error ? error.message : "finish_failed"),
    );
    return "left";
  }
}

/**
 * Activate pending_opener → active, then record the send.
 * A lost compare-and-set leaves the row in `sending` with outbound_message_id set.
 * The next tick retries. An already-active state for this event is success.
 * Any other stored flow is a terminal activation_conflict.
 */
async function finishAccepted(
  ports: WorkerPorts,
  opener: RecordOpenerInput,
  thread: ThreadRow,
  pending: ProcedureState | null,
): Promise<"sent" | "failed" | "released" | "left"> {
  const stored = asProcedure(thread.procedure_state);
  const ownedPending = pending?.phase === "pending_opener" && eventOwns(pending, opener.event)
    ? pending
    : stored?.phase === "pending_opener" && eventOwns(stored, opener.event)
      ? stored
      : null;
  // markSent clears a pending_opener still sitting on the thread object. Pass
  // the activated state so that clear is a no-op. The compare-and-set retires
  // the opener; a lost one leaves the row sending.
  const alreadyActive = stored?.phase === "active" && eventOwns(stored, opener.event);
  let activeThread = thread;
  if (!alreadyActive) {
    if (!ownedPending) {
      return await markFailed(ports, opener.event, { reason: "activation_conflict", alert: true }, {
        account: opener.account,
        thread,
        expected: null,
        reserved: false,
      });
    }
    const active: ProcedureState = { ...ownedPending, phase: "active", updated_at: iso(ports.now()) };
    const activated = await ports.persistState(thread.id, ownedPending, active);
    if (!activated) {
      console.error(
        `[process-store-events] ${opener.event.id} opener activation lost the compare-and-set; leaving status sending`,
      );
      return "left";
    }
    activeThread = { ...thread, procedure_state: active };
  }
  await ports.recordOpener(opener);
  if (opener.event.flow === "back_in_stock") await ports.deleteWaitlist(opener.event);
  return await markSent(ports, opener.event, {
    account: opener.account,
    thread: activeThread,
    expected: null,
    reserved: false,
  });
}

async function writeOutcomeLog(
  ports: WorkerPorts,
  event: StoreEventRow,
  level: StoreEventLog["level"],
  message: StoreEventLog["message"],
  reason: string,
): Promise<void> {
  const safeReason = sanitizeFailureReason(reason);
  try {
    await ports.logEvent({
      source: "process-store-events",
      category: "ai",
      level,
      message,
      user_id: event.user_id,
      metadata: {
        event_id: event.id,
        flow: event.flow,
        social_account_id: event.social_account_id,
        reason: safeReason,
      },
    });
  } catch (error) {
    console.error(
      `[process-store-events] ${event.id} outcome log failed:`,
      sanitizeFailureReason(error instanceof Error ? error.message : "log_failed"),
    );
  }
}

async function writeFailure(ports: WorkerPorts, event: StoreEventRow, reason: string, alert: boolean): Promise<boolean> {
  const safeReason = sanitizeFailureReason(reason);
  const marked = await ports.updateEvent(event.id, event.claim_token, {
    status: "failed",
    skip_reason: safeReason,
    processed_at: iso(ports.now()),
  });
  if (!marked) return false;
  if (alert) {
    try {
      await ports.alertAdmin(event, safeReason);
    } catch (error) {
      console.error(
        `[process-store-events] ${event.id} admin alert failed:`,
        sanitizeFailureReason(error instanceof Error ? error.message : "alert_failed"),
      );
    }
  }
  await writeOutcomeLog(ports, event, "warn", "Store event failed", safeReason);
  return true;
}

async function markFailed(
  ports: WorkerPorts,
  event: StoreEventRow,
  failure: { reason: string; alert: boolean },
  clearance: OpenerClearance,
): Promise<"failed" | "released" | "left"> {
  const gate = await refuseTerminal(ports, event, clearance, "release");
  if (gate !== "go") return gate;
  if (clearance.reserved) await ports.releaseQr(event.social_account_id, event.id, event.claim_token);
  return await writeFailure(ports, event, failure.reason, failure.alert) ? "failed" : "left";
}

async function markSent(
  ports: WorkerPorts,
  event: StoreEventRow,
  clearance: OpenerClearance,
): Promise<"sent" | "released" | "left"> {
  const gate = await refuseTerminal(ports, event, clearance, "release");
  if (gate !== "go") return gate;
  if (clearance.reserved) await ports.releaseQr(event.social_account_id, event.id, event.claim_token);
  const marked = await ports.updateEvent(event.id, event.claim_token, {
    status: "sent",
    processed_at: iso(ports.now()),
  });
  if (!marked) return "left";
  // The account just delivered, so a stale "orders on hold" flag is wrong however the
  // reconnect happened. Best effort: the send already succeeded and must not re-fail.
  try {
    await ports.resolveUndelivered(event.social_account_id);
  } catch {
    console.error("[process-store-events] undelivered flag resolve failed");
  }
  return "sent";
}

async function settleIndeterminate(ports: WorkerPorts, event: StoreEventRow): Promise<boolean> {
  let account: AccountContext | null = null;
  try {
    account = await ports.loadAccount(event);
  } catch (error) {
    console.error(
      `[process-store-events] ${event.id} state clear failed:`,
      sanitizeFailureReason(error instanceof Error ? error.message : "state_clear_failed"),
    );
    return false;
  }
  const gate = await refuseTerminal(ports, event, {
    account,
    thread: null,
    expected: null,
    reserved: false,
  }, "keep-sending");
  if (gate !== "go") return false;
  return await writeFailure(ports, event, "indeterminate", true);
}

/** Give the claim back for 15 minutes. The attempt the claim just counted is returned. */
async function deferPendingTemplate(ports: WorkerPorts, event: StoreEventRow): Promise<boolean> {
  const payload = event.payload.original_due_at
    ? null
    : { ...event.payload, original_due_at: event.due_at };
  const marked = await ports.updateEvent(event.id, event.claim_token, {
    status: "pending",
    due_at: iso(ports.now() + PENDING_TEMPLATE_DEFER_MS),
    attempts: event.attempts - 1,
    claimed_at: null,
    claim_token: null,
    send_attempt_id: null,
    ...(payload ? { payload } : {}),
  });
  if (marked) await writeOutcomeLog(ports, event, "info", "Store event deferred", "template_pending");
  return marked;
}

/**
 * The bound account cannot send. Hold the order (15-minute retries, attempt returned) so a
 * reconnect or a setup move still delivers it, and raise the owner's alert. After 24h it is skipped.
 */
async function deferDisconnected(
  ports: WorkerPorts,
  event: StoreEventRow,
  account: AccountContext,
): Promise<"released" | "skipped" | "left"> {
  const created = Date.parse(event.created_at);
  if (!Number.isFinite(created) || ports.now() - created > DISCONNECTED_HOLD_MS) {
    const skipped = await skip(ports, event, "account_disconnected", { account, thread: null, expected: null, reserved: false });
    try {
      await ports.resolveUndelivered(event.social_account_id);
    } catch {
      console.error("[process-store-events] undelivered flag resolve failed");
    }
    return skipped;
  }
  try {
    await ports.noteUndelivered(event.social_account_id);
  } catch {
    console.error("[process-store-events] undelivered flag failed");
  }
  const marked = await ports.updateEvent(event.id, event.claim_token, {
    status: "pending",
    due_at: iso(ports.now() + DISCONNECTED_RETRY_MS),
    attempts: event.attempts - 1,
    claimed_at: null,
    claim_token: null,
    send_attempt_id: null,
  });
  if (marked) await writeOutcomeLog(ports, event, "info", "Store event deferred", "account_disconnected");
  return marked ? "released" : "left";
}

async function deferUnapprovedTemplate(
  ports: WorkerPorts,
  event: StoreEventRow,
  clearance: OpenerClearance,
): Promise<"released" | "left"> {
  const gate = await refuseTerminal(ports, event, clearance, "release");
  if (gate !== "go") return gate;
  if (clearance.reserved) await ports.releaseQr(event.social_account_id, event.id, event.claim_token);
  return await deferPendingTemplate(ports, event) ? "released" : "left";
}

async function skip(
  ports: WorkerPorts,
  event: StoreEventRow,
  reason: string,
  clearance: OpenerClearance,
): Promise<"skipped" | "released" | "left"> {
  const gate = await refuseTerminal(ports, event, clearance, "release");
  if (gate !== "go") return gate;
  if (clearance.reserved) await ports.releaseQr(event.social_account_id, event.id, event.claim_token);
  const marked = await ports.updateEvent(event.id, event.claim_token, {
    status: "skipped",
    skip_reason: reason,
    processed_at: iso(ports.now()),
  });
  if (marked) await writeOutcomeLog(ports, event, "info", "Store event skipped", reason);
  return marked ? "skipped" : "left";
}

async function processClaimed(
  ports: WorkerPorts,
  event: StoreEventRow,
  qrCap: number,
): Promise<"sent" | "skipped" | "failed" | "released" | "left"> {
  let reserved = false;
  let sending = false;
  let account: AccountContext | null = null;
  try {
    // A lost fence matches nothing, so the rest of the attempt does not run.
    const held = await ports.updateEvent(event.id, event.claim_token, { claimed_at: iso(ports.now()) });
    if (!held) return "left";
    account = await ports.loadAccount(event);
    // PR-BC: the binding may have been moved to another account after this event was
    // inserted (or the webhook raced the move). The order belongs to the binding's
    // current account, so re-point it before any skip logic looks at the old account.
    if (account && account.bindingAccountId && account.bindingAccountId !== event.social_account_id) {
      return (await ports.retargetEvent!(event.id, event.claim_token, account.bindingAccountId))
        ? "released"
        : "left";
    }
    // The skip reasons decide before the hold does: an account whose flow is off,
    // whose agent is off or whose customer opted out is skipped outright, even when
    // the row is disconnected -- those orders are never going out, held or not.
    const early = accountSkipReason(event, account, ports.now());
    if (early) {
      return await skip(ports, event, early, { account, thread: null, expected: null, reserved: false });
    }
    if (account && !account.connected) {
      return await deferDisconnected(ports, event, account);
    }
    const loaded = account!;
    const read = await ports.readStore(event);
    if (read.outcome === "transient") {
      if (await ports.releaseClaim(event.id, event.claim_token)) return "released";
      return "left";
    }
    const storeReason = storeSkipReason(
      event.flow,
      event.payload,
      read.outcome === "snapshot" ? read.snapshot : null,
      ports.now(),
    );
    if (storeReason) {
      return await skip(ports, event, storeReason, {
        account: loaded,
        thread: null,
        expected: null,
        reserved: false,
      });
    }
    if (loaded.connectionMode === "evolution_qr") {
      reserved = await ports.reserveQr(event.social_account_id, qrCap, event.id, event.claim_token);
      if (!reserved) {
        return await skip(ports, event, "qr_daily_cap", {
          account: loaded,
          thread: null,
          expected: null,
          reserved: false,
        });
      }
    }
    const phone = event.payload.phone;
    const conversationId = whatsappConversationId(addressing(loaded), phone);
    const thread = await ports.ensureThread({ userId: event.user_id, conversationId });
    const live = expireIfStale(
      thread.procedure_state && typeof thread.procedure_state === "object" ? thread.procedure_state as ProcedureState : null,
      new Date(ports.now()),
    );
    let openerState: ProcedureState;
    if (live && !(live.origin === "event" && live.run_id === event.id)) {
      return await skip(ports, event, "flow_active", { account: loaded, thread, expected: null, reserved });
    }
    if (live?.phase === "active") {
      return await markSent(ports, event, { account: loaded, thread, expected: null, reserved });
    }
    if (live?.phase === "pending_opener") {
      openerState = live;
    } else {
      openerState = pendingState(event, ports.now(), openerLanguage(loaded.languageMode));
      const started = await ports.persistState(thread.id, thread.procedure_state ?? null, openerState);
      if (!started) {
        if (reserved) await ports.releaseQr(event.social_account_id, event.id, event.claim_token);
        if (await ports.releaseClaim(event.id, event.claim_token)) return "released";
        return "left";
      }
    }
    // A resumed opener keeps the language it was first written with.
    const language = openerState.opener_language ?? openerLanguage(loaded.languageMode);
    let templateName: string | null = null;
    if (loaded.connectionMode !== "evolution_qr") {
      const template = await ports.templateStatus(event, language);
      const clearance: OpenerClearance = { account: loaded, thread, expected: openerState, reserved };
      if (template.status === "pending") {
        return await deferUnapprovedTemplate(ports, event, clearance);
      }
      if (template.status === "missing") {
        const graph = await ports.templateGraph(event);
        if (graph) {
          const submitted = await ensureEventTemplate(graph, event.flow, language, { create: true });
          if (submitted.status !== "rejected") {
            return await deferUnapprovedTemplate(ports, event, clearance);
          }
        }
      }
      if (template.status !== "approved") {
        return await skip(ports, event, "template_not_approved", clearance);
      }
      templateName = template.name;
    }
    const text = openerText(event.flow, language, event.payload);
    const intent = await ports.updateEvent(event.id, event.claim_token, {
      status: "sending",
      send_attempt_id: crypto.randomUUID(),
    });
    if (!intent) {
      if (reserved) await ports.releaseQr(event.social_account_id, event.id, event.claim_token);
      return "left";
    }
    sending = true;
    const sent = await ports.sendOpener({
      event,
      account: loaded,
      conversationId,
      language,
      text,
      templateName,
      components: templateName ? templateSendComponents(event.flow, language, event.payload, event.id) : [],
    });
    if (!sent.accepted) {
      if (!sent.definite) {
        const settled = await settleIndeterminate(ports, { ...event, status: "sending" });
        return settled ? "failed" : "left";
      }
      return await markFailed(ports, event, { reason: sent.reason, alert: false }, {
        account: loaded,
        thread,
        expected: openerState,
        reserved,
      });
    }
    const recordedId = await ports.updateEvent(event.id, event.claim_token, { outbound_message_id: sent.messageId });
    if (!recordedId) return "left";
    return await finishAccepted(ports, {
      event,
      account: loaded,
      threadId: thread.id,
      conversationId,
      messageId: sent.messageId,
      text,
    }, thread, openerState);
  } catch (error) {
    if (reserved && !sending && account) {
      try {
        await ports.releaseQr(event.social_account_id, event.id, event.claim_token);
      } catch {
        // The lease still returns the row; the cap slot is the smaller loss.
      }
    }
    console.error(
      `[process-store-events] ${event.id} stopped:`,
      sanitizeFailureReason(error instanceof Error ? error.message : "worker_error"),
    );
    return "left";
  }
}
