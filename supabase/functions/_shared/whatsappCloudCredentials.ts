/**
 * Resolves the Meta Cloud API credentials to use for a user's WhatsApp number.
 *
 * Two rules that callers kept getting wrong on their own:
 *
 * 1. Direct QR accounts are not Cloud API accounts. They run a self-hosted session, so their
 *    access_token is empty and platform_user_id holds a phone number rather than a Cloud API
 *    phone_number_id. Passing one to Meta produces a confusing token error.
 * 2. Credentials are a pair, not two independent fields. Falling back per field can combine the
 *    global env token with an account's phone number — a pairing that belongs to no real
 *    WhatsApp account and fails in a way that looks like an expired token.
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
  | { status: "ok"; credentials: CloudApiCredentials; source: "account" | "env" }
  /** The user has WhatsApp connected, but only through a mode Meta holds no Cloud API identity for. */
  | { status: "requires_cloud_api" }
  | { status: "none" };

export function isCloudApiAccount(account: WhatsAppAccountRow): boolean {
  return account.account_metadata?.connection_mode !== "evolution_qr" &&
    Boolean(account.access_token) &&
    Boolean(account.platform_user_id);
}

export function resolveWhatsAppCloudCredentials(
  accounts: WhatsAppAccountRow[],
  env: { accessToken?: string | null; phoneNumberId?: string | null },
): CredentialResolution {
  const account = accounts.find(isCloudApiAccount);
  if (account) {
    return {
      status: "ok",
      source: "account",
      credentials: {
        accessToken: account.access_token as string,
        phoneNumberId: account.platform_user_id as string,
      },
    };
  }

  if (env.accessToken && env.phoneNumberId) {
    return {
      status: "ok",
      source: "env",
      credentials: { accessToken: env.accessToken, phoneNumberId: env.phoneNumberId },
    };
  }

  return accounts.length > 0 ? { status: "requires_cloud_api" } : { status: "none" };
}
