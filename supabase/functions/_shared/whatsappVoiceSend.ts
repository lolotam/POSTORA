// Outbound voice notes: validate an owned storage path, mint the signed URL
// server-side, send via sendWhatsAppAudio with encoding: true, persist the row.
// Spec: docs/specs/2026-08-25-whatsapp-chat-experience.md §4, §5.2, §7.

import {
  OUTBOUND_SIGN_TTL_SECONDS,
  ownedStoragePath,
  signMediaPath,
} from "./whatsappMediaResolver.ts";
import {
  resolveWhatsAppTransport,
  supportsVoiceNote,
  type WhatsAppTransport,
  type WhatsAppTransportAccount,
} from "./whatsappTransport.ts";
import type { WhatsAppAccountAccess } from "./whatsappWorkspaceAccess.ts";

export class WhatsAppVoiceSendError extends Error {
  constructor(
    message: string,
    public readonly error_type: "UNSUPPORTED_CAPABILITY" | "VALIDATION_ERROR",
  ) {
    super(message);
    this.name = "WhatsAppVoiceSendError";
  }
}

export interface SendWhatsAppVoiceRequest {
  recipient_phone: string;
  media_path: string;
  duration_seconds: unknown;
  mime_type: unknown;
}

export interface SendWhatsAppVoiceResult {
  success: true;
  message_id: string | null;
}

export interface UpsertOutboundConversationParams {
  user_id: string;
  social_account_id: string;
  phone_number_id: string;
  recipient_phone: string;
  preview: string;
  workspace_id: string;
}

export interface SendWhatsAppVoiceDeps {
  resolveTransport?: (
    // deno-lint-ignore no-explicit-any
    admin: any,
    account: WhatsAppTransportAccount,
  ) => Promise<WhatsAppTransport>;
  signPath?: (
    // deno-lint-ignore no-explicit-any
    admin: any,
    path: string,
    ttlSeconds: number,
  ) => Promise<string | null>;
  upsertOutboundConversation: (
    // deno-lint-ignore no-explicit-any
    admin: any,
    params: UpsertOutboundConversationParams,
  ) => Promise<void>;
  now?: () => Date;
}

const MAX_DURATION_SECONDS = 300;
const VOICE_PREVIEW = "[Voice note]";

export async function sendWhatsAppVoice(
  // deno-lint-ignore no-explicit-any
  admin: any,
  access: WhatsAppAccountAccess,
  callerUserId: string,
  request: SendWhatsAppVoiceRequest,
  deps: SendWhatsAppVoiceDeps,
): Promise<SendWhatsAppVoiceResult> {
  const recipientPhone = typeof request.recipient_phone === "string" ? request.recipient_phone.trim() : "";
  if (!recipientPhone) {
    throw new WhatsAppVoiceSendError("recipient_phone is required", "VALIDATION_ERROR");
  }

  const mimeType = typeof request.mime_type === "string" ? request.mime_type.trim() : "";
  if (!mimeType) {
    throw new WhatsAppVoiceSendError("mime_type is required", "VALIDATION_ERROR");
  }

  const durationSeconds = Number(request.duration_seconds);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > MAX_DURATION_SECONDS) {
    throw new WhatsAppVoiceSendError("duration_seconds is invalid", "VALIDATION_ERROR");
  }

  let storagePath: string;
  try {
    storagePath = ownedStoragePath(String(request.media_path ?? ""), callerUserId);
  } catch {
    throw new WhatsAppVoiceSendError("media_path is invalid", "VALIDATION_ERROR");
  }

  const signPath = deps.signPath ?? signMediaPath;
  const signedUrl = await signPath(admin, storagePath, OUTBOUND_SIGN_TTL_SECONDS);
  if (!signedUrl) {
    throw new WhatsAppVoiceSendError("could not sign media_path", "VALIDATION_ERROR");
  }

  const resolveTransport = deps.resolveTransport ?? resolveWhatsAppTransport;
  const transport = await resolveTransport(admin, transportAccount(access));
  if (!supportsVoiceNote(transport)) {
    throw new WhatsAppVoiceSendError(
      "Voice notes are only available on Direct QR accounts",
      "UNSUPPORTED_CAPABILITY",
    );
  }

  const sent = await transport.sendVoiceNote({
    recipientPhone,
    audioUrl: signedUrl,
  });

  const phoneNumberId = access.platformUserId;
  const normalizedPhone = recipientPhone.replace(/^\+/, "");
  const conversationId = `wa_${phoneNumberId}_${normalizedPhone}`;
  const timestamp = (deps.now ?? (() => new Date()))().toISOString();

  const { error: insertError } = await admin.from("whatsapp_messages").insert({
    user_id: access.ownerId,
    social_account_id: access.accountId,
    conversation_id: conversationId,
    message_id: sent.messageId,
    from_phone: phoneNumberId,
    from_name: "You",
    to_phone: recipientPhone,
    message_text: VOICE_PREVIEW,
    message_type: "audio",
    media_url: storagePath,
    media_type: "audio",
    media_metadata: {
      mime_type: mimeType,
      duration_seconds: durationSeconds,
      ptt: true,
    },
    direction: "outbound",
    status: "sent",
    timestamp,
  });
  if (insertError) throw insertError;

  await deps.upsertOutboundConversation(admin, {
    user_id: access.ownerId,
    social_account_id: access.accountId,
    phone_number_id: phoneNumberId,
    recipient_phone: recipientPhone,
    preview: VOICE_PREVIEW,
    workspace_id: access.workspaceId,
  });

  return { success: true, message_id: sent.messageId };
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
