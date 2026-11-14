import { z } from "https://esm.sh/zod@3.25.76";
import { protectedFetchJson } from "../_shared/metaOAuthProtectedBoundary.ts";
import { metaNextCursor } from "../_shared/metaPagination.ts";

export const captureSchema = z.object({
  token: z.string().min(1).max(4096), login_kind: z.enum(["page_linked", "direct"]),
  platform: z.enum(["facebook", "instagram"]), platform_user_id: z.string().regex(/^\d{1,128}$/),
  page_id: z.string().regex(/^\d{1,128}$/).nullable(), provider_user_id: z.string().nullable(),
});
export type CandidateCapture = z.infer<typeof captureSchema>;
export type BootstrapReason = "token_invalid" | "permission_missing" | "app_mismatch" | "identity_mismatch"
  | "provider_error" | "provider_malformed" | "rate_limited" | "budget_exhausted" | "direct_verification_unsupported";
export class BootstrapFailure extends Error {
  constructor(readonly reason: BootstrapReason) { super(reason); }
}
type VerificationInput = {
  capture: CandidateCapture; app: { id: string; secret: string }; deadline: number;
  beforeRequest: () => Promise<void>; fetcher?: typeof fetch;
};
const identifier = z.string().regex(/^\d{1,128}$/);
const debuggerSchema = z.object({ data: z.object({ is_valid: z.boolean(), type: z.string(),
  app_id: identifier, user_id: identifier, expires_at: z.number().int().nonnegative(),
  data_access_expires_at: z.number().int().nonnegative() }) });
export type VerificationEvidence = {
  app_id: string; provider_user_id: string; page_id: string | null; instagram_user_id: string | null;
  token_type: "USER"; verified_at: string; expires_at: string | null;
};
function classify(status: number, body: unknown): BootstrapReason | null {
  const record = z.object({ error: z.object({ code: z.number().optional(), is_transient: z.boolean().optional(), message: z.string().optional() }) }).safeParse(body);
  const error = record.success ? record.data.error : null;
  if (status === 429 || [4, 17, 32, 613].includes(error?.code ?? -1)) return "rate_limited";
  if (error?.code === 190) return "token_invalid";
  if (error?.code === 100 && !error.is_transient && /did not match the viewing app/i.test(error.message ?? "")) return "app_mismatch";
  if ([10, 200].includes(error?.code ?? -1) && !error?.is_transient) return "permission_missing";
  if (error || status < 200 || status >= 300) return "provider_error";
  return null;
}

/** Fixed origin, no redirects/retries, bounded bodies and one invocation deadline. */
function verificationClient(input: VerificationInput) {
  let calls = 0;
  const origin = input.capture.login_kind === "direct" ? "https://graph.instagram.com" : "https://graph.facebook.com";
  const version = input.capture.platform === "facebook" ? "v25.0" : "v22.0";
  return async (path: string, params: Record<string, string> = {}, bearer = input.capture.token): Promise<unknown> => {
    if (++calls > 8 || Date.now() >= input.deadline) throw new BootstrapFailure("budget_exhausted");
    await input.beforeRequest();
    const url = new URL(`${origin}/${version}/${path}`);
    for (const [key, parameter] of Object.entries(params)) url.searchParams.set(key, parameter);
    try {
      let observedVersion: string | null = null;
      const fetcher: typeof fetch = async (request, init) => {
        const response = await (input.fetcher ?? fetch)(request, init);
        observedVersion = response.headers.get("facebook-api-version");
        return response;
      };
      const response = await protectedFetchJson(url.toString(), {
        method: "GET", redirect: "error", headers: { Authorization: `Bearer ${bearer}` },
      }, { timeoutMs: Math.min(8_000, input.deadline - Date.now()), maxBodyBytes: 65_536, fetcher });
      const reason = classify(response.status, response.body);
      if (reason) throw new BootstrapFailure(reason);
      if (input.capture.platform === "facebook" && observedVersion !== "v25.0") throw new BootstrapFailure("provider_malformed");
      return response.body;
    } catch (error) {
      if (error instanceof BootstrapFailure) throw error;
      throw new BootstrapFailure("provider_error");
    }
  };
}

async function verifyPage(input: VerificationInput, request: ReturnType<typeof verificationClient>): Promise<void> {
  const seen = new Set<string>();
  const pages = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < 4; page++) {
    const payload = await request("me/accounts", { fields: "id", limit: "100", ...(after ? { after } : {}) });
    const parsed = z.object({ data: z.array(z.object({ id: identifier })).max(100) }).passthrough().safeParse(payload);
    if (!parsed.success) throw new BootstrapFailure("provider_malformed");
    for (const account of parsed.data.data) {
      if (pages.has(account.id)) throw new BootstrapFailure("provider_malformed");
      pages.add(account.id);
    }
    try { after = metaNextCursor(parsed.data, "https://graph.facebook.com", `/${input.capture.platform === "facebook" ? "v25.0" : "v22.0"}/me/accounts`, seen); }
    catch { throw new BootstrapFailure("provider_malformed"); }
    if (!after) break;
    if (page === 3) throw new BootstrapFailure("provider_malformed");
  }
  const pageId = input.capture.page_id;
  if (!pageId || !pages.has(pageId)) throw new BootstrapFailure("identity_mismatch");
  const linked = z.object({ id: identifier, instagram_business_account: z.object({ id: identifier }).optional() })
    .safeParse(await request(pageId, { fields: "id,instagram_business_account{id}" }));
  if (!linked.success) throw new BootstrapFailure("provider_malformed");
  if (linked.data.id !== pageId || input.capture.platform === "instagram"
    && linked.data.instagram_business_account?.id !== input.capture.platform_user_id) throw new BootstrapFailure("identity_mismatch");
}

export async function verifyLegacyAuthority(input: VerificationInput): Promise<VerificationEvidence> {
  if (!/^\d{1,128}$/.test(input.app.id) || !input.app.secret) throw new BootstrapFailure("provider_error");
  const request = verificationClient(input);
  if (input.capture.login_kind === "direct") {
    // Meta documents app-authenticated debug_token for graph.facebook.com only.
    // A legacy direct token has no durable exchange/app receipt. Identity alone
    // cannot replace that proof: require the supported captured direct reconnect.
    const identity = z.object({ id: identifier, user_id: identifier.optional() })
      .safeParse(await request("me", { fields: "id,user_id" }));
    if (!identity.success) throw new BootstrapFailure("direct_verification_unsupported");
    if ((identity.data.user_id ?? identity.data.id) !== input.capture.platform_user_id) throw new BootstrapFailure("identity_mismatch");
    throw new BootstrapFailure("direct_verification_unsupported");
  }
  const inspected = await request("debug_token", { input_token: input.capture.token }, `${input.app.id}|${input.app.secret}`);
  if (z.object({ data: z.object({ is_valid: z.literal(false) }) }).safeParse(inspected).success) throw new BootstrapFailure("token_invalid");
  const debug = debuggerSchema.safeParse(inspected);
  if (!debug.success) throw new BootstrapFailure("provider_malformed");
  const grant = debug.data.data;
  if (grant.type !== "USER" || !grant.is_valid || [grant.expires_at, grant.data_access_expires_at].some((expiry) => expiry !== 0 && expiry * 1000 <= Date.now())) {
    throw new BootstrapFailure("token_invalid");
  }
  if (grant.app_id !== input.app.id) throw new BootstrapFailure("app_mismatch");
  if (input.capture.provider_user_id !== null && grant.user_id !== input.capture.provider_user_id) throw new BootstrapFailure("identity_mismatch");
  const identity = z.object({ id: identifier }).safeParse(await request("me", { fields: "id" }));
  if (!identity.success) throw new BootstrapFailure("provider_malformed");
  if (identity.data.id !== grant.user_id) throw new BootstrapFailure("identity_mismatch");
  await verifyPage(input, request);
  const expiries = [grant.expires_at, grant.data_access_expires_at].filter((expiry) => expiry > 0);
  return { app_id: grant.app_id, token_type: "USER", provider_user_id: grant.user_id, page_id: input.capture.page_id,
    instagram_user_id: input.capture.platform === "instagram" ? input.capture.platform_user_id : null,
    verified_at: new Date().toISOString(), expires_at: expiries.length === 0 ? null : new Date(Math.min(...expiries) * 1000).toISOString() };
}
