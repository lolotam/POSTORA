// Imports the conversation history Evolution already holds for a linked QR session.
//
// Baileys pushes nothing for messages that predate the link, so without this sweep the
// inbox only ever shows chats that happen to receive traffic after scanning. Everything
// here is idempotent: an interrupted run is re-run rather than resumed, which is why no
// cursor is persisted.

import type { EvolutionApi } from "./evolutionApi.ts";
import { buildEvolutionMessageRow, remoteNumberFor } from "./evolutionMessage.ts";

const DIRECT_JID_SUFFIX = "@s.whatsapp.net";
const CHAT_CONCURRENCY = 5;
const IMPORT_BATCH = 500;

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
  messagesWritten: number;
  chatFailures: number;
}

interface ChatSummary {
  remoteJid: string;
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

async function inChunks<T>(items: T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  for (let index = 0; index < items.length; index += size) {
    await Promise.all(items.slice(index, index + size).map(run));
  }
}

function summarizeChats(chats: any[], contacts: any[], account: SyncAccount): ChatSummary[] {
  const contactByJid = new Map<string, any>();
  for (const contact of contacts) {
    if (contact?.remoteJid) contactByJid.set(contact.remoteJid, contact);
  }

  return chats
    .filter((chat) => String(chat?.remoteJid || "").endsWith(DIRECT_JID_SUFFIX))
    .map((chat) => {
      const remoteJid = String(chat.remoteJid);
      const number = remoteNumberFor(remoteJid);
      const contact = contactByJid.get(remoteJid);
      return {
        remoteJid,
        number,
        conversationId: `wa_${account.platform_user_id}_${number}`,
        name: realName(contact?.pushName, number) ?? realName(chat?.pushName, number),
        avatar: contact?.profilePicUrl || chat?.profilePicUrl || null,
        preview: previewOf(chat),
        lastMessageAt: lastMessageIso(chat),
        unreadCount: Number(chat?.unreadCount) || 0,
      };
    });
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

function messageRows(account: SyncAccount, records: any[]): Record<string, unknown>[] {
  // Evolution can return the same message id twice in one page, and Postgres rejects an
  // ON CONFLICT statement whose payload touches a row twice (SQLSTATE 21000), failing the
  // whole batch rather than the duplicate.
  const byMessageId = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    const row = buildEvolutionMessageRow(account, record)?.row;
    if (row) byMessageId.set(String(row.message_id), row);
  }
  return [...byMessageId.values()];
}

export async function syncEvolutionHistory(deps: {
  admin: any;
  api: EvolutionApi;
  account: SyncAccount;
  instanceName: string;
}): Promise<SyncOutcome> {
  const { admin, api, account, instanceName } = deps;
  const [chats, contacts] = await Promise.all([
    api.findChats(instanceName),
    api.findContacts(instanceName),
  ]);

  const summaries = summarizeChats(chats, contacts, account);
  const outcome: SyncOutcome = {
    chatsDiscovered: chats.length,
    chatsImported: summaries.length,
    chatsSkipped: chats.length - summaries.length,
    messagesWritten: 0,
    chatFailures: 0,
  };
  if (summaries.length === 0) return outcome;

  await importRows(admin, "import_whatsapp_conversations", conversationRows(account, summaries));
  await importRows(admin, "import_whatsapp_contacts", contactRows(account, summaries));

  await inChunks(summaries, CHAT_CONCURRENCY, async (chat) => {
    try {
      const records = await api.findMessages(instanceName, chat.remoteJid);
      const rows = messageRows(account, records);
      await importRows(admin, "import_whatsapp_messages", rows);
      outcome.messagesWritten += rows.length;
    } catch (error) {
      // One unreachable chat must not abandon the other three hundred.
      outcome.chatFailures += 1;
      console.error(`[whatsapp-sync] ${chat.number} failed:`, error instanceof Error ? error.message : error);
    }
  });

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
    // Completion needs evidence the history was actually there. Baileys can publish the chat
    // list before it has loaded any messages, so a sweep that found 300 conversations and
    // zero messages has not succeeded -- recording it would permanently disable the retry
    // that a warming session depends on. Leaving last_sync_at unset lets a later trigger try
    // again, while the lease keeps that retry to once per lease window rather than once per
    // status poll.
    const sweptCleanly = outcome.chatsImported > 0 && outcome.chatFailures === 0;
    if (sweptCleanly && outcome.messagesWritten > 0) {
      completion.last_sync_at = new Date().toISOString();
    }
  } finally {
    await admin.from("whatsapp_evolution_instances").update(completion).eq("social_account_id", account.id);
  }
}
