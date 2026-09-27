import { createEvolutionApi, type EvolutionApi, type EvolutionSendResult } from "./evolutionApi.ts";

const GRAPH_API = "https://graph.facebook.com/v22.0";

/** A Graph API send that got a response. `status` tells a 5xx (outcome unknown) from a refusal. */
export class WhatsAppCloudApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: unknown) {
    super(message);
    this.name = "WhatsAppCloudApiError";
  }
}

export interface WhatsAppTransportAccount {
  id: string;
  platform_user_id: string;
  access_token: string | null;
  connection_mode: "cloud_api" | "coexistence" | "evolution_qr" | null;
  account_metadata?: Record<string, unknown> | null;
}

export interface WhatsAppSendTextInput {
  recipientPhone: string;
  text: string;
}

export interface WhatsAppSendMediaInput {
  recipientPhone: string;
  mediaUrl: string;
  mediaType: "image" | "video" | "document" | "audio";
  caption?: string;
  fileName?: string;
}

export interface WhatsAppSendVoiceInput {
  recipientPhone: string;
  /** Raw bytes: Evolution's audio route reads only an uploaded file, never a url or base64. */
  audio: Uint8Array;
  fileName?: string;
  mimeType?: string;
}

export interface WhatsAppTransport {
  sendText(input: WhatsAppSendTextInput): Promise<EvolutionSendResult>;
  sendMedia(input: WhatsAppSendMediaInput): Promise<EvolutionSendResult>;
  markRead(messageId: string): Promise<void>;
}

export interface SupportsMessageRevoke {
  revokeMessage(key: { id: string; remoteJid: string; fromMe: boolean }): Promise<void>;
}

export function supportsMessageRevoke(
  transport: WhatsAppTransport,
): transport is WhatsAppTransport & SupportsMessageRevoke {
  return typeof (transport as WhatsAppTransport & Partial<SupportsMessageRevoke>).revokeMessage === "function";
}

export interface SupportsVoiceNote {
  sendVoiceNote(input: WhatsAppSendVoiceInput): Promise<EvolutionSendResult>;
}

export function supportsVoiceNote(
  transport: WhatsAppTransport,
): transport is WhatsAppTransport & SupportsVoiceNote {
  return typeof (transport as WhatsAppTransport & Partial<SupportsVoiceNote>).sendVoiceNote === "function";
}

function accountToken(account: WhatsAppTransportAccount): string {
  const token = account.access_token || Deno.env.get("WHATSAPP_ACCESS_TOKEN");
  if (!token) throw new Error("No WhatsApp access token available for this account");
  return token;
}

async function graphSend(account: WhatsAppTransportAccount, payload: Record<string, unknown>): Promise<EvolutionSendResult> {
  const response = await fetch(`${GRAPH_API}/${account.platform_user_id}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accountToken(account)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const raw = await response.json().catch(() => ({}));
  if (!response.ok || raw?.error) {
    throw new WhatsAppCloudApiError(raw?.error?.message || "WhatsApp send failed", response.status, raw?.error?.code);
  }
  return { messageId: raw?.messages?.[0]?.id || null, raw };
}

export class CloudApiTransport implements WhatsAppTransport {
  constructor(private readonly account: WhatsAppTransportAccount) {}

  sendText(input: WhatsAppSendTextInput): Promise<EvolutionSendResult> {
    return graphSend(this.account, {
      messaging_product: "whatsapp",
      to: input.recipientPhone,
      type: "text",
      text: { body: input.text },
    });
  }

  sendMedia(input: WhatsAppSendMediaInput): Promise<EvolutionSendResult> {
    const media: Record<string, unknown> = { link: input.mediaUrl };
    if (input.caption) media.caption = input.caption;
    if (input.fileName) media.filename = input.fileName;
    return graphSend(this.account, {
      messaging_product: "whatsapp",
      to: input.recipientPhone,
      type: input.mediaType,
      [input.mediaType]: media,
    });
  }

  async markRead(_messageId: string): Promise<void> {}

}

export class EvolutionTransport implements WhatsAppTransport, SupportsMessageRevoke, SupportsVoiceNote {
  constructor(private readonly api: EvolutionApi, private readonly instanceName: string) {}

  sendText(input: WhatsAppSendTextInput): Promise<EvolutionSendResult> {
    return this.api.sendText(this.instanceName, { number: input.recipientPhone, text: input.text });
  }

  sendMedia(input: WhatsAppSendMediaInput): Promise<EvolutionSendResult> {
    return this.api.sendMedia(this.instanceName, {
      number: input.recipientPhone,
      mediaType: input.mediaType,
      media: input.mediaUrl,
      caption: input.caption,
      fileName: input.fileName,
    });
  }

  sendVoiceNote(input: WhatsAppSendVoiceInput): Promise<EvolutionSendResult> {
    return this.api.sendWhatsAppAudio(this.instanceName, {
      number: input.recipientPhone,
      audio: input.audio,
      fileName: input.fileName,
      mimeType: input.mimeType,
    });
  }

  async revokeMessage(key: { id: string; remoteJid: string; fromMe: boolean }): Promise<void> {
    await this.api.deleteMessageForEveryone(this.instanceName, key);
  }

  async markRead(_messageId: string): Promise<void> {}

}

export function createEvolutionTransport(api: EvolutionApi, instanceName: string): EvolutionTransport {
  return new EvolutionTransport(api, instanceName);
}

export async function resolveWhatsAppTransport(admin: any, account: WhatsAppTransportAccount): Promise<WhatsAppTransport> {
  if (account.connection_mode !== "evolution_qr") return new CloudApiTransport(account);
  const { data, error } = await admin
    .from("whatsapp_evolution_instances")
    .select("instance_name")
    .eq("social_account_id", account.id)
    .maybeSingle();
  if (error) throw error;
  if (!data?.instance_name) throw new Error("Direct QR instance is not configured");
  return createEvolutionTransport(createEvolutionApi(), data.instance_name);
}
