// Imports the conversation history Evolution already holds for a linked QR session.
//
// Baileys pushes nothing for messages that predate the link, so without this sweep the
// inbox only ever shows chats that happen to receive traffic after scanning. Everything
// here is idempotent: an interrupted run is re-run rather than resumed, which is why no
// cursor is persisted.

import type { EvolutionApi } from "./evolutionApi.ts";
import { addressableJid, buildEvolutionMessageRow, remoteNumberFor } from "./evolutionMessage.ts";

const LID_JID_SUFFIX = "@lid";
const DIRECT_JID_SUFFIX = "@s.whatsapp.net";
const CHAT_CONCURRENCY = 5;
const IMPORT_BATCH = 500;

// The whole sweep -- every chat, every page -- must fit inside the 300s lease, and the
// per-chat page ceiling alone cannot guarantee that: 20 sequential findMessages calls at
// a 10s timeout each is ~200s inside a single chat, and chats run CHAT_CONCURRENCY at a
// time. The budget stops short of the lease so the completion write still lands.
const SWEEP_BUDGET_MS = 240_000;

/** Contact numbers must not reach the logs. The last four digits are enough to correlate
 *  one chat's lines with each other while the number itself stays out. */
function maskNumber(number: string): string {
  return number.length <= 4 ? "***" : `***${number.slice(-4)}`;
}

export interface SyncAccount {
  id: string;
  user_id: string;
  workspace_id: string;
  platform_user_id: string;
}

export interface SyncOutcome {
  chatsDiscovered: number;
  chatsImported: number;
  chatsSkipped: number;
  /** One-to-one chats Evolution addressed only by LID, with no subscriber number in the
   *  record and no live message ingested yet to anchor them. They are real conversations,
   *  unlike the groups counted as skipped, and they unlock as the contact writes in. */
  chatsAwaitingLid: number;
  /** LID-only chats pinned to a number through a message the webhook already ingested. */
  chatsLidResolved: number;
  messagesWritten: number;
  chatFailures: number;
  truncated: boolean;
}

interface ChatSummary {
  /** The address Evolution files the chat's history under, which is what findMessages must
   *  be called with -- a LID chat's messages are stored under its LID, not its number. */
  remoteJid: string;
  /** The subscriber JID the chat resolves to. Equal to remoteJid for a phone-addressed
   *  chat; the alternate carried on its last message for a LID-addressed one. */
  address: string;
  number: string;
  conversationId: string;
  name: string | null;
  avatar: string | null;
  preview: string;
  lastMessageAt: string;
  unreadCount: number;
}

function lastMessageIso(chat: any): string {
  const seconds = Number(chat?.lastMessage?.messageTimestamp);
  if (Number.isFinite(seconds) && seconds > 0) return new Date(seconds * 1000).toISOString();
  return chat?.updatedAt ? new Date(chat.updatedAt).toISOString() : new Date(0).toISOString();
}

function previewOf(chat: any): string {
  const body = chat?.lastMessage?.message || {};
  return String(body.conversation || body.extendedTextMessage?.text || "").slice(0, 200);
}

// Evolution reports pushName as the contact's phone number for chats it has no real name
// for. Storing that would fill the inbox with rows whose "name" is their own number.
function realName(candidate: unknown, number: string): string | null {
  const name = typeof candidate === "string" ? candidate.trim() : "";
  if (!name || name === number) return null;
  return /^[\d\s+\-()]+$/.test(name) ? null : name;
}

interface ChatScan {
  summaries: ChatSummary[];
  /** LID-addressed one-to-one chats whose subscriber number appears nowhere in the record. */
  lidPending: any[];
}

function contactIndex(contacts: any[]): Map<string, any> {
  const contactByJid = new Map<string, any>();
  for (const contact of contacts) {
    if (contact?.remoteJid) contactByJid.set(contact.remoteJid, contact);
  }
  return contactByJid;
}

function summarize(chat: any, remoteJid: string, address: string, contact: any, account: SyncAccount): ChatSummary {
  const number = remoteNumberFor(address);
  return {
    remoteJid,
    address,
    number,
    conversationId: `wa_${account.platform_user_id}_${number}`,
    name: realName(contact?.pushName, number) ?? realName(chat?.pushName, number),
    avatar: contact?.profilePicUrl || chat?.profilePicUrl || null,
    preview: previewOf(chat),
    lastMessageAt: lastMessageIso(chat),
    unreadCount: Number(chat?.unreadCount) || 0,
  };
}

// A chat carries its address on itself, but the LID-to-number alternate only ever appears on
// a message key -- so the chat's own last message is the one place a LID-addressed chat can
// name its subscriber number.
function scanChats(chats: any[], contacts: any[], account: SyncAccount): ChatScan {
  const contactByJid = contactIndex(contacts);

  const scan: ChatScan = { summaries: [], lidPending: [] };
  for (const chat of chats) {
    const remoteJid = String(chat?.remoteJid || "");
    const address = addressableJid({
      remoteJid,
      remoteJidAlt: chat?.lastMessage?.key?.remoteJidAlt,
    });
    if (!address) {
      // A group or a newsletter is not a conversation this sweep imports at all; a LID chat
      // is one it cannot address from the record alone and gets a second chance below.
      if (remoteJid.endsWith(LID_JID_SUFFIX)) scan.lidPending.push(chat);
      continue;
    }
    const contact = contactByJid.get(address) ?? contactByJid.get(remoteJid);
    scan.summaries.push(summarize(chat, remoteJid, address, contact, account));
  }
  return scan;
}

/**
 * Evolution files a LID chat's history under the LID with no phone alias, but it normalises
 * LIVE webhook events to the phone JID. A message id present both in the chat's history and
 * in whatsapp_messages therefore pins the chat to the number the live event carried. Scoped
 * to this account: the same LID can belong to a different tenant's contact.
 */
/** Message id → subscriber number, for every id the webhook has already stored for this account. */
async function lookupAnchorNumbers(admin: any, accountId: string, ids: string[]): Promise<Map<string, string>> {
  const anchors = new Map<string, string>();
  if (ids.length === 0) return anchors;
  const { data, error } = await admin
    .from("whatsapp_messages")
    .select("message_id, conversation_id")
    .eq("social_account_id", accountId)
    .in("message_id", ids);
  if (error) throw error;
  for (const row of data ?? []) {
    const number = String(row.conversation_id ?? "").split("_").pop();
    if (number && /^\d+$/.test(number)) anchors.set(String(row.message_id), number);
  }
  return anchors;
}

function messageIdsOf(records: any[]): string[] {
  return records
    .map((record: any) => record?.key?.id)
    .filter((id: unknown): id is string => typeof id === "string" && id.length > 0);
}

/**
 * Two passes, cheapest first. The chat record already carries its last message id, so one
 * IN query anchors every LID chat whose newest message arrived live -- no Evolution call.
 * Only the leftovers get a one-page probe, and those run CHAT_CONCURRENCY at a time: an
 * account with 255 LID chats probed one by one would spend the whole sweep budget here
 * and import nothing.
 */
async function resolveLidChats(deps: {
  admin: any;
  api: EvolutionApi;
  account: SyncAccount;
  instanceName: string;
  contacts: any[];
  pending: any[];
  deadlineAt: number;
}): Promise<{ resolved: ChatSummary[]; awaiting: number }> {
  const { admin, api, account, instanceName, contacts, pending, deadlineAt } = deps;
  const contactByJid = contactIndex(contacts);
  const resolved: ChatSummary[] = [];
  const adopt = (chat: any, number: string) => {
    const remoteJid = String(chat?.remoteJid || "");
    resolved.push(summarize(chat, remoteJid, `${number}${DIRECT_JID_SUFFIX}`, contactByJid.get(remoteJid), account));
  };

  const lastIds = new Map<any, string>();
  for (const chat of pending) {
    const id = chat?.lastMessage?.key?.id;
    if (typeof id === "string" && id) lastIds.set(chat, id);
  }
  const fromRecords = await lookupAnchorNumbers(admin, account.id, [...lastIds.values()]);
  const leftovers: any[] = [];
  for (const chat of pending) {
    const number = fromRecords.get(lastIds.get(chat) ?? "");
    if (number) adopt(chat, number);
    else leftovers.push(chat);
  }

  let awaiting = 0;
  for (let index = 0; index < leftovers.length; index += CHAT_CONCURRENCY) {
    if (Date.now() >= deadlineAt) {
      awaiting += leftovers.length - index;
      break;
    }
    const batch = leftovers.slice(index, index + CHAT_CONCURRENCY);
    const probes = await Promise.all(batch.map(async (chat) => {
      const remoteJid = String(chat?.remoteJid || "");
      try {
        // One page is enough: a live message, when there is one, is among the newest.
        const page = await api.findMessages(instanceName, remoteJid, { deadlineAt, pageCeiling: 1 });
        return { chat, ids: messageIdsOf(page.records) };
      } catch (error) {
        console.error(
          `[whatsapp-sync] ${instanceName} LID probe failed:`,
          error instanceof Error ? error.message : error,
        );
        return { chat, ids: [] as string[] };
      }
    }));
    const fromProbes = await lookupAnchorNumbers(admin, account.id, probes.flatMap((probe) => probe.ids));
    for (const probe of probes) {
      const number = probe.ids.map((id) => fromProbes.get(id)).find(Boolean);
      if (number) adopt(probe.chat, number);
      else awaiting += 1;
    }
  }
  return { resolved, awaiting };
}

// The conflict rules live in SQL (import_whatsapp_* ) rather than here. Deciding them in
// application code meant reading a row and then writing it, which could not see a contact in
// another workspace, raced a live webhook advancing a conversation, and overwrote values a
// historical record does not carry.
async function importRows(admin: any, fn: string, rows: unknown[]): Promise<number> {
  if (rows.length === 0) return 0;
  let affected = 0;
  for (let index = 0; index < rows.length; index += IMPORT_BATCH) {
    const { data, error } = await admin.rpc(fn, { p_rows: rows.slice(index, index + IMPORT_BATCH) });
    if (error) throw error;
    affected += Number(data) || 0;
  }
  return affected;
}

function conversationRows(account: SyncAccount, chats: ChatSummary[]): Record<string, unknown>[] {
  return chats.map((chat) => ({
    user_id: account.user_id,
    workspace_id: account.workspace_id,
    social_account_id: account.id,
    conversation_id: chat.conversationId,
    participant_name: chat.name || chat.number,
    participant_avatar: chat.avatar,
    last_message_preview: chat.preview,
    last_message_at: chat.lastMessageAt,
    unread_count: chat.unreadCount,
  }));
}

function contactRows(account: SyncAccount, chats: ChatSummary[]): Record<string, unknown>[] {
  return chats.filter((chat) => chat.name).map((chat) => ({
    user_id: account.user_id,
    workspace_id: account.workspace_id,
    phone_number: chat.number,
    display_name: chat.name,
    avatar_url: chat.avatar,
    last_message_at: chat.lastMessageAt,
  }));
}

function messageRows(
  account: SyncAccount,
  records: any[],
  addressFallback: string,
): Record<string, unknown>[] {
  // Evolution can return the same message id twice in one page, and Postgres rejects an
  // ON CONFLICT statement whose payload touches a row twice (SQLSTATE 21000), failing the
  // whole batch rather than the duplicate.
  const byMessageId = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    const row = buildEvolutionMessageRow(account, record, addressFallback)?.row;
    if (row) byMessageId.set(String(row.message_id), row);
  }
  return [...byMessageId.values()];
}

export async function syncEvolutionHistory(deps: {
  admin: any;
  api: EvolutionApi;
  account: SyncAccount;
  instanceName: string;
  deadlineAt?: number;
}): Promise<SyncOutcome> {
  const { admin, api, account, instanceName } = deps;
  const deadlineAt = deps.deadlineAt ?? Date.now() + SWEEP_BUDGET_MS;
  const [chats, contacts] = await Promise.all([
    api.findChats(instanceName),
    api.findContacts(instanceName),
  ]);

  const { summaries: direct, lidPending } = scanChats(chats, contacts, account);
  const lid = await resolveLidChats({
    admin, api, account, instanceName, contacts, pending: lidPending, deadlineAt,
  });
  const summaries = [...direct, ...lid.resolved];
  const outcome: SyncOutcome = {
    chatsDiscovered: chats.length,
    chatsImported: summaries.length,
    chatsSkipped: chats.length - direct.length - lidPending.length,
    chatsAwaitingLid: lid.awaiting,
    chatsLidResolved: lid.resolved.length,
    messagesWritten: 0,
    chatFailures: 0,
    truncated: false,
  };
  // Their history stays unreachable until the contact writes in once: Evolution files it
  // under the LID and only a live, phone-normalised message can anchor it. Saying so is the
  // difference between a user reading "sync finished" and understanding what is missing.
  if (lid.awaiting > 0) {
    console.log(
      `[whatsapp-sync] ${instanceName}: ${lid.awaiting} one-to-one chat(s) are LID-addressed with no ` +
        `live message yet and were not imported`,
    );
  }
  if (summaries.length === 0) return outcome;

  await importRows(admin, "import_whatsapp_conversations", conversationRows(account, summaries));
  await importRows(admin, "import_whatsapp_contacts", contactRows(account, summaries));

  let chatsSwept = 0;
  for (let index = 0; index < summaries.length; index += CHAT_CONCURRENCY) {
    // Checked before each batch rather than only between chats: without this the sweep
    // would keep starting new batches while earlier ones slowly exhausted the budget.
    if (Date.now() >= deadlineAt) {
      outcome.truncated = true;
      break;
    }
    await Promise.all(summaries.slice(index, index + CHAT_CONCURRENCY).map(async (chat) => {
      // And between chats: a batch that outlived the budget must not drag the rest of
      // its own batch past the deadline too.
      if (Date.now() >= deadlineAt) {
        outcome.truncated = true;
        return;
      }
      try {
        const page = await api.findMessages(instanceName, chat.remoteJid, { deadlineAt });
        // A chat that stopped at its deadline or page ceiling has more history waiting.
        // Carrying that up is what stops the completion write below from claiming the
        // account is fully imported when it is not.
        if (!page.complete) outcome.truncated = true;
        // The chat's address, not each key's: see buildEvolutionMessageRow.
        const rows = messageRows(account, page.records, chat.address);
        await importRows(admin, "import_whatsapp_messages", rows);
        outcome.messagesWritten += rows.length;
      } catch (error) {
        // One unreachable chat must not abandon the other three hundred.
        outcome.chatFailures += 1;
        // chat.number is a contact's phone number. The instance plus a masked suffix is
        // enough to correlate the failure across log lines without putting someone's
        // number in a log that outlives the request.
        console.error(
          `[whatsapp-sync] ${instanceName} chat ${maskNumber(chat.number)} failed:`,
          error instanceof Error ? error.message : error,
        );
        return;
      }
      chatsSwept += 1;
    }));
  }
  // A truncated run did not fail -- it stopped. Logging the split is what separates
  // "imported everything" from "imported what fit in the budget".
  if (outcome.truncated) {
    console.log(
      `[whatsapp-sync] ${instanceName}: deadline reached at ${chatsSwept}/${summaries.length} chats, ` +
        `${summaries.length - chatsSwept} not reached; sweep recorded as incomplete`,
    );
  }

  return outcome;
}

// Both the connection webhook and the QR status poller decide to import on the same signal,
// and the manual action can arrive at any time, so the claim and the completion record live
// with the sweep rather than at each call site.
const LEASE_SECONDS = 300;

export async function importEvolutionHistory(deps: {
  admin: any;
  api: EvolutionApi;
  account: SyncAccount;
  instanceName: string;
  deadlineAt?: number;
}): Promise<void> {
  const { admin, account, instanceName } = deps;
  // Both exits are silent by nature -- a misconfigured account and a sweep already running
  // look identical to a caller that only sees "started".
  if (!account.workspace_id) {
    console.log(`[whatsapp-sync] ${instanceName}: skipped, account has no workspace`);
    return;
  }
  // Conversation ids embed this value, so importing under the provisional placeholder would
  // write every chat under an id the reply path cannot parse and then mark the sweep done.
  if (account.platform_user_id.startsWith("pending_")) {
    console.log(`[whatsapp-sync] ${instanceName}: skipped, owner number not resolved yet`);
    return;
  }
  const { data: claimed, error: claimError } = await admin.rpc("claim_whatsapp_history_sync", {
    p_social_account_id: account.id,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (claimError) throw claimError;
  if (claimed !== true) {
    console.log(`[whatsapp-sync] ${instanceName}: skipped, another sweep holds the lease`);
    return;
  }

  // The lease is released even when the sweep throws. Without this a single failure holds it
  // for its full duration, and because a held lease returns early and silently, every retry
  // in that window reports success while doing nothing.
  const completion: Record<string, unknown> = { sync_started_at: null };
  try {
    const outcome = await syncEvolutionHistory(deps);
    console.log(`[whatsapp-sync] ${instanceName}: ${JSON.stringify(outcome)}`);
    // The setup page polls this to tell the user what the button they pressed achieved.
    completion.last_sync_outcome = { ...outcome, finished_at: new Date().toISOString() };
    // Completion needs evidence the history was actually there. Baileys can publish the chat
    // list before it has loaded any messages, so a sweep that found 300 conversations and
    // zero messages has not succeeded -- recording it would permanently disable the retry
    // that a warming session depends on. Leaving last_sync_at unset lets a later trigger try
    // again, while the lease keeps that retry to once per lease window rather than once per
    // status poll. A deadline-truncated sweep has zero failures -- it stopped, it did not
    // fail -- so without the explicit truncated outcome it would satisfy this test, stamp
    // completion, and permanently skip every chat it never reached.
    const sweptCleanly = outcome.chatsImported > 0 && outcome.chatFailures === 0 && !outcome.truncated;
    if (sweptCleanly && outcome.messagesWritten > 0) {
      completion.last_sync_at = new Date().toISOString();
    }
  } catch (error) {
    // The user pressed a button and deserves to see why nothing arrived. The text is
    // Evolution's or Postgres's error message, never a credential.
    completion.last_sync_outcome = {
      finished_at: new Date().toISOString(),
      error: error instanceof Error ? error.message.slice(0, 200) : "sync failed",
    };
    throw error;
  } finally {
    // A rejected completion (e.g. a column the deployed schema lacks) would otherwise leave
    // the lease held and the outcome lost with nothing in the logs to say so.
    const { error: completionError } = await admin
      .from("whatsapp_evolution_instances")
      .update(completion)
      .eq("social_account_id", account.id);
    if (completionError) {
      console.error(`[whatsapp-sync] ${instanceName}: completion write failed:`, completionError.message ?? completionError);
    }
  }
}
