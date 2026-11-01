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
const dispatchTicket = z.object({ platform: z.enum(["facebook", "threads"]), due_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  policy_digest: z.string().regex(/^[a-f0-9]{64}$/), round: z.number().int().positive().safe(),
  after_account_id: z.string().uuid().nullable(), account_id: z.string().uuid() }).strict();
const dispatchNext = z.discriminatedUnion("state", [z.object({ state: z.literal("disabled") }).strict(),
  z.object({ state: z.literal("not_started") }).strict(),
  z.object({ state: z.literal("complete"), refused_count: z.number().int().min(0).max(100), round: z.number().int().positive().safe(),
    served_at: z.string().datetime({ offset: true }) }).strict(),
  z.object({ state: z.literal("target"), served_at: z.string().datetime({ offset: true }), ticket: dispatchTicket }).strict()]);
const dispatchCommit = z.discriminatedUnion("state", [z.object({ state: z.literal("needs_admission") }).strict(),
  z.object({ state: z.literal("advanced"), outcome: z.enum(["queued", "refused"]), complete: z.boolean(),
    refused_count: z.number().int().min(0).max(100) }).strict()]);
export type AnalyticsDispatchTicket = z.infer<typeof dispatchTicket>;
export type AnalyticsDispatchNext = z.infer<typeof dispatchNext>;

const claim = z.object({ job_id: z.string().uuid(), user_id: z.string().uuid(), account_id: z.string().uuid(),
  job_generation: z.number().int().positive().safe(), claim_token: z.string().uuid(), lease_until: z.string().datetime({ offset: true }),
  authority: z.union([facebookAuthority, threadsAuthority]), due_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  due_at: z.string().datetime({ offset: true }), next_due_at: z.string().datetime({ offset: true }) }).strict();
const workerState = z.object({ checkpoint: z.object({ cursor: z.string().max(4096).nullable(), post_ids: z.array(identifier).max(500),
  pages_fetched: z.number().int().min(0), inventory_complete: z.boolean(), inventory_truncated: z.boolean() }).strict(),
  operations: z.array(z.object({ operation_key: z.string().max(200), kind: z.enum(["account_day", "post", "profile", "period_total"]),
    state: z.enum(["pending", "success", "unavailable", "failed"]), reason: z.string().nullable(),
    last_requested_at: z.string().datetime({ offset: true }).nullable() }).strict()).max(520) }).strict();
export type AnalyticsClaim = z.infer<typeof claim> & { platform: OwnedAnalyticsPlatform };
export type AnalyticsWorkerState = z.infer<typeof workerState>;
export type CaptureRequest = { kind: "account_day" | "post" | "profile"; subject_id: string; metrics: string[]; metric_date?: string };
const capture = z.object({ capture_id: z.string().uuid(), capture_sequence: z.number().int().positive().safe(), job_id: z.string().uuid(),
  job_generation: z.number().int().positive().safe(), kind: z.string(), subject_id: identifier, metric_date: z.string().nullable(),
  since: z.string().datetime({ offset: true }).nullable(), until: z.string().datetime({ offset: true }).nullable(), timezone: z.string().nullable() }).strict();
export type AnalyticsCapture = z.infer<typeof capture>;

function jobArgs(job: AnalyticsClaim): Record<string, unknown> {
  return { p_job_id: job.job_id, p_claim_token: job.claim_token, p_job_generation: job.job_generation };
}
function family(platform: OwnedAnalyticsPlatform): "fb" | "threads" { return platform === "facebook" ? "fb" : "threads"; }

export class OwnedAnalyticsStore {
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
      if (refusal.success && refusal.data.code === "MAH05") throw new AnalyticsWorkerStopped("configuration_unavailable", "MAH05");
      const definitive = refusal.success && ["MAH01", "MAH02", "MAH03", "MAH04", "MAH05", "42501"].includes(refusal.data.code);
      throw new AnalyticsWorkerStopped(definitive ? "admission_refused" : "storage_unavailable", definitive && refusal.success ? refusal.data.code : null);
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

  async nextDispatch(platform: OwnedAnalyticsPlatform, start: boolean): Promise<AnalyticsDispatchNext> {
    const raw = await this.call("next_meta_analytics_dispatch_target", { p_platform: platform, p_start: start });
    const decoded = dispatchNext.safeParse(raw);
    if (!decoded.success || decoded.data.state === "target" && decoded.data.ticket.platform !== platform) throw new AnalyticsWorkerStopped("invalid_contract");
    return decoded.data;
  }

  async commitDispatch(ticket: AnalyticsDispatchTicket, outcome: "enqueue" | "refused", reason: string | null = null): Promise<z.infer<typeof dispatchCommit>> {
    const raw = await this.call("commit_meta_analytics_dispatch_target", { p_ticket: ticket, p_outcome: outcome, p_reason: reason });
    const decoded = dispatchCommit.safeParse(raw);
    if (!decoded.success) throw new AnalyticsWorkerStopped("invalid_contract");
    return decoded.data;
  }

  private decode<T>(schema: z.ZodType<T>, raw: unknown): T {
    const decoded = schema.safeParse(raw);
    if (!decoded.success) throw new AnalyticsWorkerStopped("invalid_contract");
    return decoded.data;
  }

  async claim(platform: OwnedAnalyticsPlatform | "all"): Promise<AnalyticsClaim | null> {
    const job = this.decode(claim.extend({ platform: z.enum(["facebook", "threads"]) }).nullable(),
      await this.call("claim_meta_analytics_collection_job", { p_platform: platform }));
    if (!job) return null;
    if (platform !== "all" && job.platform !== platform
      || !(job.platform === "facebook" ? facebookAuthority : threadsAuthority).safeParse(job.authority).success) throw new AnalyticsWorkerStopped("invalid_contract");
    return job;
  }

  async workerState(job: AnalyticsClaim): Promise<AnalyticsWorkerState> {
    return this.decode(workerState, await this.call(`read_${family(job.platform)}_analytics_worker_state`, jobArgs(job)));
  }

  async collectionCredential(job: AnalyticsClaim): Promise<string> {
    const schema = z.object({ job_id: z.literal(job.job_id), job_generation: z.literal(job.job_generation),
      authority: job.platform === "facebook" ? facebookAuthority : threadsAuthority, access_token: z.string().min(1).max(16384) }).strict();
    const credential = this.decode(schema, await this.call(`read_${family(job.platform)}_analytics_collection_credential`, jobArgs(job)));
    const authority = job.platform === "facebook" ? facebookAuthority : threadsAuthority;
    // Both are decoded in canonical schema order, independent of wire key ordering.
    if (JSON.stringify(authority.parse(credential.authority)) !== JSON.stringify(authority.parse(job.authority))) throw new AnalyticsWorkerStopped("invalid_contract");
    return credential.access_token;
  }

  async reservePage(job: AnalyticsClaim, checkpoint: AnalyticsWorkerState["checkpoint"]) {
    return this.decode(z.object({ request_id: z.string().uuid(), cursor: z.string().nullable(), pages_fetched: z.number().int().min(0) }).strict(),
      await this.call(`reserve_${family(job.platform)}_analytics_inventory_page`, { ...jobArgs(job), p_expected_cursor: checkpoint.cursor, p_expected_pages: checkpoint.pages_fetched }));
  }

  async commitPage(job: AnalyticsClaim, page: { request_id: string }, response: { ids: string[]; next: string | null; hasMore: boolean }): Promise<void> {
    this.decode(z.object({ job_id: z.literal(job.job_id), job_generation: z.literal(job.job_generation), pages_fetched: z.number().int().positive(),
      inventory_complete: z.boolean(), inventory_truncated: z.boolean() }).strict(),
    await this.call(`commit_${family(job.platform)}_analytics_inventory_page`, { ...jobArgs(job), p_request_id: page.request_id,
      p_post_ids: response.ids, p_next_cursor: response.next, p_has_more: response.hasMore }));
  }

  async reserveCapture(job: AnalyticsClaim, key: string, request: CaptureRequest): Promise<AnalyticsCapture> {
    const reserved = this.decode(capture, await this.call(`reserve_${family(job.platform)}_analytics_capture`,
      { ...jobArgs(job), p_operation_key: key, p_request: request }));
    if (reserved.job_id !== job.job_id || reserved.job_generation !== job.job_generation || reserved.kind !== request.kind
      || reserved.subject_id !== request.subject_id || reserved.metric_date !== (request.metric_date ?? null)) throw new AnalyticsWorkerStopped("invalid_contract");
    return reserved;
  }

  async persistCapture(job: AnalyticsClaim, captureId: string, payload: Record<string, unknown>): Promise<void> {
    this.decode(z.object({ job_id: z.literal(job.job_id), job_generation: z.literal(job.job_generation), capture_id: z.literal(captureId),
      written: z.number().int().min(0), report_revision: z.number().int().positive().safe() }).strict(),
    await this.call(`persist_${family(job.platform)}_analytics_capture`, { ...jobArgs(job), p_capture_id: captureId, p_payload: payload }));
  }

  async complete(job: AnalyticsClaim, outcome: "success" | "partial" | "failed" | "retry", reason: string | null, retryAt: string | null = null): Promise<void> {
    this.decode(z.object({ job_id: z.literal(job.job_id), job_generation: z.literal(job.job_generation), state: z.literal(outcome),
      on_time: z.boolean(), due_at: z.string().datetime({ offset: true }), next_due_at: z.string().datetime({ offset: true }) }).strict(),
    await this.call(`complete_${family(job.platform)}_analytics_collection_job`, { ...jobArgs(job), p_outcome: outcome, p_reason: reason, p_retry_at: retryAt }));
  }

  async throttle(bucketKey: string): Promise<{ usage_percent: number | null; throttled_until: string | null } | null> {
    return this.decode(z.object({ usage_percent: z.number().min(0).max(100).nullable(),
      throttled_until: z.string().datetime({ offset: true }).nullable() }).strict().nullable(),
    await this.call("read_meta_analytics_provider_throttle", { p_bucket_key: bucketKey }));
  }

  async recordThrottle(bucketKey: string, usage: number, until: string | null): Promise<void> {
    const receipt = this.decode(z.object({ bucket_key: z.literal(bucketKey), usage_percent: z.literal(usage),
      throttled_until: z.string().datetime({ offset: true }).nullable(), job_id: z.null() }).strict(),
    await this.call("record_instagram_provider_throttle_http", { p_bucket_key: bucketKey, p_usage_percent: usage,
      p_throttled_until: until, p_job_id: null, p_claim_token: null, p_job_generation: null }));
    // PostgreSQL normalizes an instant's spelling; compare the actual instant.
    if (until === null ? receipt.throttled_until !== null : receipt.throttled_until === null
      || Date.parse(receipt.throttled_until) !== Date.parse(until)) throw new AnalyticsWorkerStopped("invalid_contract");
  }

  async retentionTargets(platform: OwnedAnalyticsPlatform, dryRun: boolean) {
    return this.decode(z.discriminatedUnion("state", [z.object({ state: z.literal("disabled") }).strict(),
      z.object({ state: z.literal("enabled"), targets: z.array(z.object({ account_id: z.string().uuid(),
        last_visited_at: z.string().datetime({ offset: true }).nullable() }).strict()).max(100) }).strict()]),
    await this.call("list_meta_analytics_retention_targets", { p_platform: platform, p_dry_run: dryRun }));
  }

  async cleanup(input: { platform: OwnedAnalyticsPlatform; accountId: string; floor: string; limit: number; dryRun: boolean }) {
    const receipt = this.decode(z.object({ deleted: z.number().int().min(0).max(input.limit), visible_deleted: z.number().int().min(0).max(input.limit).optional(),
      dry_run: z.literal(input.dryRun), skipped: z.boolean(), report_revision: z.number().int().positive().safe().nullable(),
      floor: z.string().datetime({ offset: true }) }).strict(),
    await this.call("cleanup_meta_analytics_target", { p_platform: input.platform, p_account_id: input.accountId,
      p_floor: input.floor, p_limit: input.limit, p_dry_run: input.dryRun }));
    if (Date.parse(receipt.floor) !== Date.parse(input.floor)) throw new AnalyticsWorkerStopped("invalid_contract");
    return receipt;
  }
}
