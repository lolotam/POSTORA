// How an account is reconnected. A WhatsApp account paired through the Evolution API reconnects
// by scanning a new QR code on the WhatsApp setup page; a Meta-hosted WhatsApp account whose
// credential expired is renewed through the Meta Embedded Signup flow; every other platform
// reconnects through the OAuth flow that useProfileOAuth drives.
//
// The OAuth flow has no WhatsApp branch (src/hooks/useProfileOAuth.tsx), so routing a WhatsApp
// account into it would strand the owner on a redirect that cannot happen.

import type { WhatsAppConnectionMode } from "@/lib/whatsappEmbeddedSignup";

export const WHATSAPP_QR_SETUP_PATH = "/messaging/whatsapp/setup";

export interface ReconnectableAccount {
  platform: string;
  connection_mode: string | null;
  /**
   * True when the row is flagged for re-authentication: the stored credential is
   * expired or revoked. A flagged account needs a NEW credential, which is a
   * different repair from re-subscribing the app to a WABA.
   */
  needs_reauth?: boolean;
}

export type ReconnectTarget =
  | { kind: "oauth" }
  | { kind: "link"; path: string }
  /** Re-subscribe the app to a WABA whose stored credential is still valid. */
  | { kind: "whatsapp_meta" }
  /** Renew the credential of a flagged Meta account through Embedded Signup. */
  | { kind: "whatsapp_meta_connect"; mode: WhatsAppConnectionMode };

/**
 * The mode Embedded Signup has to be launched with for an existing Meta account.
 * A row with no recorded mode is a Cloud API account: coexistence is an explicit
 * choice the owner made at onboarding, and a blank mode never means it.
 */
function metaConnectionMode(connectionMode: string | null): WhatsAppConnectionMode {
  return connectionMode === "coexistence" ? "coexistence" : "cloud_api";
}

export function reconnectTargetFor(account: ReconnectableAccount): ReconnectTarget {
  if (account.platform !== "whatsapp") return { kind: "oauth" };
  if (account.connection_mode === "evolution_qr") {
    return { kind: "link", path: WHATSAPP_QR_SETUP_PATH };
  }
  // A Meta-hosted WhatsApp account (cloud_api, coexistence) has two different repairs,
  // and picking the wrong one strands the owner:
  //
  //   * `reconnect` (whatsapp-oauth) re-subscribes the app to the WABA using the
  //     STORED access token. It neither refreshes that token nor clears
  //     needs_reauth, so on a flagged account it repairs nothing: the banner would
  //     keep asking the owner to reconnect, forever, with no path out. It serves the
  //     account that was disconnected in-product, whose credential is still good.
  //   * A flagged account (needs_reauth) carries an expired or revoked token, so the
  //     only repair is a full credential renewal: the Meta Embedded Signup flow the
  //     app already uses to connect a WhatsApp account in the first place.
  if (account.needs_reauth) {
    return { kind: "whatsapp_meta_connect", mode: metaConnectionMode(account.connection_mode) };
  }
  return { kind: "whatsapp_meta" };
}
