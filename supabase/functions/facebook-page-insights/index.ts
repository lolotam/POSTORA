import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.25.76";
import { authenticateCaller, serviceRoleCallerUserId } from "../_shared/auth-helper.ts";
import { handleRestrictedCorsOptions, restrictedJsonResponse } from "../_shared/cors.ts";
import { createLogger } from "../_shared/logging.ts";
import { FacebookInsightsProvider } from "./provider.ts";
import { facebookPageReport } from "./report.ts";

const requestSchema = z.object({
  accountId: z.string().uuid(), analyticsContractVersion: z.unknown(), user_id: z.unknown().optional(),
  periodDays: z.union([z.literal(7), z.literal(14), z.literal(30), z.literal(90)]).default(7),
  cursor: z.string().min(1).max(16384).nullable().optional(),
}).strict();
type OwnedPage = { id: string; platform_user_id: string; access_token: string | null };

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return handleRestrictedCorsOptions(req);
  const startedAt = Date.now();
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
  const logger = createLogger(supabase, "facebook-page-insights", "edge");
  let userId: string | undefined;
  const refuse = async (status: number, reason: string, message: string) => {
    await logger.warn("Facebook Page analytics refused", { event: reason, platform: "facebook" }, userId);
    return restrictedJsonResponse(req, { ok: false, reason, message }, status);
  };
  try {
    if (req.method !== "POST") return await refuse(405, "method_not_allowed", "Use POST for Facebook Page analytics.");
    try { userId = (await authenticateCaller(req, await serviceRoleCallerUserId(req))).userId; }
    catch { return await refuse(401, "unauthorized", "Unauthorized."); }
    const parsed = requestSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return await refuse(400, "invalid_request", "Invalid Facebook Page analytics request.");
    if (parsed.data.analyticsContractVersion !== 1) return await refuse(400, "unsupported_contract_version", "Unsupported analytics contract version.");
    const { data: account, error } = await supabase.from("social_accounts").select("id,platform_user_id,access_token")
      .eq("id", parsed.data.accountId).eq("user_id", userId).eq("platform", "facebook").eq("is_active", true).maybeSingle<OwnedPage>();
    if (error) return await refuse(503, "storage_error", "Unable to load the selected Facebook Page. Please retry.");
    if (!account) return await refuse(404, "account_not_found", "Facebook Page not found.");
    if (!account.access_token || !/^\d{1,40}$/.test(account.platform_user_id)) {
      return await refuse(409, "reauth_required", "Reconnect the selected Facebook Page.");
    }
    const result = await facebookPageReport({ provider: new FacebookInsightsProvider({ token: account.access_token, signal: req.signal, startedAt }),
      ownerId: userId, accountId: account.id, pageId: account.platform_user_id, days: parsed.data.periodDays,
      cursor: parsed.data.cursor ?? null, signingSecret: serviceKey, now: new Date(startedAt).toISOString() });
    if (!result.ok) {
      await logger.warn("Facebook Page report refused", { event: "report_refused", reason: result.reason }, userId);
      const { status, ...body } = result;
      return restrictedJsonResponse(req, body, status);
    }
    await logger.info("Facebook Page analytics read", { event: "report_read", platform: "facebook",
      refusal_reasons: result.refusalReasons, truncated: result.report.truncated }, userId);
    return restrictedJsonResponse(req, { ok: true, ...result.report });
  } catch {
    await logger.error("Facebook Page analytics failed", { event: "unexpected_failure", platform: "facebook" }, userId);
    return restrictedJsonResponse(req, { ok: false, reason: "provider_error", message: "Facebook Page analytics could not be completed." }, 500);
  }
}

if (import.meta.main) Deno.serve(handler);
