export const SUBSCRIPTION_PLATFORMS = ["facebook", "instagram", "threads", "whatsapp"] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    if (typeof body.social_account_id !== "string" || !UUID_RE.test(body.social_account_id)) {
      return { ok: false, error: "social_account_id must be a UUID" };
    }
    filters.social_account_id = body.social_account_id;
  }
  return { ok: true, filters };
}
