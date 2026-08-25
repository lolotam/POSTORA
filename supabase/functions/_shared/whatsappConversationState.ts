// Viewer flags + the mutable-field overlay for a WhatsApp conversation.
//
// Browser RLS on whatsapp_messages is owner-only, so a workspace agent cannot
// join through it to scope flags by conversation or discover pins outside the
// loaded pages. Both payloads share one action so a teammate's revoke, a
// delivery-status change, and a late AI description land on the same 15s poll
// as latest — without a second request, and without waiting for a reopen.
// Spec: docs/specs/2026-08-25-whatsapp-chat-experience.md §6, §7.

import { conversationIdsForFilter } from "./whatsappMessagePage.ts";
import type { WhatsAppAccountAccess } from "./whatsappWorkspaceAccess.ts";

export const MAX_CONVERSATION_STATE_IDS = 500;
const PINNED_PREVIEW_CHARS = 120;

export interface ConversationStateRequest {
  conversationId: string;
  messageRowIds: unknown[];
}

export interface MessageFlagView {
  message_row_id: string;
  pinned_at: string | null;
  hidden_at: string | null;
}

export interface PinnedMessageView {
  message_row_id: string;
  preview: string;
  timestamp: string | null;
}

export interface MutableMessageView {
  message_row_id: string;
  revoked_at: string | null;
  revoked_by: string | null;
  status: string | null;
  media_understanding: string | null;
}

export interface ConversationStateView {
  flags: MessageFlagView[];
  pinned: PinnedMessageView[];
  mutable: MutableMessageView[];
}

export interface SetMessageFlagRequest {
  conversationId: string;
  messageRowId: string;
  pinned?: boolean;
  hidden?: boolean;
}

export interface SetMessageFlagView {
  flag: MessageFlagView;
}

function uniqueIds(values: unknown[], cap: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= cap) break;
  }
  return out;
}

function asIso(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function pinnedPreview(row: {
  message_text?: string | null;
  media_type?: string | null;
}): string {
  const text = (row.message_text ?? "").trim();
  if (text) {
    return text.length > PINNED_PREVIEW_CHARS
      ? `${text.slice(0, PINNED_PREVIEW_CHARS - 3)}...`
      : text;
  }
  if (row.media_type) return `[${row.media_type}]`;
  return "";
}

function conversationFilterIds(conversationId: string): string[] {
  const normalized = conversationId.replace(/_\+/g, "_");
  return conversationIdsForFilter(normalized, conversationId);
}

export async function getWhatsAppConversationState(
  // deno-lint-ignore no-explicit-any
  admin: any,
  access: WhatsAppAccountAccess,
  viewerUserId: string,
  request: ConversationStateRequest,
): Promise<ConversationStateView> {
  const conversationIds = conversationFilterIds(request.conversationId);
  const requestedIds = uniqueIds(request.messageRowIds, MAX_CONVERSATION_STATE_IDS);

  const mutable = await loadMutableOverlay(admin, access.accountId, conversationIds, requestedIds);
  const scopedIds = new Set(mutable.map((row) => row.message_row_id));
  const flags = await loadViewerFlags(admin, viewerUserId, [...scopedIds]);
  const pinned = await loadPinnedBar(admin, access.accountId, conversationIds, viewerUserId);

  return { flags, pinned, mutable };
}

export async function setWhatsAppMessageFlag(
  // deno-lint-ignore no-explicit-any
  admin: any,
  access: WhatsAppAccountAccess,
  viewerUserId: string,
  request: SetMessageFlagRequest,
): Promise<SetMessageFlagView> {
  const conversationIds = conversationFilterIds(request.conversationId);
  const { data: message, error: messageError } = await admin
    .from("whatsapp_messages")
    .select("id")
    .eq("id", request.messageRowId)
    .eq("social_account_id", access.accountId)
    .in("conversation_id", conversationIds)
    .maybeSingle();
  if (messageError) throw messageError;
  if (!message) throw new Error("Message not found");

  const { data: existing, error: existingError } = await admin
    .from("whatsapp_message_flags")
    .select("message_row_id, pinned_at, hidden_at")
    .eq("user_id", viewerUserId)
    .eq("message_row_id", request.messageRowId)
    .maybeSingle();
  if (existingError) throw existingError;

  const next = nextFlag(existing, request);
  const { data: upserted, error: upsertError } = await admin
    .from("whatsapp_message_flags")
    .upsert({
      user_id: viewerUserId,
      message_row_id: request.messageRowId,
      pinned_at: next.pinned_at,
      hidden_at: next.hidden_at,
    }, { onConflict: "user_id,message_row_id" })
    .select("message_row_id, pinned_at, hidden_at")
    .maybeSingle();
  if (upsertError) throw upsertError;

  return {
    flag: {
      message_row_id: request.messageRowId,
      pinned_at: asIso(upserted?.pinned_at) ?? next.pinned_at,
      hidden_at: asIso(upserted?.hidden_at) ?? next.hidden_at,
    },
  };
}

function nextFlag(
  existing: { pinned_at?: string | null; hidden_at?: string | null } | null,
  request: SetMessageFlagRequest,
): MessageFlagView {
  let pinnedAt = asIso(existing?.pinned_at);
  let hiddenAt = asIso(existing?.hidden_at);
  const now = new Date().toISOString();

  if (request.pinned === true) pinnedAt = now;
  if (request.pinned === false) pinnedAt = null;
  if (request.hidden === false) hiddenAt = null;
  // Hide also unpins: otherwise the bar keeps advertising a message the thread has dropped.
  if (request.hidden === true) {
    hiddenAt = now;
    pinnedAt = null;
  }

  return { message_row_id: request.messageRowId, pinned_at: pinnedAt, hidden_at: hiddenAt };
}

async function loadMutableOverlay(
  // deno-lint-ignore no-explicit-any
  admin: any,
  accountId: string,
  conversationIds: string[],
  messageRowIds: string[],
): Promise<MutableMessageView[]> {
  if (messageRowIds.length === 0) return [];
  const { data, error } = await admin
    .from("whatsapp_messages")
    .select("id, revoked_at, revoked_by, status, media_understanding")
    .eq("social_account_id", accountId)
    .in("conversation_id", conversationIds)
    .in("id", messageRowIds);
  if (error) throw error;
  return (data ?? []).map((row: Record<string, unknown>) => ({
    message_row_id: String(row.id),
    revoked_at: asIso(row.revoked_at),
    revoked_by: asIso(row.revoked_by),
    status: asIso(row.status),
    media_understanding: asIso(row.media_understanding),
  }));
}

async function loadViewerFlags(
  // deno-lint-ignore no-explicit-any
  admin: any,
  viewerUserId: string,
  messageRowIds: string[],
): Promise<MessageFlagView[]> {
  if (messageRowIds.length === 0) return [];
  const { data, error } = await admin
    .from("whatsapp_message_flags")
    .select("message_row_id, pinned_at, hidden_at")
    .eq("user_id", viewerUserId)
    .in("message_row_id", messageRowIds);
  if (error) throw error;
  return (data ?? []).map((row: Record<string, unknown>) => ({
    message_row_id: String(row.message_row_id),
    pinned_at: asIso(row.pinned_at),
    hidden_at: asIso(row.hidden_at),
  }));
}

async function loadPinnedBar(
  // deno-lint-ignore no-explicit-any
  admin: any,
  accountId: string,
  conversationIds: string[],
  viewerUserId: string,
): Promise<PinnedMessageView[]> {
  const { data: pinRows, error: pinError } = await admin
    .from("whatsapp_message_flags")
    .select("message_row_id, pinned_at, hidden_at")
    .eq("user_id", viewerUserId)
    .not("pinned_at", "is", null);
  if (pinError) throw pinError;
  const pinIds = (pinRows ?? [])
    .filter((row: Record<string, unknown>) => row.hidden_at == null)
    .map((row: Record<string, unknown>) => String(row.message_row_id));
  if (pinIds.length === 0) return [];

  const { data: messages, error: messageError } = await admin
    .from("whatsapp_messages")
    .select("id, message_text, timestamp, media_type")
    .eq("social_account_id", accountId)
    .in("conversation_id", conversationIds)
    .in("id", pinIds);
  if (messageError) throw messageError;

  const pinnedAtById = new Map(
    (pinRows ?? []).map((row: Record<string, unknown>) => [String(row.message_row_id), asIso(row.pinned_at)]),
  );
  return (messages ?? [])
    .map((row: Record<string, unknown>) => ({
      message_row_id: String(row.id),
      preview: pinnedPreview({
        message_text: asIso(row.message_text),
        media_type: asIso(row.media_type),
      }),
      timestamp: asIso(row.timestamp),
      pinned_at: pinnedAtById.get(String(row.id)) ?? "",
    }))
    .sort((left: { pinned_at: string }, right: { pinned_at: string }) =>
      right.pinned_at.localeCompare(left.pinned_at)
    )
    .map(({ message_row_id, preview, timestamp }: PinnedMessageView) => ({
      message_row_id,
      preview,
      timestamp,
    }));
}
