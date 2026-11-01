import { z } from "https://esm.sh/zod@3.25.76";
import { MetaAnalyticsTransport, metaAnalyticsFailure } from "../_shared/metaAnalyticsTransport.ts";
import { parseMetaError } from "../_shared/metaErrors.ts";
import type { AdmissionCredential, OwnedAnalyticsPlatform } from "./store.ts";

type PermissionFailure = "provider_error" | "reauth_required" | "rate_limited";
export type PermissionVerification = { ok: true; scopes: string[]; observedAt: string }
  | { ok: false; reason: PermissionFailure | "identity_mismatch" | "app_mismatch" };
export type AdmissionApp = { id: string; secret: string };
export const OWNED_ANALYTICS_REQUIRED_SCOPES: Record<OwnedAnalyticsPlatform, readonly string[]> = {
  facebook: ["read_insights", "pages_read_engagement"], threads: ["threads_basic", "threads_manage_insights"],
};
const scopesSchema = z.array(z.string().regex(/^[a-z][a-z0-9_]{0,99}$/)).max(512);
const debugSchema = z.object({ data: z.object({ is_valid: z.boolean(), user_id: z.string().optional(), app_id: z.string().optional(),
  scopes: scopesSchema.optional(), expires_at: z.number().int().nonnegative().optional(),
  data_access_expires_at: z.number().int().nonnegative().optional() }) });
const identitySchema = z.object({ id: z.string().min(1).max(200) });

/** Debugger and operational identity requests share one authority permit, never one token role. */
export async function verifyAdmissionPermission(input: {
  platform: OwnedAnalyticsPlatform; credential: AdmissionCredential; app: AdmissionApp; signal: AbortSignal;
  startedAt: number; beforeRequest: () => Promise<void>; fetch?: typeof fetch;
}): Promise<PermissionVerification> {
  const { platform, credential, app } = input;
  const options = { origin: platform === "facebook" ? "https://graph.facebook.com" as const : "https://graph.threads.net" as const,
    version: platform === "facebook" ? "v25.0" : "v1.0", signal: input.signal, startedAt: input.startedAt,
    budgetMs: 30_000, maxCalls: 1, fetch: input.fetch, beforeRequest: input.beforeRequest,
    fallbackReason: "provider_error" as const, rateLimitedReason: "rate_limited" as const,
    failureMessage: "Owned analytics permission verification failed.",
    classifyFailure: (status: number, payload: unknown, headers: Headers) => {
      const hasError = typeof payload === "object" && payload !== null && Object.hasOwn(payload, "error");
      if (status >= 200 && status < 300 && !hasError) {
        return platform === "facebook" && headers.get("facebook-api-version") !== "v25.0"
          ? metaAnalyticsFailure(status, "invalid_response", "provider_error" as PermissionFailure, "Permission response version mismatch.") : null;
      }
      const error = parseMetaError(status, payload);
      const reason: PermissionFailure = status === 429 || [4,17,32,613].includes(error.code ?? -1) ? "rate_limited"
        : error.code === 190 ? "reauth_required" : "provider_error";
      return metaAnalyticsFailure(status, "provider", reason,
        "Owned analytics permission verification failed.");
    } };
  const appBearer = `${platform === "threads" ? "TH|" : ""}${app.id}|${app.secret}`;
  const debuggerClient = new MetaAnalyticsTransport<PermissionFailure>({ ...options, token: appBearer });
  const debug = await debuggerClient.request(["debug_token"], { input_token: credential.permission_token }, debugSchema);
  if (debug.error) return { ok: false, reason: debug.error.reason };
  const grant = debug.data.data;
  if (!grant.is_valid || [grant.expires_at, grant.data_access_expires_at].some((until) => until !== undefined && until !== 0 && until * 1000 <= Date.now())) {
    return { ok: false, reason: "reauth_required" };
  }
  const expectedUser = "provider_user_id" in credential.authority ? credential.authority.provider_user_id : credential.authority.platform_user_id;
  if (grant.user_id !== expectedUser) return { ok: false, reason: "identity_mismatch" };
  if (grant.app_id !== undefined && grant.app_id !== app.id) return { ok: false, reason: "app_mismatch" };
  if (!grant.scopes || new Set(grant.scopes).size !== grant.scopes.length) return { ok: false, reason: "provider_error" };
  const operational = new MetaAnalyticsTransport<PermissionFailure>({ ...options, token: credential.access_token });
  const identity = await operational.request(["me"], { fields: "id" }, identitySchema);
  if (identity.error) return { ok: false, reason: identity.error.reason };
  if (identity.data.id !== credential.authority.platform_user_id) return { ok: false, reason: "identity_mismatch" };
  // Other product permissions must not invalidate this feature's bounded
  // authority merely because a legitimate grant contains more scopes.
  const observedScopes = OWNED_ANALYTICS_REQUIRED_SCOPES[platform].filter((scope) => grant.scopes!.includes(scope));
  return { ok: true, scopes: observedScopes.sort(), observedAt: new Date().toISOString() };
}
