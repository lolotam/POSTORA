export type WhatsAppConnectionMode = "cloud_api" | "coexistence" | "evolution_qr" | null;

export type RevokeDisabledReason =
  | "unsupported_mode"
  | "inbound"
  | "synthetic_id";

export interface RevokeCapability {
  enabled: boolean;
  reason: RevokeDisabledReason | null;
}

export function isSyntheticProviderId(providerMessageId: string | null | undefined): boolean {
  if (typeof providerMessageId !== "string" || providerMessageId.length === 0) return true;
  return providerMessageId.startsWith("sched_");
}

export function revokeDisabledReason(
  connectionMode: WhatsAppConnectionMode,
  direction: string | null | undefined,
  providerMessageId: string | null | undefined,
): RevokeDisabledReason | null {
  if (connectionMode !== "evolution_qr") return "unsupported_mode";
  if (direction !== "outbound") return "inbound";
  if (isSyntheticProviderId(providerMessageId)) return "synthetic_id";
  return null;
}

export function revokeCapability(
  connectionMode: WhatsAppConnectionMode,
  direction: string | null | undefined,
  providerMessageId: string | null | undefined,
): RevokeCapability {
  const reason = revokeDisabledReason(connectionMode, direction, providerMessageId);
  return { enabled: reason === null, reason };
}

export function revokeDisabledLabel(reason: RevokeDisabledReason | null): string | null {
  if (reason === "unsupported_mode") {
    return "Delete for everyone is only available on Direct QR accounts";
  }
  if (reason === "inbound") {
    return "You can only delete your own messages for everyone";
  }
  if (reason === "synthetic_id") {
    return "This message has no WhatsApp provider id";
  }
  return null;
}

export type VoiceNoteDisabledReason = "unsupported_mode" | "unsupported_browser";

export interface VoiceNoteCapability {
  enabled: boolean;
  reason: VoiceNoteDisabledReason | null;
}

export function voiceNoteCapability(
  connectionMode: WhatsAppConnectionMode,
  canRecord: boolean,
): VoiceNoteCapability {
  if (connectionMode !== "evolution_qr") {
    return { enabled: false, reason: "unsupported_mode" };
  }
  if (!canRecord) return { enabled: false, reason: "unsupported_browser" };
  return { enabled: true, reason: null };
}

export function voiceNoteDisabledLabel(reason: VoiceNoteDisabledReason | null): string | null {
  if (reason === "unsupported_mode") {
    return "Voice notes are only available on Direct QR accounts";
  }
  if (reason === "unsupported_browser") {
    return "This browser cannot record a voice note";
  }
  return null;
}
