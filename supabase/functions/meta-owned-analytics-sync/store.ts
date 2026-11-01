import { z } from "https://esm.sh/zod@3.25.76";
import { AnalyticsWorkerDeadline, AnalyticsWorkerStopped } from "./deadline.ts";

export type OwnedAnalyticsPlatform = "facebook" | "threads";
const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const expiry = z.string().datetime({ offset: true }).nullable();
const facebookAuthority = z.object({ platform_user_id: identifier, connection_version: z.number().int().positive().safe(),
  credential_id: z.string().uuid(), credential_revision: z.number().int().positive().safe(),
  provider_user_id: identifier, token_expires_at: expiry }).strict();
const threadsAuthority = z.object({ platform_user_id: identifier, credential_generation: z.number().int().positive().safe(), token_expires_at: expiry }).strict();
const credentialBase = z.object({ account_id: z.string().uuid(), user_id: z.string().uuid(),
  access_token: z.string().min(1).max(16384), permission_token: z.string().min(1).max(16384) });
const facebookCredential = credentialBase.extend({ authority: facebookAuthority }).strict();
const threadsCredential = credentialBase.extend({ authority: threadsAuthority }).strict();
export type AdmissionCredential = z.infer<typeof facebookCredential> | z.infer<typeof threadsCredential>;
export type AnalyticsRpc = (name: string, args: Record<string, unknown>, signal: AbortSignal) => PromiseLike<unknown>;

export class OwnedAnalyticsAdmissionStore {
  constructor(private readonly rpc: AnalyticsRpc, private readonly deadline: AnalyticsWorkerDeadline) {}

  private async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    let envelope: unknown;
    try { envelope = await this.deadline.run((signal) => this.rpc(name, args, signal)); }
    catch (error) {
      if (error instanceof AnalyticsWorkerStopped) throw error;
      throw new AnalyticsWorkerStopped("storage_unavailable");
    }
    const decoded = z.object({ data: z.unknown(), error: z.unknown() }).passthrough().safeParse(envelope);
    if (!decoded.success || !Object.hasOwn(decoded.data, "data") || !Object.hasOwn(decoded.data, "error")) {
      throw new AnalyticsWorkerStopped("invalid_contract");
    }
    if (decoded.data.error !== null) {
      const refusal = z.object({ code: z.string() }).passthrough().safeParse(decoded.data.error);
      const definitive = refusal.success && ["MAH01", "MAH02", "MAH03", "MAH04", "MAH05", "42501"].includes(refusal.data.code);
      throw new AnalyticsWorkerStopped(definitive ? "admission_refused" : "storage_unavailable");
    }
    return decoded.data.data;
  }

  async read(platform: OwnedAnalyticsPlatform, accountId: string, expected: AdmissionCredential["authority"] | null): Promise<AdmissionCredential> {
    const name = platform === "facebook" ? "read_fb_analytics_admission_credential" : "read_threads_analytics_admission_credential";
    const raw = await this.call(name, { p_account_id: accountId, p_expected_authority: expected });
    const decoded = (platform === "facebook" ? facebookCredential : threadsCredential).safeParse(raw);
    if (!decoded.success || decoded.data.account_id !== accountId.toLowerCase()) throw new AnalyticsWorkerStopped("invalid_contract");
    return decoded.data;
  }

  async observe(platform: OwnedAnalyticsPlatform, credential: AdmissionCredential, scopes: string[], observedAt: string): Promise<void> {
    const name = platform === "facebook" ? "observe_fb_analytics_permissions" : "observe_threads_analytics_permissions";
    const raw = await this.call(name, { p_user_id: credential.user_id, p_account_id: credential.account_id,
      p_expected_authority: credential.authority, p_granted_scopes: scopes,
      p_verified_provider_id: credential.authority.platform_user_id, p_observed_at: observedAt, p_state: "verified" });
    const decoded = z.object({ account_id: z.string().uuid(), authority: platform === "facebook" ? facebookAuthority : threadsAuthority,
      state: z.literal("verified") }).strict().safeParse(raw);
    if (!decoded.success || decoded.data.account_id !== credential.account_id) throw new AnalyticsWorkerStopped("invalid_contract");
  }
}
