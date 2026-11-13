// How an account is reconnected. A WhatsApp account paired through the Evolution API reconnects
// by scanning a new QR code on the WhatsApp setup page; a Meta-hosted WhatsApp account restores
// its webhook subscription through the WhatsApp reconnect flow; every other platform reconnects
// through the OAuth flow that useProfileOAuth drives.
//
// The OAuth flow has no WhatsApp branch (src/hooks/useProfileOAuth.tsx), so routing a WhatsApp
// account into it would strand the owner on a redirect that cannot happen.

export const WHATSAPP_QR_SETUP_PATH = "/messaging/whatsapp/setup";

export interface ReconnectableAccount {
  platform: string;
  connection_mode: string | null;
}

export type ReconnectTarget =
  | { kind: "oauth" }
  | { kind: "link"; path: string }
  | { kind: "whatsapp_meta" };

export function reconnectTargetFor(account: ReconnectableAccount): ReconnectTarget {
  if (account.platform !== "whatsapp") return { kind: "oauth" };
  if (account.connection_mode === "evolution_qr") {
    return { kind: "link", path: WHATSAPP_QR_SETUP_PATH };
  }
  // A Meta-hosted WhatsApp account (cloud_api, coexistence) reconnects by re-subscribing the
  // app to the WABA, which is what useWhatsAppReconnect drives. It must not fall through to
  // the OAuth branch: there is no WhatsApp case in invokePlatform, so the button would spin
  // forever and reconnect nothing.
  return { kind: "whatsapp_meta" };
}
