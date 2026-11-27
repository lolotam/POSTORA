import type { YouTubeResourceAccount } from "./handler.ts";

/**
 * Re-reads the account immediately before a provider write to confirm that
 * ownership, native provider status, reconnect state, bound channel, and
 * access token have not changed since admission.
 */
export async function verifyAccountStillBound(input: {
  loadAccount: (args: { accountId: string; userId: string }) => Promise<YouTubeResourceAccount | null>;
  accountId: string;
  ownerId: string;
  channelId: string;
  accessToken: string;
}): Promise<boolean> {
  try {
    const account = await input.loadAccount({
      accountId: input.accountId,
      userId: input.ownerId,
    });
    if (!account) return false;
    return (
      account.id === input.accountId &&
      account.userId === input.ownerId &&
      account.authProvider !== "composio" &&
      account.needsReauth === false &&
      account.channelId === input.channelId &&
      account.accessToken === input.accessToken
    );
  } catch {
    return false;
  }
}
