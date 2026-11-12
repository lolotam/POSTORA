// How an account is reconnected. A WhatsApp account paired through the Evolution API reconnects
// by scanning a new QR code on the WhatsApp setup page; every other platform reconnects through
// the OAuth flow that useProfileOAuth drives.
//
// The OAuth flow has no WhatsApp branch (src/hooks/useProfileOAuth.tsx), so routing a WhatsApp
// account into it would strand the owner on a redirect that cannot happen.

export const WHATSAPP_QR_SETUP_PATH = "/messaging/whatsapp/setup";

export interface ReconnectableAccount {
  platform: string;
  connection_mode: string | null;
}

export type ReconnectTarget = { kind: "oauth" } | { kind: "link"; path: string };

export function reconnectTargetFor(account: ReconnectableAccount): ReconnectTarget {
  if (account.platform === "whatsapp" && account.connection_mode === "evolution_qr") {
    return { kind: "link", path: WHATSAPP_QR_SETUP_PATH };
  }
  return { kind: "oauth" };
}
