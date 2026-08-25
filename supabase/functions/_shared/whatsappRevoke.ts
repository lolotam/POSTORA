// Delete-for-everyone: provider call + local tombstone, with a reconciliation
// that actually repairs "provider succeeded, local write failed".
// Spec: docs/specs/2026-08-25-whatsapp-chat-experience.md §4, §7.

import { remoteNumberFor } from "./evolutionMessage.ts";
import { EvolutionApiError } from "./evolutionApi.ts";
import { isUnusableProviderId } from "./whatsappMediaResolver.ts";
import {
  resolveWhatsAppTransport,
  supportsMessageRevoke,
  type WhatsAppTransport,
  type WhatsAppTransportAccount,
} from "./whatsappTransport.ts";
import type { WhatsAppAccountAccess } from "./whatsappWorkspaceAccess.ts";

export class WhatsAppRevokeError extends Error {
  constructor(
    message: string,
    public readonly error_type: "UNSUPPORTED_CAPABILITY" | "PROVIDER_REFUSED",
  ) {
    super(message);
    this.name = "WhatsAppRevokeError";
  }
}

export interface RevokeMessageRequest {
  messageRowId: string;
}

export interface RevokeMessageResult {
  success: true;
  revoked_at: string;
}

export interface RevokeMessageRow {
  id: string;
  social_account_id: string;
  conversation_id: string | null;
  message_id: string | null;
  direction: string | null;
  to_phone: string | null;
  from_phone: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
}

export interface RevokeWhatsAppMessageDeps {
  resolveTransport?: (
    // deno-lint-ignore no-explicit-any
    admin: any,
    account: WhatsAppTransportAccount,
  ) => Promise<WhatsAppTransport>;
  now?: () => Date;
}

const UNSUPPORTED = "UNSUPPORTED_CAPABILITY";

export function isSyntheticProviderId(messageId: string | null | undefined): boolean {
  return isUnusableProviderId(messageId);
}

export function remoteJidForRow(row: {
  to_phone?: string | null;
  conversation_id?: string | null;
}): string {
  const fromPhone = row.to_phone?.trim();
  if (fromPhone) return `${remoteNumberFor(fromPhone)}@s.whatsapp.net`;
  return `${remoteNumberFromConversationId(row.conversation_id)}@s.whatsapp.net`;
}

export function remoteNumberFromConversationId(conversationId: string | null | undefined): string {
  if (!conversationId) return "";
  const match = conversationId.match(/^wa_[^_]+_(.+)$/);
  return remoteNumberFor(match?.[1] ?? conversationId);
}

export function canRevokeRow(
  connectionMode: WhatsAppAccountAccess["connectionMode"],
  row: Pick<RevokeMessageRow, "direction" | "message_id">,
): { ok: true } | { ok: false; reason: string } {
  if (connectionMode !== "evolution_qr") {
    return { ok: false, reason: "Delete for everyone is only available on Direct QR accounts" };
  }
  if (row.direction !== "outbound") {
    return { ok: false, reason: "You can only delete your own messages for everyone" };
  }
  if (isSyntheticProviderId(row.message_id)) {
    return { ok: false, reason: "This message has no WhatsApp provider id" };
  }
  return { ok: true };
}

/**
 * Evolution v2.3.x `deleteMessage` (Baileys `sendMessage({ delete })`) does **not**
 * emit a distinct already-revoked error. When its local row is already gone it
 * still returns HTTP 201 with `message.protocolMessage.type === "REVOKE"`
 * (`if (!message) return response` in EvolutionAPI). A retry after a failed
 * local write therefore looks like a first-time success.
 *
 * Failures are wrapped as HTTP 500 `Error while deleting message for everyone`
 * plus the inner error (`SessionError: No sessions`, jid decode, timeout). Those
 * 500s are indistinguishable from each other and MUST NOT be treated as
 * already-revoked. The only error shape we accept as "already absent" is a 404
 * whose body names the message (not the instance).
 */
export function isAlreadyRevokedProviderResponse(error: unknown): boolean {
  if (!(error instanceof EvolutionApiError)) return false;
  if (error.status !== 404) return false;
  const blob = JSON.stringify(error.body ?? "");
  if (/instance .*not found/i.test(blob)) return false;
  return /message not found|message.*does not exist|already (deleted|revoked)/i.test(blob);
}

export function isRevokeSuccessBody(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const record = body as Record<string, unknown>;
  if (record.deleted === true) return true;
  const message = record.message as Record<string, unknown> | undefined;
  const protocol = message?.protocolMessage as Record<string, unknown> | undefined;
  return protocol?.type === "REVOKE";
}

export async function revokeWhatsAppMessage(
  // deno-lint-ignore no-explicit-any
  admin: any,
  access: WhatsAppAccountAccess,
  viewerUserId: string,
  request: RevokeMessageRequest,
  deps: RevokeWhatsAppMessageDeps = {},
): Promise<RevokeMessageResult> {
  const { data: row, error } = await admin
    .from("whatsapp_messages")
    .select("id, social_account_id, conversation_id, message_id, direction, to_phone, from_phone, revoked_at, revoked_by")
    .eq("id", request.messageRowId)
    .eq("social_account_id", access.accountId)
    .maybeSingle();
  if (error) throw error;
  if (!row) throw new Error("Message not found");

  const capability = canRevokeRow(access.connectionMode, row);
  if (!capability.ok) {
    throw new WhatsAppRevokeError(capability.reason, UNSUPPORTED);
  }

  if (row.revoked_at) {
    return { success: true, revoked_at: String(row.revoked_at) };
  }

  const resolveTransport = deps.resolveTransport ?? resolveWhatsAppTransport;
  const transport = await resolveTransport(admin, transportAccount(access));
  if (!supportsMessageRevoke(transport)) {
    throw new WhatsAppRevokeError(
      "Delete for everyone is only available on Direct QR accounts",
      UNSUPPORTED,
    );
  }

  const key = {
    id: String(row.message_id),
    remoteJid: remoteJidForRow(row),
    fromMe: true,
  };

  try {
    await transport.revokeMessage(key);
  } catch (providerError) {
    if (!isAlreadyRevokedProviderResponse(providerError)) {
      throw new WhatsAppRevokeError(
        "WhatsApp could not delete this message for everyone",
        "PROVIDER_REFUSED",
      );
    }
  }

  const revokedAt = (deps.now ?? (() => new Date()))().toISOString();
  const { error: stampError } = await admin
    .from("whatsapp_messages")
    .update({ revoked_at: revokedAt, revoked_by: viewerUserId })
    .eq("id", row.id)
    .eq("social_account_id", access.accountId);
  if (stampError) throw stampError;

  return { success: true, revoked_at: revokedAt };
}

function transportAccount(access: WhatsAppAccountAccess): WhatsAppTransportAccount {
  return {
    id: access.accountId,
    platform_user_id: access.platformUserId,
    access_token: access.accessToken,
    connection_mode: access.connectionMode,
    account_metadata: (access.accountMetadata ?? null) as Record<string, unknown> | null,
  };
}
