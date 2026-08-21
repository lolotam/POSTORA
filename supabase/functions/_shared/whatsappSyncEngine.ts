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
const MESSAGE_BATCH = 500;

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

async function writeConversations(admin: any, account: SyncAccount, chats: ChatSummary[]): Promise<number> {
  const { data: existingRows } = await admin
    .from("messaging_cache")
    .select("conversation_id, unread_count, last_message_at, participant_name")
    .eq("social_account_id", account.id)
    .eq("platform", "whatsapp");
  const existing = new Map<string, any>((existingRows || []).map((row: any) => [row.conversation_id, row]));

  const rows = chats
    // A sweep must never walk back over live webhook state: an older history record does
    // not get to overwrite a preview or timestamp the webhook has already advanced.
    .filter((chat) => {
      const prior = existing.get(chat.conversationId);
      return !prior || !prior.last_message_at || chat.lastMessageAt > prior.last_message_at;
    })
    .map((chat) => {
      const prior = existing.get(chat.conversationId);
      return {
        user_id: account.user_id,
        workspace_id: account.workspace_id,
        social_account_id: account.id,
        conversation_id: chat.conversationId,
        platform: "whatsapp",
        participant_name: chat.name || prior?.participant_name || chat.number,
        participant_avatar: chat.avatar,
        last_message_preview: chat.preview,
        last_message_at: chat.lastMessageAt,
        // Evolution reports 0 unread for every chat, so adopting its value on an existing
        // conversation would clear unread messages that arrived since the link.
        unread_count: prior ? prior.unread_count : chat.unreadCount,
        updated_at: new Date().toISOString(),
      };
    });

  if (rows.length === 0) return 0;
  const { error } = await admin.from("messaging_cache").upsert(rows, { onConflict: "user_id,conversation_id" });
  if (error) throw error;
  return rows.length;
}

async function writeContacts(admin: any, account: SyncAccount, chats: ChatSummary[]): Promise<void> {
  const named = chats.filter((chat) => chat.name);
  if (named.length === 0) return;

  const { data: existingRows } = await admin
    .from("whatsapp_contacts")
    .select("phone_number, display_name")
    .eq("workspace_id", account.workspace_id)
    .in("phone_number", named.map((chat) => chat.number));
  const existing = new Map<string, any>((existingRows || []).map((row: any) => [row.phone_number, row]));

  // A name the user has edited in the CRM outranks whatever WhatsApp reports.
  const rows = named
    .filter((chat) => {
      const prior = existing.get(chat.number);
      return !prior || !prior.display_name || prior.display_name === chat.number;
    })
    .map((chat) => ({
      user_id: account.user_id,
      workspace_id: account.workspace_id,
      phone_number: chat.number,
      display_name: chat.name,
      avatar_url: chat.avatar,
      last_message_at: chat.lastMessageAt,
    }));

  if (rows.length === 0) return;
  const { error } = await admin.from("whatsapp_contacts").upsert(rows, { onConflict: "user_id,phone_number" });
  if (error) throw error;
}

async function writeMessages(admin: any, account: SyncAccount, records: any[]): Promise<number> {
  const rows = records
    .map((record) => buildEvolutionMessageRow(account, record)?.row)
    .filter((row): row is Record<string, unknown> => Boolean(row));

  let written = 0;
  for (let index = 0; index < rows.length; index += MESSAGE_BATCH) {
    const batch = rows.slice(index, index + MESSAGE_BATCH);
    // Merged rather than ignored on conflict: relinking the same WhatsApp identity under a
    // new social_accounts row must rebind existing messages to it, or the rebuilt
    // conversations read as empty because the inbox filters messages by account.
    const { error } = await admin.from("whatsapp_messages").upsert(batch, { onConflict: "user_id,message_id" });
    if (error) throw error;
    written += batch.length;
  }
  return written;
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

  await writeConversations(admin, account, summaries);
  await writeContacts(admin, account, summaries);

  await inChunks(summaries, CHAT_CONCURRENCY, async (chat) => {
    try {
      const records = await api.findMessages(instanceName, chat.remoteJid);
      outcome.messagesWritten += await writeMessages(admin, account, records);
    } catch (error) {
      // One unreachable chat must not abandon the other three hundred.
      outcome.chatFailures += 1;
      console.error(`[whatsapp-sync] ${chat.number} failed:`, error instanceof Error ? error.message : error);
    }
  });

  return outcome;
}
