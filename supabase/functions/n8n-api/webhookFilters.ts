import { isValidUuid } from "./requestGuards.ts";

export const SUBSCRIPTION_PLATFORMS = ["facebook", "instagram", "threads", "whatsapp"] as const;

export interface SubscriptionFilters { platform?: string; social_account_id?: string }

export function parseSubscriptionFilters(body: any): { ok: true; filters: SubscriptionFilters } | { ok: false; error: string } {
  const filters: SubscriptionFilters = {};
  if (body?.platform !== undefined && body.platform !== "") {
    if (!(SUBSCRIPTION_PLATFORMS as readonly unknown[]).includes(body.platform)) {
      return { ok: false, error: `platform must be one of ${SUBSCRIPTION_PLATFORMS.join(", ")}` };
    }
    filters.platform = body.platform;
  }
  if (body?.social_account_id !== undefined && body.social_account_id !== "") {
    if (!isValidUuid(body.social_account_id)) {
      return { ok: false, error: "social_account_id must be a UUID" };
    }
    filters.social_account_id = body.social_account_id;
  }
  return { ok: true, filters };
}
