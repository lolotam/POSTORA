// Store-event opener worker (Spec B §8.3–8.5). Every I/O is a port.
import { whatsappConversationId, type WhatsAppAddressing } from "../_shared/phone.ts";
import { resolveEngagementMode } from "../ai-agent-reply/logic.ts";
import { expireIfStale, isPendingOpener, type ProcedureState } from "../_shared/procedures/engine.ts";
import { templateSendComponents, type TemplateResolution } from "../_shared/procedures/eventTemplates.ts";
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
  optedOut: boolean;
}

export interface StoreSnapshot {
  paymentMethod: string;
  status: string;
  phone: string | null;
  createdAt: string | null;
  stockStatus: string | null;
}

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

export interface WorkerPorts {
  now(): number;
  claim(limit: number, lease: string): Promise<StoreEventRow[]>;
  /** False when id + claim_token no longer match: the update touched nothing. */
  updateEvent(id: string, claimToken: string, patch: Record<string, unknown>): Promise<boolean>;
  releaseClaim(id: string, claimToken: string): Promise<boolean>;
  loadAccount(event: StoreEventRow): Promise<AccountContext | null>;
  readStore(event: StoreEventRow): Promise<StoreSnapshot | null>;
  reserveQr(accountId: string, limit: number): Promise<boolean>;
  releaseQr(accountId: string): Promise<void>;
  ensureThread(input: { userId: string; conversationId: string }): Promise<ThreadRow>;
  persistState(threadId: string, expected: unknown, next: unknown): Promise<boolean>;
  templateStatus(event: StoreEventRow, language: OpenerLanguage): Promise<TemplateResolution>;
  sendOpener(input: SendOpenerInput): Promise<SendOutcome>;
  recordOpener(input: RecordOpenerInput): Promise<void>;
  deleteWaitlist(event: StoreEventRow): Promise<void>;
  alertAdmin(event: StoreEventRow, reason: string): Promise<void>;
  purge(nowMs: number): Promise<void>;
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
  if (account.optedOut) return "opted_out";
  const due = Date.parse(event.due_at);
  if (!Number.isFinite(due) || due + STALE_AFTER_MS < nowMs) return "expired";
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
  if (flow === "review_request") return snapshot.status === "completed" ? null : "review_not_completed";
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

function addressing(account: AccountContext): WhatsAppAddressing {
  return {
    mode: account.connectionMode === "evolution_qr"
      ? "evolution_qr"
      : account.connectionMode === "coexistence" ? "coexistence" : "cloud_api",
    phoneNumberId: account.phoneNumberId,
    platformUserId: account.platformUserId,
  };
}

function pendingState(event: StoreEventRow, nowMs: number): ProcedureState {
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
    started_at: at,
    updated_at: at,
  };
}

async function clearPending(ports: WorkerPorts, thread: ThreadRow, eventId: string, expected: ProcedureState | null): Promise<void> {
  const state = expected ?? (isPendingOpener(thread.procedure_state) ? thread.procedure_state as ProcedureState : null);
  if (!state || state.run_id !== eventId || state.phase !== "pending_opener") return;
  await ports.persistState(thread.id, state, null);
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
      if (await settleIndeterminate(ports, event)) summary.failed += 1;
      continue;
    }
    if (ports.now() - started >= limits.tickBudgetMs) {
      if (await ports.releaseClaim(event.id, event.claim_token)) summary.released += 1;
      continue;
    }
    const outcome = await processClaimed(ports, event, limits.qrDailyCap);
    if (outcome !== "left") summary[outcome] += 1;
  }
  await ports.purge(ports.now());
  return summary;
}

async function settleIndeterminate(ports: WorkerPorts, event: StoreEventRow): Promise<boolean> {
  const marked = await ports.updateEvent(event.id, event.claim_token, {
    status: "failed",
    skip_reason: "indeterminate",
    processed_at: iso(ports.now()),
  });
  if (!marked) return false;
  try {
    const account = await ports.loadAccount(event);
    const phone = event.payload.phone;
    if (account?.platform === "whatsapp" && account.connectionMode && account.platformUserId && phone) {
      const conversationId = whatsappConversationId(addressing(account), phone);
      const thread = await ports.ensureThread({ userId: event.user_id, conversationId });
      await clearPending(ports, thread, event.id, null);
    }
  } catch (error) {
    console.error(
      `[process-store-events] ${event.id} state clear failed:`,
      sanitizeFailureReason(error instanceof Error ? error.message : "state_clear_failed"),
    );
  }
  await ports.alertAdmin(event, "indeterminate");
  return true;
}

async function skip(ports: WorkerPorts, event: StoreEventRow, reason: string): Promise<boolean> {
  return await ports.updateEvent(event.id, event.claim_token, {
    status: "skipped",
    skip_reason: reason,
    processed_at: iso(ports.now()),
  });
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
    const early = accountSkipReason(event, account, ports.now());
    if (early) {
      await skip(ports, event, early);
      return "skipped";
    }
    const loaded = account!;
    const storeReason = storeSkipReason(event.flow, event.payload, await ports.readStore(event), ports.now());
    if (storeReason) {
      await skip(ports, event, storeReason);
      return "skipped";
    }
    if (loaded.connectionMode === "evolution_qr") {
      reserved = await ports.reserveQr(event.social_account_id, qrCap);
      if (!reserved) {
        await skip(ports, event, "qr_daily_cap");
        return "skipped";
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
      if (reserved) await ports.releaseQr(event.social_account_id);
      await skip(ports, event, "flow_active");
      return "skipped";
    }
    if (live?.phase === "active") {
      if (reserved) await ports.releaseQr(event.social_account_id);
      const finished = await ports.updateEvent(event.id, event.claim_token, { status: "sent", processed_at: iso(ports.now()) });
      return finished ? "sent" : "left";
    }
    if (live?.phase === "pending_opener") {
      openerState = live;
    } else {
      openerState = pendingState(event, ports.now());
      const started = await ports.persistState(thread.id, thread.procedure_state ?? null, openerState);
      if (!started) {
        if (reserved) await ports.releaseQr(event.social_account_id);
        if (await ports.releaseClaim(event.id, event.claim_token)) return "released";
        return "left";
      }
    }
    const language = openerLanguage(loaded.languageMode);
    let templateName: string | null = null;
    if (loaded.connectionMode !== "evolution_qr") {
      const template = await ports.templateStatus(event, language);
      if (template.status !== "approved") {
        await clearPending(ports, thread, event.id, openerState);
        if (reserved) await ports.releaseQr(event.social_account_id);
        await skip(ports, event, "template_not_approved");
        return "skipped";
      }
      templateName = template.name;
    }
    const text = openerText(event.flow, language, event.payload);
    const intent = await ports.updateEvent(event.id, event.claim_token, {
      status: "sending",
      send_attempt_id: crypto.randomUUID(),
    });
    if (!intent) {
      if (reserved) await ports.releaseQr(event.social_account_id);
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
        await settleIndeterminate(ports, { ...event, status: "sending" });
        return "failed";
      }
      await clearPending(ports, thread, event.id, openerState);
      if (reserved) await ports.releaseQr(event.social_account_id);
      await ports.updateEvent(event.id, event.claim_token, {
        status: "failed",
        skip_reason: sanitizeFailureReason(sent.reason),
        processed_at: iso(ports.now()),
      });
      return "failed";
    }
    const recordedId = await ports.updateEvent(event.id, event.claim_token, { outbound_message_id: sent.messageId });
    if (!recordedId) return "left";
    const active: ProcedureState = { ...openerState, phase: "active", updated_at: iso(ports.now()) };
    await ports.persistState(thread.id, openerState, active);
    await ports.recordOpener({
      event, account: loaded, threadId: thread.id, conversationId, messageId: sent.messageId, text,
    });
    if (event.flow === "back_in_stock") await ports.deleteWaitlist(event);
    const done = await ports.updateEvent(event.id, event.claim_token, { status: "sent", processed_at: iso(ports.now()) });
    return done ? "sent" : "left";
  } catch (error) {
    if (reserved && !sending && account) {
      try {
        await ports.releaseQr(event.social_account_id);
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
