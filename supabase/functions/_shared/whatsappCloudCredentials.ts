/**
 * Resolves the Meta Cloud API credentials to use for a user's WhatsApp number.
 *
 * Credentials come only from the user's own connected account. The former
 * WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID env fallback is deliberately gone: it was a
 * single-tenant leftover that let one user's request go out under another account's identity,
 * and because it was applied per field it could pair the global token with an account's phone
 * number — a combination belonging to no real WhatsApp account, which Meta rejected in a way
 * that looked like an expired token.
 *
 * Direct QR accounts are excluded because they are not Cloud API accounts at all: they run a
 * self-hosted session, so access_token is empty and platform_user_id holds a phone number rather
 * than a Cloud API phone_number_id.
 */

export interface WhatsAppAccountRow {
  access_token?: string | null;
  platform_user_id?: string | null;
  account_metadata?: Record<string, unknown> | null;
}

export interface CloudApiCredentials {
  accessToken: string;
  phoneNumberId: string;
}

export type CredentialResolution =
  | { status: "ok"; credentials: CloudApiCredentials }
  /**
   * WhatsApp is connected but no account can reach the Cloud API. The reason decides what the
   * user should actually do, and the two are not interchangeable: a QR session needs a different
   * number connected, whereas a Cloud API account missing half its credentials needs reconnecting.
   */
  | { status: "requires_cloud_api"; reason: "qr_only" | "incomplete_credentials" }
  | { status: "none" };

export function isCloudApiAccount(account: WhatsAppAccountRow): boolean {
  return account.account_metadata?.connection_mode !== "evolution_qr" &&
    Boolean(account.access_token) &&
    Boolean(account.platform_user_id);
}

export function resolveWhatsAppCloudCredentials(
  accounts: WhatsAppAccountRow[],
): CredentialResolution {
  const account = accounts.find(isCloudApiAccount);
  if (account) {
    return {
      status: "ok",
      credentials: {
        accessToken: account.access_token as string,
        phoneNumberId: account.platform_user_id as string,
      },
    };
  }

  if (accounts.length === 0) return { status: "none" };

  const everyAccountIsQr = accounts.every(
    (candidate) => candidate.account_metadata?.connection_mode === "evolution_qr",
  );
  return {
    status: "requires_cloud_api",
    reason: everyAccountIsQr ? "qr_only" : "incomplete_credentials",
  };
}
