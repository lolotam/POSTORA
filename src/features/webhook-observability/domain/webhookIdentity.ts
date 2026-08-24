/**
 * The id Meta addresses an account by when it delivers a webhook.
 *
 * This is not the same thing as "the account's id", and conflating the two is what made
 * the 2026-08-24 incident hard to see: a user connected Instagram account
 * `28328915980060259` while Meta was delivering events for `17841401514313845`, and
 * nothing in the UI showed either number, so there was nothing to compare.
 *
 * Instagram Login issues up to three ids per account, and this resolves the same set of
 * columns as findAccountForRecipient in
 * supabase/functions/facebook-instagram-webhook/index.ts -- but deliberately NOT in the
 * same order, and the difference is the point.
 *
 * That function answers "which column did this incoming id match?", so it tries the
 * cheapest and most common column first. This answers "which id will Meta actually put in
 * entry.id?", which for a direct-login Instagram account is the IGID, never the
 * app-scoped `platform_user_id`. Showing the user `platform_user_id` for such an account
 * would print a real id that no webhook ever carries -- precisely the confusion this is
 * meant to end. The resolver still matches either, so the two staying out of step is
 * correct rather than a drift to be fixed.
 */

export interface WebhookIdentityAccount {
  platform: string;
  platform_user_id: string | null;
  account_metadata?: unknown;
}

/** Platforms whose inbound events arrive by webhook and are matched by recipient id. */
const MESSAGING_PLATFORMS = new Set(["facebook", "instagram", "whatsapp", "threads"]);

export function isMessagingPlatform(platform: string): boolean {
  return MESSAGING_PLATFORMS.has(platform?.toLowerCase?.() ?? "");
}

function metadataString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : null;
}

/**
 * Returns the identifier the webhook resolver would match this account on, or null when
 * the account carries none.
 *
 * Order matters and is deliberate: `ig_igid` first because direct-login Instagram
 * accounts are addressed by their IGID, then `platform_user_id` which covers Facebook
 * Pages and Graph-linked Instagram, then `ig_user_id` as the fallback for rows connected
 * before `ig_igid` was stored.
 */
export function resolveWebhookIdentity(account: WebhookIdentityAccount): string | null {
  if (account.platform === "instagram") {
    const igid = metadataString(account.account_metadata, "ig_igid");
    if (igid) return igid;
  }
  if (account.platform_user_id) return account.platform_user_id;
  if (account.platform === "instagram") {
    // Kept even though it is third in line: rows predating ig_igid still resolve only by
    // this, and dropping it would make them display "unknown" while the webhook matches
    // them perfectly well.
    return metadataString(account.account_metadata, "ig_user_id");
  }
  return null;
}
