// The Stage 4 handler.
//
// `index.ts` only routes: when `action` is in the Stage 4 set it hands the
// already-authenticated caller, and the body it already parsed, to this module
// BEFORE the legacy account lookup. A Request body can be read exactly once,
// so the caller passes the parsed value and this module never touches `req`.
// The handler is built from injected ports so it is testable without Supabase.

import { z } from "https://esm.sh/zod@3.25.76";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  STAGE4_ACTIONS,
  type Stage4Action,
  type Stage4ModerationStatus,
  type Stage4Reason,
  type Stage4Request,
  stage4RequestSchema,
  STAGE4_ACTION_CAPABILITY,
  STAGE4_ACTION_REQUIRES_HELD,
  type Stage4VideoRow,
  type Stage4CommentRow,
  type Stage4VideoPagePayload,
  type Stage4ThreadPagePayload,
  type Stage4ReplyPagePayload,
  type Stage4ReceiptPayload,
  type Stage4BanConfirmationPayload,
  type Stage4OperationStatusPayload,
  type Stage4CapabilitiesPayload,
  type Stage4Capability,
} from "./contracts.ts";
import {
  HANDLE_PREFIX,
  CURSOR_PREFIX,
  BAN_CONFIRMATION_PREFIX,
  sealHandle,
  unsealHandle,
  sealCursor,
  unsealCursor,
  sealBanConfirmation,
  unsealBanConfirmation,
  type HandlePayload,
  HANDLE_TTL_MS,
  CURSOR_TTL_MS,
  BAN_CONFIRMATION_TTL_MS,
  MAX_CURSOR_HOPS,
} from "./sealing.ts";
import { normaliseText, computeIntentDigests, computeLogicalDigests, type DigestKeys } from "./digests.ts";
import * as provider from "./provider.ts";
import type { Stage4ProviderClass } from "./provider.ts";
import { writeRefusalAudit, sanitiseAction } from "./audit.ts";
import { readCapabilities, admitsCapability, SettingsReadError } from "./rollout.ts";
import { STAGE4_HOLD_FROM_PUBLISHED } from "./contractTypes.ts";
import {
  stage4RateLimit,
  STAGE4_RATE_LIMITS,
  resetAnonymousSlots,
  runInAnonymousSlot,
} from "./rateLimit.ts";

export interface Stage4Deps {
  admin: SupabaseClient;
  fetcher: typeof fetch;
  /** Wall-clock milliseconds: handles, cursors and ban confirmations expire on it. */
  now: () => number;
  /**
   * Monotonic milliseconds: the anonymous refusal gate's cool-down runs on it,
   * so a wall clock that jumps can neither reopen the gate early nor keep it
   * closed.
   */
  monotonicNow: () => number;
  newRequestId: () => string;
  signingSecret: string;
}

/** One routed Stage 4 call: the authenticated caller and the parsed body. */
export interface Stage4Call {
  deps: Stage4Deps;
  corsHeaders: Record<string, string>;
  userId: string;
  isServiceRole: boolean;
  /** The body `index.ts` already parsed from the request. */
  body: unknown;
}

const cors = (extra: Record<string, string> = {}) => ({
  "Content-Type": "application/json",
  ...extra,
});

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * The anonymous audit bucket: at most 30 rows per minute for the whole
 * function. Beyond that, one counter row per minute records how many were
 * suppressed (the counter insert itself is gated to 1/minute), and each
 * suppressed refusal still emits a sanitised console event above.
 */
const ANON_AUDIT_MAX_PER_MINUTE = 30;

/**
 * In-process memory of the shared anonymous bucket's answer, so that a flood of
 * unauthenticated refusals stops costing the database anything once the bucket
 * has said no. After a refusal from the shared bucket, further anonymous
 * refusals for ANON_BUCKET_CLOSED_MS skip the bucket call entirely (they still
 * get the same 401 and the console event and join the suppression tally). The
 * counter row is attempted at most once per ANON_COUNTER_INTERVAL_MS per
 * instance. Both only ever make this instance write LESS than the shared
 * limits already allow.
 *
 * Both windows are measured on the MONOTONIC clock, so a wall clock that
 * jumps (a step back, an NTP correction) can neither reopen the gate early
 * nor keep it closed.
 */
const ANON_BUCKET_CLOSED_MS = 10_000;
const ANON_COUNTER_INTERVAL_MS = 60_000;
let anonBucketClosedUntil = 0;
let anonCounterNextAt = 0;

/** Test seam: forget what this instance learned about the shared bucket. */
export function resetAnonRefusalGate(): void {
  anonBucketClosedUntil = 0;
  anonCounterNextAt = 0;
  resetAnonymousSlots();
}

/**
 * Whether the shared anonymous bucket admits one more audit row. At most ONE
 * probe is in flight per worker: a request that arrives while it is pending is
 * treated as refused without a call of its own (it is counted in the
 * suppression tally), so a burst can never put more than one call on the
 * shared row. The probe waits at most ANON_PROBE_TIMEOUT_MS, and a refusal or
 * a timeout closes the gate for ANON_BUCKET_CLOSED_MS, so over time this worker
 * makes at most one probe per ANON_BUCKET_CLOSED_MS (plus one counter call a
 * minute).
 *
 * The probe's slot is freed by the CALL, not by the timeout: a call that is
 * still running keeps the slot, so this worker makes NO further probe until
 * that call settles. A call that never settles therefore stops this worker
 * from probing again for the rest of its life: that is the fail-closed
 * outcome, and every refusal it still answers keeps its console event.
 */
async function anonBucketAdmits(deps: Stage4Deps): Promise<boolean> {
  if (deps.monotonicNow() < anonBucketClosedUntil) return false;
  const outcome = await runInAnonymousSlot("bucket_probe", () =>
    stage4RateLimit(deps.admin, "anonymous", "stage4_audit_anon", ANON_AUDIT_MAX_PER_MINUTE, 60));
  // A request that finds the probe running is refused without a call of its
  // own and does not close the gate: the running probe decides that.
  if (outcome.kind === "busy") return false;
  const admitted = outcome.kind === "settled" && outcome.value.allowed;
  if (!admitted) anonBucketClosedUntil = deps.monotonicNow() + ANON_BUCKET_CLOSED_MS;
  return admitted;
}

async function refusal(
  deps: Stage4Deps,
  status: number,
  reason: Stage4Reason,
  requestId: string,
  headers: Record<string, string>,
  audit: { action: string; userId: string | null; accountId: string | null; operationId: string | null; providerClass?: string | null; operationVerified?: boolean },
): Promise<Response> {
  // The AUTHENTICATED audit write belongs to the request (awaited, so it
  // cannot outlive an edge worker that has already answered), and it never
  // changes the answer: writeRefusalAudit swallows and logs its own
  // failures. The ANONYMOUS write is bounded instead: it holds a slot of its
  // own and may complete after the response has gone out, and a frozen
  // isolate may drop the row. The console event and the counter row are the
  // trace of that refusal.
  await writeRefusalAudit(deps.admin, {
    action: audit.action,
    reason,
    providerClass: audit.providerClass ?? null,
    requestId,
    userId: audit.userId,
    accountId: audit.accountId,
    // A client-supplied operation key is an UNVERIFIED identifier until a
    // receipt row exists for it (spec 12); only post-claim refusals pass it.
    operationId: audit.operationVerified === true ? audit.operationId : null,
  }, {
    rateLimitBucket: () => anonBucketAdmits(deps),
    counterSink: async (suppressed) => {
      // At most one counter attempt per interval per instance, and only once
      // the shared bucket has actually refused (a request that merely found a
      // probe in flight is not a refusal): the tally stays in memory
      // (returning false keeps it) and costs no database work.
      const now = deps.monotonicNow();
      if (now >= anonBucketClosedUntil || now < anonCounterNextAt) return false;
      anonCounterNextAt = now + ANON_COUNTER_INTERVAL_MS;
      // The counter probe holds a slot of its own: while one is running this
      // worker starts no second one, and the request waits at most the bound
      // for it.
      const counter = await runInAnonymousSlot("counter_probe", () =>
        stage4RateLimit(deps.admin, "anonymous", "stage4_audit_counter", 1, 60));
      if (counter.kind !== "settled" || !counter.value.allowed) return false;
      // The counter row: one insert at a time per worker. A request that
      // finds the slot taken skips the insert (it never waits on the running
      // one and never starts a second) and the tally stays in memory.
      const insertOutcome = await runInAnonymousSlot("counter_insert", () => deps.admin.from("system_logs").insert({
        level: "warn",
        category: "edge",
        source: "comment-manager",
        message: "Stage 4 refusal audit suppressed",
        user_id: null,
        metadata: {
          action: "unknown",
          reason: "audit_suppressed",
          provider_class: null,
          request_id: "",
          suppressed: suppressed,
        },
      }));
      // An insert that is still running past the bound may land after the
      // response has gone out; the tally stays in memory and the suppression
      // console event remains the trace either way.
      if (insertOutcome.kind === "busy" || insertOutcome.kind === "bound") return false;
      if (insertOutcome.kind === "failed") {
        console.warn("comment-manager stage4 audit counter insert failed: cause=exception");
        return false;
      }
      if (insertOutcome.value && insertOutcome.value.error) {
        console.warn("comment-manager stage4 audit counter insert failed: cause=insert_error");
        return false;
      }
      return true;
    },
  });
  return json(status, { ok: false, request_id: requestId, reason }, headers);
}

function ok(body: unknown, headers: Record<string, string>): Response {
  return json(200, body, headers);
}

// ---- account read (verified) ---------------------------------------------

interface AccountRow {
  id: string;
  user_id: string;
  platform: string;
  platform_user_id: string;
  auth_provider: string | null;
  is_active: boolean;
  needs_reauth: boolean;
  binding_generation: number;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  account_metadata: unknown;
}

/**
 * The owner-scoped account read. "The read failed" and "there is no such row"
 * are different answers: the first is temporary (503 upstream) and must never
 * be reported as not_found, which tells a browser that a pending operation's
 * receipt is gone for good.
 */
async function readAccount(
  admin: SupabaseClient,
  accountId: string,
  userId: string,
): Promise<{ kind: "found"; account: AccountRow } | { kind: "absent" } | { kind: "failed" }> {
  try {
    const { data, error } = await admin
      .from("social_accounts")
      .select("id,user_id,platform,platform_user_id,auth_provider,is_active,needs_reauth,binding_generation,access_token,refresh_token,token_expires_at,account_metadata")
      .eq("id", accountId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return { kind: "failed" };
    return data ? { kind: "found", account: data as AccountRow } : { kind: "absent" };
  } catch {
    return { kind: "failed" };
  }
}

// ---- token preparation (shared helper) ------------------------------------

async function prepareToken(
  account: AccountRow,
  deps: Stage4Deps,
): Promise<{ ok: true; token: string } | { ok: false; reason: Stage4Reason }> {
  // Reuse the shared helper via a dynamic import to avoid a circular dep.
  const mod = await import("../../_shared/youtubeComments.ts");
  const nativeAccount = {
    id: account.id,
    platform: "youtube" as const,
    auth_provider: "native" as const,
    access_token: account.access_token,
    refresh_token: account.refresh_token,
    token_expires_at: account.token_expires_at,
    platform_user_id: account.platform_user_id,
    needs_reauth: account.needs_reauth,
  };
  // Health-neutral: a Stage 4 read or write never records needs_reauth or
  // rewrites granted scopes (spec 11); a refusal is only reported to the caller.
  const result = await mod.nativeAccessToken(
    nativeAccount,
    { admin: deps.admin, fetcher: deps.fetcher },
    { healthNeutral: true },
  );
  if (!result.ok) {
    if (result.kind === "unauthorized") return { ok: false, reason: "account_needs_reauth" };
    return { ok: false, reason: "upstream" };
  }
  return { ok: true, token: result.value.token };
}

// ---- digest keys ----------------------------------------------------------

/** The SQL-held digest keys, or null when they cannot be read (a temporary 503, never a throw). */
async function loadDigestKeys(admin: SupabaseClient): Promise<DigestKeys | null> {
  try {
    const { data, error } = await admin.rpc("youtube_comment_digest_keys");
    if (error || !data) return null;
    const keys = (data.keys ?? []).map((k: { version: number; key: string }) => ({
      version: k.version,
      key: k.key,
    }));
    return { activeVersion: data.active_version, keys };
  } catch {
    return null;
  }
}

/**
 * Settle the receipt without ever letting a settlement write failure change
 * the answer about a response that already happened: the row stays
 * `dispatched`, the status read converts it to `indeterminate` after 90 s,
 * and the failure is logged with the request id only (spec 9.2).
 */
async function settleQuietly(
  deps: Stage4Deps,
  args: {
    ownerId: string;
    operationId: string;
    attemptToken: string;
    outcome: "confirmed" | "refused" | "indeterminate";
    reason: string | null;
    providerClass: Stage4ProviderClass;
    resultThreadId: string | null;
    resultCommentId: string | null;
  },
  requestId: string,
): Promise<boolean> {
  try {
    // supabase-js reports a failed call as `{ error }` and the SQL function
    // reports a refusal as `{ ok: false }`; neither throws, so both are read.
    const { data, error } = await deps.admin.rpc("youtube_comment_op_settle", {
      p_owner_id: args.ownerId,
      p_operation_id: args.operationId,
      p_attempt_token: args.attemptToken,
      p_outcome: args.outcome,
      p_reason: args.reason,
      p_provider_class: args.providerClass,
      p_result_thread_id: args.resultThreadId,
      p_result_comment_id: args.resultCommentId,
    });
    if (error || !data || data.ok !== true) {
      console.warn(
        `comment-manager stage4 settlement not recorded: request_id=${requestId} outcome=${args.outcome} cause=${error ? "rpc_error" : "refused"}`,
      );
      return false;
    }
    return true;
  } catch (error) {
    console.warn(
      `comment-manager stage4 settlement write failed: request_id=${requestId} outcome=${args.outcome} error_class=${error instanceof Error ? error.name : "unknown"}`,
    );
    return false;
  }
}

/**
 * Settle, then answer. When the settlement did not commit, the receipt is
 * still `dispatched` (it reads `indeterminate` after 90 s), so the answer is
 * `indeterminate` whatever the provider said: a client that was told
 * "confirmed" would drop its key while the receipt cannot be resolved, and a
 * "refused" would invite a resend of something that may have been applied.
 * The same key is queryable through youtube_operation_status.
 */
async function settleAndRespond(
  deps: Stage4Deps,
  ctx: {
    userId: string;
    accountId: string;
    account: AccountRow;
    action: Stage4Action;
    receiptAction: Stage4ReceiptPayload["action"];
    operationId: string;
    attemptToken: string;
    requestId: string;
    headers: Record<string, string>;
    moderationStatus: string | null;
    banRequested: boolean;
  },
  result: {
    outcome: "confirmed" | "refused" | "indeterminate";
    reason: string | null;
    providerClass: Stage4ProviderClass;
    resultThreadId: string | null;
    resultCommentId: string | null;
  },
): Promise<Response> {
  const settled = await settleQuietly(deps, {
    ownerId: ctx.userId,
    operationId: ctx.operationId,
    attemptToken: ctx.attemptToken,
    outcome: result.outcome,
    reason: result.reason,
    providerClass: result.providerClass,
    resultThreadId: result.resultThreadId,
    resultCommentId: result.resultCommentId,
  }, ctx.requestId);
  const outcome = settled ? result.outcome : "indeterminate";
  const base = {
    operation_id: ctx.operationId,
    action: ctx.receiptAction,
    moderation_status: ctx.moderationStatus as Stage4ReceiptPayload["moderation_status"],
    ban_requested: ctx.banRequested,
    binding_generation: ctx.account.binding_generation,
    channel_id: ctx.account.platform_user_id,
  };
  if (outcome === "confirmed") {
    const payload: Stage4ReceiptPayload = {
      ...base, state: "confirmed", reason: null, provider_class: null,
      result_thread_id: result.resultThreadId, result_comment_id: result.resultCommentId,
    };
    return ok({ ok: true, request_id: ctx.requestId, data: payload }, ctx.headers);
  }
  if (outcome === "refused") {
    return refusal(deps, 403, result.reason as Stage4Reason, ctx.requestId, ctx.headers, {
      action: ctx.action, userId: ctx.userId, accountId: ctx.accountId, operationId: ctx.operationId, providerClass: "http_4xx", operationVerified: true,
    });
  }
  const payload: Stage4ReceiptPayload = {
    ...base, state: "indeterminate", reason: "indeterminate", provider_class: result.providerClass,
    result_thread_id: null, result_comment_id: result.resultCommentId,
  };
  return ok({ ok: true, request_id: ctx.requestId, data: payload }, ctx.headers);
}

/** A provider id is evidence only when it is a non-empty string. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

// What this handler reads out of a YouTube response. The body is untrusted
// provider input, so every field is optional and each use checks the value
// before it is relied on; these types only name the shape that is read.
interface YtCommentSnippet {
  channelId?: string;
  videoId?: string;
  parentId?: string;
  authorChannelId?: { value?: string };
  authorDisplayName?: string;
  authorProfileImageUrl?: string;
  textOriginal?: string;
  textDisplay?: string;
  publishedAt?: string;
  likeCount?: number;
  moderationStatus?: string;
}
interface YtComment {
  id?: string;
  snippet?: YtCommentSnippet;
}
interface YtThread {
  id?: string;
  snippet?: { videoId?: string; channelId?: string; topLevelComment?: YtComment };
  replies?: { comments?: YtComment[] };
}
interface YtVideo {
  id?: string;
  snippet?: { channelId?: string };
}
interface YtUpload {
  snippet?: {
    resourceId?: { videoId?: string };
    title?: string;
    publishedAt?: string;
    thumbnails?: { default?: { url?: string } };
  };
}
/** A list response body: `items` and the next page token. */
type YtList<T> = { items?: T[]; nextPageToken?: string } | null | undefined;
/** A write response body: the created or updated resource, as far as the evidence check reads it. */
type YtWriteBody = {
  id?: unknown;
  snippet?: {
    videoId?: unknown;
    channelId?: unknown;
    parentId?: unknown;
    topLevelComment?: { id?: unknown };
  };
} | null | undefined;

/**
 * The items of a provider list body: an empty array for a valid empty page
 * (no `items`), the array otherwise, and null when the body did not parse to
 * an object or `items` is present but not an array. A null is an upstream
 * error the user can retry, never an empty successful page.
 */
function listItems<T>(body: unknown): T[] | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const items = (body as { items?: unknown }).items;
  if (items === undefined) return [];
  return Array.isArray(items) ? (items as T[]) : null;
}

/**
 * A provider refusal while verifying a target keeps its classified reason
 * (quota, scope, authorisation, ...); only a resource the provider says does
 * not exist is "target not verified".
 */
function targetRefusal(reason: string): WriteTargetCheck {
  return reason === "not_found_provider"
    ? { ok: false, status: 404, reason: "target_not_verified", providerClass: "http_4xx" }
    : { ok: false, status: 403, reason: reason as Stage4Reason, providerClass: "http_4xx" };
}

type WriteTargetCheck =
  | { ok: true; citem: YtComment }
  | { ok: false; status: number; reason: Stage4Reason; providerClass?: Stage4ProviderClass };

/**
 * The ONE validator for the last read before any write (spec 8.2, 9.1): the
 * video is on the account's channel, the comment exists under the handle's
 * id, its resource channel and video agree where Google returns them, and its
 * parent matches the handle's kind (a thread has none, a reply has the
 * handle's canonical parent). Reply, edit, moderate and the ban path all use
 * this, so none of them can skip a leg.
 */
async function verifyWriteTarget(
  deps: Stage4Deps,
  account: AccountRow,
  token: string,
  h: { vi: string; co: string; k: string; p: string },
): Promise<WriteTargetCheck> {
  const vres = await provider.readVideo({ fetcher: deps.fetcher }, token, h.vi);
  if (vres.kind !== "success") {
    return vres.kind === "refused"
      ? targetRefusal(vres.reason)
      : { ok: false, status: 502, reason: "upstream", providerClass: vres.providerClass };
  }
  const videoItem = ((vres.body as YtList<YtVideo>)?.items ?? [])[0];
  if (!videoItem || videoItem.id !== h.vi || videoItem?.snippet?.channelId !== account.platform_user_id) {
    return { ok: false, status: 403, reason: "video_not_owned" };
  }
  const cres = await provider.readComment({ fetcher: deps.fetcher }, token, h.co);
  if (cres.kind !== "success") {
    return cres.kind === "refused"
      ? targetRefusal(cres.reason)
      : { ok: false, status: 502, reason: "upstream", providerClass: cres.providerClass };
  }
  const citem = ((cres.body as YtList<YtComment>)?.items ?? [])[0];
  if (!citem || citem.id !== h.co) return { ok: false, status: 404, reason: "target_not_verified" };
  const snippet = citem.snippet ?? {};
  if (snippet.channelId && String(snippet.channelId) !== account.platform_user_id) {
    return { ok: false, status: 400, reason: "target_not_verified" };
  }
  if (snippet.videoId && String(snippet.videoId) !== h.vi) {
    return { ok: false, status: 400, reason: "target_not_verified" };
  }
  const parent = snippet.parentId ? String(snippet.parentId) : "";
  if (h.k === "thread" ? parent !== "" : parent !== h.p) {
    return { ok: false, status: 400, reason: "target_not_verified" };
  }
  return { ok: true, citem };
}

/** The full receipt payload for an `already_recorded` answer. */
function recordedPayload(
  input: { operation_id: string },
  claim: { state?: string; result_comment_id?: string | null; result_thread_id?: string | null },
  account: AccountRow,
  action: Stage4ReceiptPayload["action"],
): Stage4ReceiptPayload {
  const state = (claim.state ?? "refused") as Stage4ReceiptPayload["state"];
  return {
    operation_id: input.operation_id,
    action,
    state,
    reason: state === "refused" ? "already_recorded" : null,
    provider_class: null,
    moderation_status: null,
    ban_requested: false,
    result_thread_id: claim.result_thread_id ?? null,
    result_comment_id: claim.result_comment_id ?? null,
    binding_generation: account.binding_generation,
    channel_id: account.platform_user_id,
  };
}

// ---- handle verification --------------------------------------------------

async function verifyHandle(
  handle: string,
  deps: Stage4Deps,
  expected: { ownerId: string; accountId: string; generation: number; videoId?: string; commentId?: string },
): Promise<{ ok: true; payload: HandlePayload } | { ok: false; reason: Stage4Reason }> {
  const payload = await unsealHandle(handle, { signingSecret: deps.signingSecret, now: deps.now() });
  if (!payload) return { ok: false, reason: "invalid_handle" };
  if (payload.e < deps.now()) return { ok: false, reason: "expired_handle" };
  if (payload.o !== expected.ownerId) return { ok: false, reason: "cross_context" };
  if (payload.a !== expected.accountId) return { ok: false, reason: "cross_context" };
  if (payload.g !== expected.generation) return { ok: false, reason: "cross_context" };
  if (expected.videoId && payload.vi !== expected.videoId) return { ok: false, reason: "cross_context" };
  if (expected.commentId && payload.co !== expected.commentId) return { ok: false, reason: "cross_context" };
  return { ok: true, payload };
}

/**
 * Unseal a mutation target handle and map every failure to its reason. The
 * expected values are the live account's, so a cross-account, cross-binding
 * or expired handle is named as such instead of a generic invalid_handle.
 */
async function verifyTargetHandle(
  handle: string,
  deps: Stage4Deps,
  account: AccountRow,
  userId: string,
): Promise<{ ok: true; payload: HandlePayload } | { ok: false; reason: Stage4Reason }> {
  return await verifyHandle(handle, deps, {
    ownerId: userId,
    accountId: account.id,
    generation: account.binding_generation,
  });
}

// ---- chain validation for a thread row ------------------------------------

interface ChainCheckResult {
  ok: boolean;
  inconsistent: boolean;
  reason?: Stage4Reason;
}

function validateThreadChain(
  videoId: string,
  thread: YtThread,
  accountChannel: string,
  verifiedVideoChannel: string,
): { ok: boolean; inconsistent: boolean } {
  // video verified as owned in this request (caller ensures verifiedVideoChannel === accountChannel)
  // Spec 8.2: the thread MUST name the video and the account's channel; a
  // missing field is an inconsistency, not a pass. Only the comment-level
  // optional fields (below) may be absent.
  if (!thread?.snippet?.videoId || String(thread.snippet.videoId) !== videoId) return { ok: false, inconsistent: true };
  if (!thread?.snippet?.channelId || String(thread.snippet.channelId) !== accountChannel) return { ok: false, inconsistent: true };
  const top = thread?.snippet?.topLevelComment;
  if (!top?.id || !thread?.id) return { ok: false, inconsistent: true };
  if (top?.snippet?.parentId) return { ok: false, inconsistent: true };
  if (top?.snippet?.channelId && top.snippet.channelId !== accountChannel) return { ok: false, inconsistent: true };
  if (top?.snippet?.videoId && top.snippet.videoId !== videoId) return { ok: false, inconsistent: true };
  // `replies.comments` sits at the resource top level, beside `snippet`
  // (Google reference, CommentThreads resource representation).
  for (const r of thread?.replies?.comments ?? []) {
    // An inline reply MUST carry its parent and it MUST be this thread's top comment.
    if (!r?.id || !r?.snippet?.parentId || String(r.snippet.parentId) !== String(top.id)) return { ok: false, inconsistent: true };
    if (r?.snippet?.channelId && r.snippet.channelId !== accountChannel) return { ok: false, inconsistent: true };
    if (r?.snippet?.videoId && r.snippet.videoId !== videoId) return { ok: false, inconsistent: true };
  }
  return { ok: true, inconsistent: false };
}

// ---- row sealing ----------------------------------------------------------

function sealRow(
  deps: Stage4Deps,
  account: AccountRow,
  videoId: string,
  thread: { id?: string },
  kind: "thread" | "reply",
  comment: { id?: string } | undefined,
  observedStatus: string | null,
  canonicalParent: string,
  authorChannel: string | null,
): Promise<string> {
  return sealHandle(
    {
      o: account.user_id,
      a: account.id,
      g: account.binding_generation,
      c: account.platform_user_id,
      vi: videoId,
      th: String(thread?.id ?? ""),
      co: String(comment?.id ?? ""),
      k: kind,
      p: canonicalParent,
      au: authorChannel ?? "",
      s: observedStatus,
    },
    { signingSecret: deps.signingSecret, now: deps.now(), ttlMs: HANDLE_TTL_MS },
  );
}

// ---- parse rows -----------------------------------------------------------

function parseThreadRow(
  thread: YtThread,
  account: AccountRow,
  videoId: string,
): { threadRow: Stage4CommentRow; replyRows: Stage4CommentRow[] } | null {
  const top = thread?.snippet?.topLevelComment;
  const topId = String(top?.id ?? thread?.id ?? "");
  const authorChannel = top?.snippet?.authorChannelId?.value ? String(top.snippet.authorChannelId.value) : null;
  const threadRow: Stage4CommentRow = {
    handle: "", // filled by caller after sealing
    kind: "thread",
    comment_id: topId,
    thread_id: String(thread?.id ?? ""),
    video_id: videoId,
    canonical_parent_id: "",
    author_channel_id: authorChannel,
    author_name: String(top?.snippet?.authorDisplayName ?? "Unknown"),
    author_avatar_url: top?.snippet?.authorProfileImageUrl ?? null,
    text: String(top?.snippet?.textOriginal ?? top?.snippet?.textDisplay ?? ""),
    published_at: String(top?.snippet?.publishedAt ?? new Date().toISOString()),
    like_count: Number(top?.snippet?.likeCount ?? 0),
    moderation_status: top?.snippet?.moderationStatus ? String(top.snippet.moderationStatus) : null,
    is_own: !!account.platform_user_id && authorChannel === account.platform_user_id,
  };
  const replyRows: Stage4CommentRow[] = (Array.isArray(thread?.replies?.comments) ? thread.replies.comments : []).map((r: YtComment) => ({
    handle: "",
    kind: "reply" as const,
    comment_id: String(r?.id ?? ""),
    thread_id: String(thread?.id ?? ""),
    video_id: videoId,
    canonical_parent_id: topId,
    author_channel_id: r?.snippet?.authorChannelId?.value ? String(r.snippet.authorChannelId.value) : null,
    author_name: String(r?.snippet?.authorDisplayName ?? "Unknown"),
    author_avatar_url: r?.snippet?.authorProfileImageUrl ?? null,
    text: String(r?.snippet?.textOriginal ?? r?.snippet?.textDisplay ?? ""),
    published_at: String(r?.snippet?.publishedAt ?? new Date().toISOString()),
    like_count: Number(r?.snippet?.likeCount ?? 0),
    moderation_status: r?.snippet?.moderationStatus ? String(r.snippet.moderationStatus) : null,
    is_own: !!account.platform_user_id && (r?.snippet?.authorChannelId?.value === account.platform_user_id),
  }));
  return { threadRow, replyRows };
}

// ---- cursor hops -----------------------------------------------------------

/**
 * The hop count of a sealed cursor. 0 means the field was absent or malformed,
 * which refuses the cursor; a hop above MAX_CURSOR_HOPS is the bounded way a
 * page-token cycle dies (spec 8.2: cyclic tokens are refused).
 */
function cursorHop(c: { h?: unknown } | null): number {
  if (typeof c?.h !== "number" || !Number.isFinite(c.h) || c.h < 1) return 0;
  return Math.floor(c.h);
}

/**
 * Only the actions that can change YouTube are held to the low write cap and
 * the ban confirmation to the daily ban cap. Everything else — lists, the
 * capability status the page asks for on every load, and receipt status — is
 * a read. (Actions with no capability, like the status ones, used to fall
 * through to the write cap, so a few page loads in a minute shut the whole
 * view down fail-closed.)
 */
export function rateLimitFor(action: Stage4Action): { max: number; windowSeconds: number } {
  if (action === "youtube_ban_confirmation") return STAGE4_RATE_LIMITS.ban;
  return STAGE4_ACTION_CAPABILITY[action] === "write" ? STAGE4_RATE_LIMITS.write : STAGE4_RATE_LIMITS.read;
}

/**
 * Why a capability is not available, or null when it is. An unreadable
 * rollout setting is an ERROR (503 upstream), never a 403 that looks like the
 * capability being off (spec 13).
 */
async function capabilityRefusal(
  admin: SupabaseClient,
  accountId: string,
  capability: Stage4Capability,
): Promise<{ status: 403 | 503; reason: Stage4Reason } | null> {
  try {
    if (await admitsCapability(admin, accountId, capability)) return null;
    const status = await readCapabilities(admin, accountId);
    return { status: 403, reason: (status.capabilities[capability].reason ?? "capability_off") as Stage4Reason };
  } catch (error) {
    if (error instanceof SettingsReadError) return { status: 503, reason: "upstream" };
    throw error;
  }
}

// ---- the handler ----------------------------------------------------------

export async function handleStage4(call: Stage4Call): Promise<Response> {
  const { deps, corsHeaders } = call;
  const userId = call.userId;
  const isServiceRole = call.isServiceRole === true;
  const requestId = deps.newRequestId();
  const headers = { ...corsHeaders, "Content-Type": "application/json", "X-Request-Id": requestId };

  if (typeof userId !== "string" || userId.length === 0) {
    return refusal(deps, 401, "unauthorized", requestId, headers, {
      action: "unknown", userId: null, accountId: null, operationId: null,
    });
  }

  // `index.ts` already parsed the body; anything unparseable or non-object
  // fails the strict schema below with an audited invalid_request.
  const body = call.body;

  const parsed = stage4RequestSchema.safeParse(body);
  if (!parsed.success) {
    const action = sanitiseAction((body as { action?: unknown })?.action);
    return refusal(deps, 400, "invalid_request", requestId, headers, {
      action, userId, accountId: null, operationId: null,
    });
  }
  const input = parsed.data as Stage4Request;
  const action = input.action as Stage4Action;

  // Service-role callers are refused for every Stage 4 action. The audit row
  // carries the identified user but NOT the body's account id: it has not
  // been verified against this owner, and unverified identifiers are never
  // logged (spec 12).
  if (isServiceRole) {
    return refusal(deps, 403, "service_role_not_allowed", requestId, headers, {
      action, userId, accountId: null, operationId: null,
    });
  }

  // Hold is not offered while STAGE4_HOLD_FROM_PUBLISHED is off: a published
  // or rejected comment cannot return to held (Google's implementation guide)
  // and a 204 would be recorded as confirmed while nothing changed. The status
  // in a handle is only what the list saw when it was issued, so a handle from
  // a held moment cannot prove the comment is still held. One check, straight
  // after validation and identity, before the limiter and any account work.
  if (action === "youtube_moderate_comment"
    && (input as Extract<Stage4Request, { action: "youtube_moderate_comment" }>).status === "heldForReview"
    && !STAGE4_HOLD_FROM_PUBLISHED) {
    return refusal(deps, 400, "invalid_request", requestId, headers, { action, userId, accountId: null, operationId: null });
  }

  const accountId = (input as { social_account_id: string }).social_account_id;

  // Rate limit.
  const limit = rateLimitFor(action);
  const rl = await stage4RateLimit(
    deps.admin,
    userId,
    action.startsWith("youtube_video_page") ? "read" : action,
    limit.max,
    limit.windowSeconds,
  );
  if (!rl.allowed) {
    return refusal(deps, 429, "rate_limited", requestId, headers, {
      action, userId, accountId: null, operationId: null,
    });
  }

  // Account read (verified). A miss is not_found, identical for a foreign, an
  // absent and a re-bound row; the audit never carries the unverified id.
  const accountRead = await readAccount(deps.admin, accountId, userId);
  if (accountRead.kind === "failed") {
    return refusal(deps, 503, "upstream", requestId, headers, {
      action, userId, accountId: null, operationId: null,
    });
  }
  if (accountRead.kind === "absent") {
    return refusal(deps, 404, "not_found", requestId, headers, {
      action, userId, accountId: null, operationId: null,
    });
  }
  const account = accountRead.account;
  if (account.platform !== "youtube") {
    return refusal(deps, 404, "not_found", requestId, headers, {
      action, userId, accountId, operationId: (input as { operation_id?: string }).operation_id ?? null,
    });
  }
  if (account.auth_provider !== "native") {
    return refusal(deps, 403, "provider_unsupported", requestId, headers, {
      action, userId, accountId, operationId: (input as { operation_id?: string }).operation_id ?? null,
    });
  }
  if (!account.is_active) {
    return refusal(deps, 403, "account_not_connected", requestId, headers, {
      action, userId, accountId, operationId: (input as { operation_id?: string }).operation_id ?? null,
    });
  }
  // `youtube_operation_status` deliberately keeps working on a row that merely
  // needs a re-auth: needs_reauth does not change the binding, and the spec
  // keeps the local receipt readable under the CURRENT binding with every
  // capability off (spec 7.4). Every other action refuses here.
  if (account.needs_reauth && action !== "youtube_operation_status") {
    return refusal(deps, 403, "account_needs_reauth", requestId, headers, {
      action, userId, accountId, operationId: (input as { operation_id?: string }).operation_id ?? null,
    });
  }

  // Capability gate.
  const requiredCap = STAGE4_ACTION_CAPABILITY[action];
  if (requiredCap) {
    // Distinguishes capability_off vs prerequisite vs not_admitted via the
    // status payload, and an unreadable setting (upstream) from all of them.
    const blocked = await capabilityRefusal(deps.admin, accountId, requiredCap);
    if (blocked) {
      return refusal(deps, blocked.status, blocked.reason, requestId, headers, {
        action, userId, accountId, operationId: (input as { operation_id?: string }).operation_id ?? null,
      });
    }
  }

  // ---- youtube_stage4_capabilities ---------------------------------------
  if (action === "youtube_stage4_capabilities") {
    let status: Awaited<ReturnType<typeof readCapabilities>>;
    try {
      status = await readCapabilities(deps.admin, accountId);
    } catch (error) {
      if (!(error instanceof SettingsReadError)) throw error;
      // An unreadable setting is an error answer, never a payload of "not allowed".
      // It names the settings as the cause so the browser can tell this from a
      // failed transport or an old backend, which both read as the baseline inbox.
      return refusal(deps, 503, "settings_unavailable", requestId, headers, { action, userId, accountId, operationId: null });
    }
    const payload: Stage4CapabilitiesPayload = {
      account_id: accountId,
      capabilities: status.capabilities,
    };
    return ok({ ok: true, request_id: requestId, data: payload }, headers);
  }

  // ---- youtube_video_page ------------------------------------------------
  if (action === "youtube_video_page") {
    const cursorToken = (input as Extract<Stage4Request, { action: "youtube_video_page" }>).cursor;
    let pt: string | undefined;
    let hop = 0;
    if (cursorToken) {
      const c = await unsealCursor(cursorToken, { signingSecret: deps.signingSecret, now: deps.now() });
      if (!c || c.o !== userId || c.a !== accountId || c.g !== account.binding_generation || c.a2 !== "video_page") {
        return refusal(deps, 400, "invalid_handle", requestId, headers, { action, userId, accountId, operationId: null });
      }
      if (c.e < deps.now()) {
        return refusal(deps, 400, "expired_handle", requestId, headers, { action, userId, accountId, operationId: null });
      }
      hop = cursorHop(c);
      if (hop === 0) {
        return refusal(deps, 400, "invalid_handle", requestId, headers, { action, userId, accountId, operationId: null });
      }
      if (hop > MAX_CURSOR_HOPS) {
        return refusal(deps, 400, "expired_handle", requestId, headers, { action, userId, accountId, operationId: null });
      }
      pt = c.pt;
    }
    const tok = await prepareToken(account, deps);
    if (!tok.ok) {
      return refusal(deps, 401, tok.reason, requestId, headers, { action, userId, accountId, operationId: null });
    }
    const res = await provider.listUploads(
      { fetcher: deps.fetcher },
      { id: account.id, platform_user_id: account.platform_user_id, access_token: tok.token },
      tok.token,
      { pageToken: pt },
    );
    if (res.kind === "refused") {
      return refusal(deps, 403, res.reason as Stage4Reason, requestId, headers, { action, userId, accountId, operationId: null, providerClass: "http_4xx" });
    }
    if (res.kind === "indeterminate") {
      return refusal(deps, 502, "upstream", requestId, headers, { action, userId, accountId, operationId: null, providerClass: res.providerClass });
    }
    const uploads = listItems<YtUpload>(res.body);
    if (uploads === null) {
      return refusal(deps, 502, "upstream", requestId, headers, { action, userId, accountId, operationId: null });
    }
    const items = uploads.map((it: YtUpload) => ({
      id: String(it?.snippet?.resourceId?.videoId ?? ""),
      title: String(it?.snippet?.title ?? ""),
      published_at: it?.snippet?.publishedAt ? String(it.snippet.publishedAt) : null,
      thumbnail_url: it?.snippet?.thumbnails?.default?.url ?? null,
    })).filter((v: Stage4VideoRow) => v.id);
    const nextProviderToken = (res.body as YtList<unknown>)?.nextPageToken ? String((res.body as YtList<unknown>)?.nextPageToken) : null;
    // A provider that hands back the token it was just given can only loop: refuse
    // it now instead of sealing the same page again with a higher hop count.
    if (nextProviderToken !== null && nextProviderToken === pt) {
      return refusal(deps, 502, "upstream", requestId, headers, { action, userId, accountId, operationId: null });
    }
    let nextCursor: string | null = null;
    if (nextProviderToken) {
      nextCursor = await sealCursor(
        { o: userId, a: accountId, g: account.binding_generation, vi: "", l: "published", p: null, a2: "video_page", h: hop + 1, pt: nextProviderToken },
        { signingSecret: deps.signingSecret, now: deps.now(), ttlMs: CURSOR_TTL_MS },
      );
    }
    const payload: Stage4VideoPagePayload = {
      account_id: accountId,
      channel_id: account.platform_user_id,
      items,
      next_cursor: nextCursor,
    };
    return ok({ ok: true, request_id: requestId, data: payload }, headers);
  }

  // ---- youtube_thread_page ---------------------------------------------
  if (action === "youtube_thread_page") {
    const inp = input as Extract<Stage4Request, { action: "youtube_thread_page" }>;
    const requiresHeld = inp.list === "heldForReview";
    if (requiresHeld) {
      const blocked = await capabilityRefusal(deps.admin, accountId, "held");
      if (blocked) {
        return refusal(deps, blocked.status, blocked.reason, requestId, headers, { action, userId, accountId, operationId: null });
      }
    }
    // Verify video ownership.
    const tok = await prepareToken(account, deps);
    if (!tok.ok) {
      return refusal(deps, 401, tok.reason, requestId, headers, { action, userId, accountId, operationId: null });
    }
    const vres = await provider.readVideo({ fetcher: deps.fetcher }, tok.token, inp.video_id);
    if (vres.kind === "refused") {
      return refusal(deps, 403, vres.reason as Stage4Reason, requestId, headers, { action, userId, accountId, operationId: null, providerClass: "http_4xx" });
    }
    if (vres.kind === "indeterminate") {
      return refusal(deps, 502, "upstream", requestId, headers, { action, userId, accountId, operationId: null, providerClass: vres.providerClass });
    }
    const videoItem = ((vres.body as YtList<YtVideo>)?.items ?? [])[0];
    if (!videoItem || videoItem.id !== inp.video_id) {
      return refusal(deps, 404, "not_found_provider", requestId, headers, { action, userId, accountId, operationId: null });
    }
    if (videoItem?.snippet?.channelId !== account.platform_user_id) {
      return refusal(deps, 403, "video_not_owned", requestId, headers, { action, userId, accountId, operationId: null });
    }

    // Cursor.
    let pageToken: string | undefined;
    let hop = 0;
    if (inp.cursor) {
      const c = await unsealCursor(inp.cursor, { signingSecret: deps.signingSecret, now: deps.now() });
      if (!c || c.o !== userId || c.a !== accountId || c.g !== account.binding_generation || c.vi !== inp.video_id || c.l !== inp.list || c.a2 !== "thread_page") {
        return refusal(deps, 400, "invalid_handle", requestId, headers, { action, userId, accountId, operationId: null });
      }
      if (c.e < deps.now()) {
        return refusal(deps, 400, "expired_handle", requestId, headers, { action, userId, accountId, operationId: null });
      }
      hop = cursorHop(c);
      if (hop === 0) {
        return refusal(deps, 400, "invalid_handle", requestId, headers, { action, userId, accountId, operationId: null });
      }
      if (hop > MAX_CURSOR_HOPS) {
        return refusal(deps, 400, "expired_handle", requestId, headers, { action, userId, accountId, operationId: null });
      }
      pageToken = c.pt;
    }

    const res = await provider.listThreadsPage(
      { fetcher: deps.fetcher },
      { id: account.id, platform_user_id: account.platform_user_id, access_token: tok.token },
      tok.token,
      { videoId: inp.video_id, moderationStatus: inp.list === "heldForReview" ? "heldForReview" : "published", pageToken },
    );
    if (res.kind === "refused") {
      const reason = res.reason === "comments_disabled" ? "comments_disabled" : (res.reason as Stage4Reason);
      return refusal(deps, reason === "comments_disabled" ? 403 : 403, reason, requestId, headers, { action, userId, accountId, operationId: null, providerClass: "http_4xx" });
    }
    if (res.kind === "indeterminate") {
      return refusal(deps, 502, "upstream", requestId, headers, { action, userId, accountId, operationId: null, providerClass: res.providerClass });
    }

    // Seal rows.
    const threads = listItems<YtThread>(res.body);
    if (threads === null) {
      return refusal(deps, 502, "upstream", requestId, headers, { action, userId, accountId, operationId: null });
    }
    const rows: Stage4CommentRow[] = [];
    let inconsistent = 0;
    for (const th of threads) {
      const check = validateThreadChain(inp.video_id, th, account.platform_user_id, account.platform_user_id);
      if (!check.ok) { inconsistent++; continue; }
      const parsed = parseThreadRow(th, account, inp.video_id);
      if (!parsed) { inconsistent++; continue; }
      // thread row
      const topHandle = await sealRow(deps, account, inp.video_id, th, "thread", th?.snippet?.topLevelComment ?? th, parsed.threadRow.moderation_status, "", parsed.threadRow.author_channel_id);
      parsed.threadRow.handle = topHandle;
      rows.push(parsed.threadRow);
      // reply rows
      for (let i = 0; i < parsed.replyRows.length; i++) {
        const r = parsed.replyRows[i];
        const replyHandle = await sealRow(deps, account, inp.video_id, th, "reply", th?.replies?.comments?.[i], r.moderation_status, parsed.threadRow.comment_id, r.author_channel_id);
        r.handle = replyHandle;
        rows.push(r);
      }
    }

    const nextProviderToken = (res.body as YtList<unknown>)?.nextPageToken ? String((res.body as YtList<unknown>)?.nextPageToken) : null;
    // A provider that hands back the token it was just given can only loop: refuse
    // it now instead of sealing the same page again with a higher hop count.
    if (nextProviderToken !== null && nextProviderToken === pageToken) {
      return refusal(deps, 502, "upstream", requestId, headers, { action, userId, accountId, operationId: null });
    }
    let nextCursor: string | null = null;
    if (nextProviderToken) {
      nextCursor = await sealCursor(
        { o: userId, a: accountId, g: account.binding_generation, vi: inp.video_id, l: inp.list, p: null, a2: "thread_page", h: hop + 1, pt: nextProviderToken },
        { signingSecret: deps.signingSecret, now: deps.now(), ttlMs: CURSOR_TTL_MS },
      );
    }

    const payload: Stage4ThreadPagePayload = {
      account_id: accountId,
      channel_id: account.platform_user_id,
      binding_generation: account.binding_generation,
      video_id: inp.video_id,
      list: inp.list,
      items: rows,
      next_cursor: nextCursor,
      inconsistent_count: inconsistent,
    };
    return ok({ ok: true, request_id: requestId, data: payload }, headers);
  }

  // ---- youtube_reply_page ---------------------------------------------
  if (action === "youtube_reply_page") {
    const inp = input as Extract<Stage4Request, { action: "youtube_reply_page" }>;
    const verified = await verifyTargetHandle(inp.parent_handle, deps, account, userId);
    if (!verified.ok) {
      return refusal(deps, 400, verified.reason, requestId, headers, { action, userId, accountId, operationId: null });
    }
    const h = verified.payload;
    if (h.k !== "thread" && h.k !== "reply") {
      return refusal(deps, 400, "invalid_handle", requestId, headers, { action, userId, accountId, operationId: null });
    }
    const canonicalParent = h.p === "" ? h.co : h.p;
    const tok = await prepareToken(account, deps);
    if (!tok.ok) {
      return refusal(deps, 401, tok.reason, requestId, headers, { action, userId, accountId, operationId: null });
    }
    let pageToken: string | undefined;
    let hop = 0;
    if (inp.cursor) {
      const c = await unsealCursor(inp.cursor, { signingSecret: deps.signingSecret, now: deps.now() });
      if (!c || c.o !== userId || c.a !== accountId || c.g !== account.binding_generation || c.a2 !== "reply_page" || c.p !== canonicalParent) {
        return refusal(deps, 400, "invalid_handle", requestId, headers, { action, userId, accountId, operationId: null });
      }
      if (c.e < deps.now()) {
        return refusal(deps, 400, "expired_handle", requestId, headers, { action, userId, accountId, operationId: null });
      }
      hop = cursorHop(c);
      if (hop === 0) {
        return refusal(deps, 400, "invalid_handle", requestId, headers, { action, userId, accountId, operationId: null });
      }
      if (hop > MAX_CURSOR_HOPS) {
        return refusal(deps, 400, "expired_handle", requestId, headers, { action, userId, accountId, operationId: null });
      }
      pageToken = c.pt;
    }
    const res = await provider.listRepliesPage({ fetcher: deps.fetcher }, tok.token, { parentId: canonicalParent, pageToken });
    if (res.kind === "refused") {
      return refusal(deps, 403, res.reason as Stage4Reason, requestId, headers, { action, userId, accountId, operationId: null, providerClass: "http_4xx" });
    }
    if (res.kind === "indeterminate") {
      return refusal(deps, 502, "upstream", requestId, headers, { action, userId, accountId, operationId: null, providerClass: res.providerClass });
    }
    const items = listItems<YtComment>(res.body);
    if (items === null) {
      return refusal(deps, 502, "upstream", requestId, headers, { action, userId, accountId, operationId: null });
    }
    const rows: Stage4CommentRow[] = [];
    let inconsistent = 0;
    for (const r of items) {
      const parentId = r?.snippet?.parentId ? String(r.snippet.parentId) : null;
      if (parentId !== canonicalParent) { inconsistent++; continue; }
      const authorChannel = r?.snippet?.authorChannelId?.value ? String(r.snippet.authorChannelId.value) : null;
      if (r?.snippet?.channelId && r.snippet.channelId !== account.platform_user_id) { inconsistent++; continue; }
      if (r?.snippet?.videoId && r.snippet.videoId !== h.vi) { inconsistent++; continue; }
      const replyId = nonEmptyString(r?.id);
      if (!replyId) { inconsistent++; continue; }
      const row: Stage4CommentRow = {
        handle: "",
        kind: "reply",
        comment_id: replyId,
        thread_id: h.th,
        video_id: h.vi,
        canonical_parent_id: canonicalParent,
        author_channel_id: authorChannel,
        author_name: String(r?.snippet?.authorDisplayName ?? "Unknown"),
        author_avatar_url: r?.snippet?.authorProfileImageUrl ?? null,
        text: String(r?.snippet?.textOriginal ?? r?.snippet?.textDisplay ?? ""),
        published_at: String(r?.snippet?.publishedAt ?? new Date().toISOString()),
        like_count: Number(r?.snippet?.likeCount ?? 0),
        moderation_status: r?.snippet?.moderationStatus ? String(r.snippet.moderationStatus) : null,
        is_own: !!account.platform_user_id && authorChannel === account.platform_user_id,
      };
      const replyHandle = await sealHandle(
        { o: userId, a: accountId, g: account.binding_generation, c: account.platform_user_id, vi: h.vi, th: h.th, co: row.comment_id, k: "reply", p: canonicalParent, au: authorChannel ?? "", s: row.moderation_status },
        { signingSecret: deps.signingSecret, now: deps.now(), ttlMs: HANDLE_TTL_MS },
      );
      row.handle = replyHandle;
      rows.push(row);
    }
    const nextProviderToken = (res.body as YtList<unknown>)?.nextPageToken ? String((res.body as YtList<unknown>)?.nextPageToken) : null;
    // A provider that hands back the token it was just given can only loop: refuse
    // it now instead of sealing the same page again with a higher hop count.
    if (nextProviderToken !== null && nextProviderToken === pageToken) {
      return refusal(deps, 502, "upstream", requestId, headers, { action, userId, accountId, operationId: null });
    }
    let nextCursor: string | null = null;
    if (nextProviderToken) {
      nextCursor = await sealCursor(
        { o: userId, a: accountId, g: account.binding_generation, vi: h.vi, l: "published", p: canonicalParent, a2: "reply_page", h: hop + 1, pt: nextProviderToken },
        { signingSecret: deps.signingSecret, now: deps.now(), ttlMs: CURSOR_TTL_MS },
      );
    }
    const payload: Stage4ReplyPagePayload = {
      account_id: accountId,
      channel_id: account.platform_user_id,
      binding_generation: account.binding_generation,
      parent_handle: inp.parent_handle,
      items: rows,
      next_cursor: nextCursor,
      inconsistent_count: inconsistent,
    };
    return ok({ ok: true, request_id: requestId, data: payload }, headers);
  }

  // ---- youtube_create_thread -----------------------------------------
  if (action === "youtube_create_thread") {
    const inp = input as Extract<Stage4Request, { action: "youtube_create_thread" }>;
    const tok = await prepareToken(account, deps);
    if (!tok.ok) {
      return refusal(deps, 401, tok.reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    // Verify video ownership.
    const vres = await provider.readVideo({ fetcher: deps.fetcher }, tok.token, inp.video_id);
    if (vres.kind !== "success") {
      return refusal(deps, vres.kind === "refused" ? 403 : 502, vres.kind === "refused" ? (vres.reason as Stage4Reason) : "upstream", requestId, headers, { action, userId, accountId, operationId: inp.operation_id, providerClass: vres.kind === "refused" ? "http_4xx" : vres.providerClass });
    }
    const videoItem = ((vres.body as YtList<YtVideo>)?.items ?? [])[0];
    if (!videoItem || videoItem.id !== inp.video_id || videoItem?.snippet?.channelId !== account.platform_user_id) {
      return refusal(deps, 403, "video_not_owned", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    const digestKeys = await loadDigestKeys(deps.admin);
    if (!digestKeys) {
      return refusal(deps, 503, "upstream", requestId, headers, { action, userId, accountId, operationId: null });
    }
    const intent = await computeIntentDigests(digestKeys, {
      action: "create_thread",
      accountId: account.id,
      bindingGeneration: account.binding_generation,
      videoId: inp.video_id,
      targetIds: [],
      moderationStatus: null,
      banAuthor: false,
      text: inp.text,
    });
    const logical = await computeLogicalDigests(digestKeys, {
      channelId: account.platform_user_id,
      videoId: inp.video_id,
      canonicalParent: "",
      text: inp.text,
    });

    // Claim.
    const claim = await deps.admin.rpc("youtube_comment_op_claim", {
      p_owner_id: userId,
      p_account_id: accountId,
      p_expected_channel: account.platform_user_id,
      p_expected_generation: account.binding_generation,
      p_operation_id: inp.operation_id,
      p_action: "create_thread",
      p_targets: { video_id: inp.video_id },
      p_intent_digest: intent.digest,
      p_intent_digests: intent.digests,
      p_logical_digests: logical,
      p_capability: "write",
      p_request_id: requestId,
    });
    if (claim.error || !claim.data?.ok) {
      const reason = (claim.data?.reason ?? "upstream") as Stage4Reason;
      if (reason === "already_recorded") {
        return ok({ ok: true, request_id: requestId, data: recordedPayload(inp, claim.data, account, "create_thread") }, headers);
      }
      const status = reason === "upstream" ? 503 : reason === "possible_duplicate" || reason === "recently_posted" ? 409 : 400;
      return refusal(deps, status, reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    const attemptToken = claim.data.attempt_token;

    // Mark dispatched (the authorisation boundary).
    const mark = await deps.admin.rpc("youtube_comment_op_mark_dispatched", {
      p_owner_id: userId,
      p_operation_id: inp.operation_id,
      p_attempt_token: attemptToken,
      p_expected_channel: account.platform_user_id,
      p_expected_generation: account.binding_generation,
    });
    if (mark.error || !mark.data?.ok) {
      const reason = (mark.data?.reason ?? "upstream") as Stage4Reason;
      // The receipt is already refused by the mark; nothing was sent.
      return refusal(deps, 409, reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id, operationVerified: true });
    }

    // Exactly one HTTP request.
    const write = await provider.insertThread({ fetcher: deps.fetcher }, tok.token, {
      channelId: account.platform_user_id,
      videoId: inp.video_id,
      text: inp.text,
    });
    let outcome: "confirmed" | "refused" | "indeterminate" = "indeterminate";
    let providerClass: Stage4ProviderClass = "none";
    let reason: string | null = null;
    let resultThreadId: string | null = null;
    let resultCommentId: string | null = null;
    if (write.kind === "success") {
      // Spec 9.2: create is confirmed only by COMPLETE, matching evidence —
      // the thread id, the top-level comment id (its own field, never the
      // thread id standing in for it), and the request's video and channel.
      const body = write.body as YtWriteBody;
      // Evidence is a non-empty STRING id; a number, object or array is
      // malformed and is never coerced into one.
      const threadId = nonEmptyString(body?.id);
      const topId = nonEmptyString(body?.snippet?.topLevelComment?.id);
      const videoIdOk = body?.snippet?.videoId === inp.video_id;
      const channelOk = body?.snippet?.channelId === account.platform_user_id;
      if (threadId && topId && videoIdOk && channelOk) {
        outcome = "confirmed";
        resultThreadId = threadId;
        resultCommentId = topId;
      } else {
        outcome = "indeterminate";
        providerClass = "none";
      }
    } else if (write.kind === "refused") {
      outcome = "refused";
      providerClass = "http_4xx";
      reason = write.reason;
    } else {
      outcome = "indeterminate";
      providerClass = write.providerClass;
    }

    return await settleAndRespond(deps, {
      userId, accountId, account, action, receiptAction: "create_thread", operationId: inp.operation_id,
      attemptToken, requestId, headers, moderationStatus: null, banRequested: false,
    }, { outcome, reason, providerClass, resultThreadId, resultCommentId });
  }

  // ---- youtube_reply ---------------------------------------------------
  if (action === "youtube_reply") {
    const inp = input as Extract<Stage4Request, { action: "youtube_reply" }>;
    const verified = await verifyTargetHandle(inp.target_handle, deps, account, userId);
    if (!verified.ok) {
      return refusal(deps, 400, verified.reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    const h = verified.payload;
    const canonicalParent = h.p === "" ? h.co : h.p;
    // Verify target by fresh read.
    const tok = await prepareToken(account, deps);
    if (!tok.ok) {
      return refusal(deps, 401, tok.reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    const target = await verifyWriteTarget(deps, account, tok.token, h);
    if (!target.ok) {
      return refusal(deps, target.status, target.reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id, providerClass: target.providerClass });
    }

    const digestKeys = await loadDigestKeys(deps.admin);
    if (!digestKeys) {
      return refusal(deps, 503, "upstream", requestId, headers, { action, userId, accountId, operationId: null });
    }
    const intent = await computeIntentDigests(digestKeys, {
      action: "reply",
      accountId: account.id,
      bindingGeneration: account.binding_generation,
      videoId: h.vi,
      targetIds: [h.co],
      moderationStatus: null,
      banAuthor: false,
      text: inp.text,
    });
    const logical = await computeLogicalDigests(digestKeys, {
      channelId: account.platform_user_id,
      videoId: h.vi,
      canonicalParent,
      text: inp.text,
    });

    const claim = await deps.admin.rpc("youtube_comment_op_claim", {
      p_owner_id: userId,
      p_account_id: accountId,
      p_expected_channel: account.platform_user_id,
      p_expected_generation: account.binding_generation,
      p_operation_id: inp.operation_id,
      p_action: "reply",
      p_targets: { video_id: h.vi, parent_comment_id: canonicalParent },
      p_intent_digest: intent.digest,
      p_intent_digests: intent.digests,
      p_logical_digests: logical,
      p_capability: "write",
      p_request_id: requestId,
    });
    if (claim.error || !claim.data?.ok) {
      const reason = (claim.data?.reason ?? "upstream") as Stage4Reason;
      if (reason === "already_recorded") {
        return ok({ ok: true, request_id: requestId, data: recordedPayload(inp, claim.data, account, "reply") }, headers);
      }
      const status = reason === "upstream" ? 503 : reason === "possible_duplicate" || reason === "recently_posted" ? 409 : 400;
      return refusal(deps, status, reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    const attemptToken = claim.data.attempt_token;

    const mark = await deps.admin.rpc("youtube_comment_op_mark_dispatched", {
      p_owner_id: userId,
      p_operation_id: inp.operation_id,
      p_attempt_token: attemptToken,
      p_expected_channel: account.platform_user_id,
      p_expected_generation: account.binding_generation,
    });
    if (mark.error || !mark.data?.ok) {
      const reason = (mark.data?.reason ?? "upstream") as Stage4Reason;
      return refusal(deps, 409, reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id, operationVerified: true });
    }

    const write = await provider.insertReply({ fetcher: deps.fetcher }, tok.token, {
      parentId: canonicalParent,
      text: inp.text,
    });
    let outcome: "confirmed" | "refused" | "indeterminate" = "indeterminate";
    let providerClass: Stage4ProviderClass = "none";
    let reason2: string | null = null;
    let resultCommentId: string | null = null;
    if (write.kind === "success") {
      const body = write.body as YtWriteBody;
      const id = nonEmptyString(body?.id);
      // Spec 9.2: reply evidence is the comment id AND a parentId equal to the
      // canonical parent; a missing parentId is incomplete, not a pass.
      const parentOk = body?.snippet?.parentId === canonicalParent;
      if (id && parentOk) {
        outcome = "confirmed";
        resultCommentId = id;
      }
    } else if (write.kind === "refused") {
      outcome = "refused";
      providerClass = "http_4xx";
      reason2 = write.reason;
    } else {
      outcome = "indeterminate";
      providerClass = write.providerClass;
    }

    return await settleAndRespond(deps, {
      userId, accountId, account, action, receiptAction: "reply", operationId: inp.operation_id,
      attemptToken, requestId, headers, moderationStatus: null, banRequested: false,
    }, { outcome, reason: reason2, providerClass, resultThreadId: null, resultCommentId });
  }

  // ---- youtube_edit_comment -------------------------------------------
  if (action === "youtube_edit_comment") {
    const inp = input as Extract<Stage4Request, { action: "youtube_edit_comment" }>;
    const verified = await verifyTargetHandle(inp.target_handle, deps, account, userId);
    if (!verified.ok) {
      return refusal(deps, 400, verified.reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    const h = verified.payload;
    if (h.k !== "thread" && h.k !== "reply") {
      return refusal(deps, 400, "invalid_handle", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    const authorChannel = h.au;
    if (!authorChannel || authorChannel !== account.platform_user_id) {
      return refusal(deps, 403, "target_not_owned", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    const tok = await prepareToken(account, deps);
    if (!tok.ok) {
      return refusal(deps, 401, tok.reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    // Fresh target read, through the one shared validator.
    const target = await verifyWriteTarget(deps, account, tok.token, h);
    if (!target.ok) {
      return refusal(deps, target.status, target.reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id, providerClass: target.providerClass });
    }
    const citem = target.citem;
    const author = citem?.snippet?.authorChannelId?.value ? String(citem.snippet.authorChannelId.value) : null;
    if (!author || author !== account.platform_user_id) {
      return refusal(deps, 403, "target_not_owned", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }

    // Claim (edit has no logical fence).
    const digestKeys = await loadDigestKeys(deps.admin);
    if (!digestKeys) {
      return refusal(deps, 503, "upstream", requestId, headers, { action, userId, accountId, operationId: null });
    }
    const intent = await computeIntentDigests(digestKeys, {
      action: "edit",
      accountId: account.id,
      bindingGeneration: account.binding_generation,
      videoId: h.vi,
      targetIds: [h.co],
      moderationStatus: null,
      banAuthor: false,
      text: inp.text,
    });
    const claim = await deps.admin.rpc("youtube_comment_op_claim", {
      p_owner_id: userId,
      p_account_id: accountId,
      p_expected_channel: account.platform_user_id,
      p_expected_generation: account.binding_generation,
      p_operation_id: inp.operation_id,
      p_action: "edit",
      p_targets: { video_id: h.vi, comment_id: h.co },
      p_intent_digest: intent.digest,
      p_intent_digests: intent.digests,
      p_logical_digests: {},
      p_capability: "write",
      p_request_id: requestId,
    });
    if (claim.error || !claim.data?.ok) {
      const reason = (claim.data?.reason ?? "upstream") as Stage4Reason;
      if (reason === "already_recorded") {
        return ok({ ok: true, request_id: requestId, data: recordedPayload(inp, claim.data, account, "edit") }, headers);
      }
      return refusal(deps, reason === "upstream" ? 503 : 409, reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    const attemptToken = claim.data.attempt_token;

    const mark = await deps.admin.rpc("youtube_comment_op_mark_dispatched", {
      p_owner_id: userId,
      p_operation_id: inp.operation_id,
      p_attempt_token: attemptToken,
      p_expected_channel: account.platform_user_id,
      p_expected_generation: account.binding_generation,
    });
    if (mark.error || !mark.data?.ok) {
      const reason = (mark.data?.reason ?? "upstream") as Stage4Reason;
      return refusal(deps, 409, reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id, operationVerified: true });
    }

    const write = await provider.updateComment({ fetcher: deps.fetcher }, tok.token, { commentId: h.co, text: inp.text });
    let outcome: "confirmed" | "refused" | "indeterminate" = "indeterminate";
    let providerClass: Stage4ProviderClass = "none";
    let reason2: string | null = null;
    if (write.kind === "success") {
      const body = write.body as YtWriteBody;
      if (nonEmptyString(body?.id) === h.co) {
        outcome = "confirmed";
      }
    } else if (write.kind === "refused") {
      outcome = "refused";
      providerClass = "http_4xx";
      reason2 = write.reason;
    } else {
      outcome = "indeterminate";
      providerClass = write.providerClass;
    }

    return await settleAndRespond(deps, {
      userId, accountId, account, action, receiptAction: "edit", operationId: inp.operation_id,
      attemptToken, requestId, headers, moderationStatus: null, banRequested: false,
    }, { outcome, reason: reason2, providerClass, resultThreadId: null, resultCommentId: h.co });
  }

  // ---- youtube_ban_confirmation --------------------------------------
  if (action === "youtube_ban_confirmation") {
    const inp = input as Extract<Stage4Request, { action: "youtube_ban_confirmation" }>;
    const verified = await verifyTargetHandle(inp.target_handle, deps, account, userId);
    if (!verified.ok) {
      return refusal(deps, 400, verified.reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    const h = verified.payload;
    // Re-verify account capability for ban.
    const blocked = await capabilityRefusal(deps.admin, accountId, "ban");
    if (blocked) {
      return refusal(deps, blocked.status, blocked.reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    // Fresh target read.
    const tok = await prepareToken(account, deps);
    if (!tok.ok) {
      return refusal(deps, 401, tok.reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    const target = await verifyWriteTarget(deps, account, tok.token, h);
    if (!target.ok) {
      return refusal(deps, target.status, target.reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id, providerClass: target.providerClass });
    }
    const citem = target.citem;
    const author = citem?.snippet?.authorChannelId?.value ? String(citem.snippet.authorChannelId.value) : null;
    if (!author || author === "" || author === account.platform_user_id) {
      return refusal(deps, 400, "target_missing_author", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    const authorName = String(citem?.snippet?.authorDisplayName ?? "Unknown");
    const confirmation = await sealBanConfirmation(
      { o: userId, a: accountId, g: account.binding_generation, vi: h.vi, co: h.co, au: author, op: inp.operation_id },
      { signingSecret: deps.signingSecret, now: deps.now(), ttlMs: BAN_CONFIRMATION_TTL_MS },
    );
    const payload: Stage4BanConfirmationPayload = {
      confirmation,
      expires_in_seconds: 120,
      author_channel_id: author,
      author_name: authorName,
    };
    return ok({ ok: true, request_id: requestId, data: payload }, headers);
  }

  // ---- youtube_moderate_comment --------------------------------------
  if (action === "youtube_moderate_comment") {
    const inp = input as Extract<Stage4Request, { action: "youtube_moderate_comment" }>;
    // A ban confirmation belongs to a Reject and to nothing else: the
    // combination is malformed and is refused before any account or provider work.
    if (inp.ban_confirmation && inp.status !== "rejected") {
      return refusal(deps, 400, "invalid_request", requestId, headers, { action, userId, accountId, operationId: null });
    }
    const verified = await verifyTargetHandle(inp.target_handle, deps, account, userId);
    if (!verified.ok) {
      return refusal(deps, 400, verified.reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    const h = verified.payload;
    // Ban token verification (only when present).
    let banAuthor = false;
    let banAuthorToken: { au: string } | null = null;
    if (inp.ban_confirmation) {
      const bnc = await unsealBanConfirmation(inp.ban_confirmation, { signingSecret: deps.signingSecret, now: deps.now() });
      if (!bnc) {
        return refusal(deps, 400, "ban_confirmation_invalid", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
      }
      if (bnc.e < deps.now()) {
        return refusal(deps, 400, "ban_confirmation_expired", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
      }
      if (bnc.o !== userId || bnc.a !== accountId || bnc.g !== account.binding_generation || bnc.vi !== h.vi || bnc.co !== h.co || bnc.op !== inp.operation_id) {
        return refusal(deps, 400, "ban_confirmation_mismatch", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
      }
      // The ban capability is checked BEFORE any provider read, and again at
      // claim and at mark_dispatched in SQL (the receipt carries ban_author).
      const blocked = await capabilityRefusal(deps.admin, accountId, "ban");
      if (blocked) {
        return refusal(deps, blocked.status, blocked.reason, requestId, headers, { action, userId, accountId, operationId: null });
      }
      banAuthorToken = bnc;
      banAuthor = true;
    } else if (inp.status === "rejected") {
      // Plain reject: no ban. `banAuthor` stays false, so the provider call
      // omits the key entirely (spec 10.2 point 5).
    }

    const tok = await prepareToken(account, deps);
    if (!tok.ok) {
      return refusal(deps, 401, tok.reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    // ONE last target read for every path, the ban author match included: the
    // author compared with the token is the author of the very read that
    // authorises the write, not of a separate earlier read.
    const target = await verifyWriteTarget(deps, account, tok.token, h);
    if (!target.ok) {
      return refusal(deps, target.status, target.reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id, providerClass: target.providerClass });
    }
    const citem = target.citem;
    if (banAuthorToken) {
      const author = citem?.snippet?.authorChannelId?.value ? String(citem.snippet.authorChannelId.value) : null;
      if (!author || author !== banAuthorToken.au || author === account.platform_user_id) {
        return refusal(deps, 400, "ban_confirmation_mismatch", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
      }
    }

    const digestKeys = await loadDigestKeys(deps.admin);
    if (!digestKeys) {
      return refusal(deps, 503, "upstream", requestId, headers, { action, userId, accountId, operationId: null });
    }
    const intent = await computeIntentDigests(digestKeys, {
      action: "moderate",
      accountId: account.id,
      bindingGeneration: account.binding_generation,
      videoId: h.vi,
      targetIds: [h.co],
      moderationStatus: inp.status,
      banAuthor,
      text: inp.status,
    });

    const claim = await deps.admin.rpc("youtube_comment_op_claim", {
      p_owner_id: userId,
      p_account_id: accountId,
      p_expected_channel: account.platform_user_id,
      p_expected_generation: account.binding_generation,
      p_operation_id: inp.operation_id,
      p_action: "moderate",
      p_targets: {
        video_id: h.vi,
        comment_id: h.co,
        moderation_status: inp.status,
        ban_author: banAuthor,
        author_channel_id: citem?.snippet?.authorChannelId?.value ? String(citem.snippet.authorChannelId.value) : null,
      },
      p_intent_digest: intent.digest,
      p_intent_digests: intent.digests,
      p_logical_digests: {},
      p_capability: banAuthor ? "ban" : "write",
      p_request_id: requestId,
    });
    if (claim.error || !claim.data?.ok) {
      const reason = (claim.data?.reason ?? "upstream") as Stage4Reason;
      if (reason === "already_recorded") {
        const recorded = recordedPayload(inp, claim.data, account, "moderate");
        return ok({
          ok: true,
          request_id: requestId,
          data: { ...recorded, moderation_status: inp.status, ban_requested: banAuthor },
        }, headers);
      }
      return refusal(deps, reason === "upstream" ? 503 : 409, reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    const attemptToken = claim.data.attempt_token;

    const mark = await deps.admin.rpc("youtube_comment_op_mark_dispatched", {
      p_owner_id: userId,
      p_operation_id: inp.operation_id,
      p_attempt_token: attemptToken,
      p_expected_channel: account.platform_user_id,
      p_expected_generation: account.binding_generation,
    });
    if (mark.error || !mark.data?.ok) {
      const reason = (mark.data?.reason ?? "upstream") as Stage4Reason;
      return refusal(deps, 409, reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id, operationVerified: true });
    }

    const write = await provider.setModerationStatus({ fetcher: deps.fetcher }, tok.token, {
      commentId: h.co,
      status: inp.status,
      banAuthor,
    });
    let outcome: "confirmed" | "refused" | "indeterminate" = "indeterminate";
    let providerClass: Stage4ProviderClass = "none";
    let reason2: string | null = null;
    if (write.kind === "success") {
      // Moderation: only 204 is acceptance.
      if (write.status === 204) {
        outcome = "confirmed";
      } else {
        outcome = "indeterminate";
        providerClass = "none";
      }
    } else if (write.kind === "refused") {
      outcome = "refused";
      providerClass = "http_4xx";
      reason2 = write.reason;
    } else {
      outcome = "indeterminate";
      providerClass = write.providerClass;
    }

    return await settleAndRespond(deps, {
      userId, accountId, account, action, receiptAction: "moderate", operationId: inp.operation_id,
      attemptToken, requestId, headers, moderationStatus: inp.status, banRequested: banAuthor,
    }, { outcome, reason: reason2, providerClass, resultThreadId: null, resultCommentId: h.co });
  }

  // ---- youtube_operation_status --------------------------------------
  if (action === "youtube_operation_status") {
    const inp = input as Extract<Stage4Request, { action: "youtube_operation_status" }>;
    const { data, error } = await deps.admin.rpc("youtube_comment_op_status", {
      p_owner_id: userId,
      p_account_id: accountId,
      p_operation_id: inp.operation_id,
    });
    if (error || !data) {
      // The read itself failed: that is a temporary condition, NOT "no
      // receipt". Answering not_found here would tell the browser to drop the
      // identity of an operation whose outcome is merely unread.
      return refusal(deps, 503, "upstream", requestId, headers, { action, userId, accountId, operationId: null });
    }
    if (!data.ok) {
      const reason = (data.reason ?? "not_found") as Stage4Reason;
      return refusal(deps, 404, reason, requestId, headers, { action, userId, accountId, operationId: null });
    }
    // Edit observation (read-only, only with read capability). The requested
    // text comes from the caller's draft when it still has one; the receipt
    // never stores text, so without a draft the observation is unavailable.
    let observation: Stage4OperationStatusPayload["observation"] = null;
    let observedText: string | null = null;
    // The comment the edit was aimed at: the result id when settlement recorded
    // one, otherwise the receipt's claimed target (an edit whose settlement
    // failed has no result id). The two stay separate fields on the receipt.
    const observedTargetId = data.result_comment_id ?? data.target_comment_id;
    if (data.action === "edit" && observedTargetId) {
      // The account snapshot was read before the status call. A reconnect, a
      // disconnect or an account delete in between must not let any field of
      // the old receipt cross it, so the binding is re-read FIRST, ahead of
      // the capability question (a read capability that answers false must not
      // skip this check), and again after every step that can take time: the
      // credential preparation and the provider read. A failed read is
      // temporary (503); a missing account or a changed binding is the same
      // not_found as everywhere else, with no payload.
      const bindingCheck = async (): Promise<
        { ok: true; account: AccountRow } | { ok: false; response: Response }
      > => {
        const fresh = await readAccount(deps.admin, accountId, userId);
        if (fresh.kind === "failed") {
          return { ok: false, response: await refusal(deps, 503, "upstream", requestId, headers, { action, userId, accountId, operationId: null }) };
        }
        if (fresh.kind === "absent" || fresh.account.binding_generation !== data.binding_generation) {
          return { ok: false, response: await refusal(deps, 404, "not_found", requestId, headers, { action, userId, accountId, operationId: null }) };
        }
        return { ok: true, account: fresh.account };
      };
      const first = await bindingCheck();
      if (!first.ok) return first.response;
      // Without a draft there is nothing to compare: the receipt is returned at
      // once, with no settings read and no provider read (the draft never
      // survives a reload, so this is the common recovery path).
      if (inp.text === undefined) {
        observation = "unavailable";
      } else {
        const unreadable = () => refusal(deps, 503, "upstream", requestId, headers, { action, userId, accountId, operationId: null });
        const blocked = await capabilityRefusal(deps.admin, accountId, "read");
        if (blocked?.status === 503) return unreadable();
        if (blocked) {
          // The capability answered false. It may be false BECAUSE of a
          // reconnect, so the binding is read again before the receipt goes out.
          const afterGate = await bindingCheck();
          if (!afterGate.ok) return afterGate.response;
          observation = "unavailable";
        } else {
          const tok = await prepareToken(first.account, deps);
          // `read` is checked again right before the provider read: a
          // withdrawal while the credential was being prepared must stop it.
          const stillAllowed = await capabilityRefusal(deps.admin, accountId, "read");
          if (stillAllowed?.status === 503) return unreadable();
          // After EVERY credential preparation, a failed one included.
          const afterToken = await bindingCheck();
          if (!afterToken.ok) return afterToken.response;
          if (tok.ok && !stillAllowed) {
            const cres = await provider.readComment({ fetcher: deps.fetcher }, tok.token, String(observedTargetId));
            const afterRead = await bindingCheck();
            if (!afterRead.ok) return afterRead.response;
            const citem = cres.kind === "success" ? ((cres.body as YtList<YtComment>)?.items ?? [])[0] : null;
            // Only the comment the receipt targets is an observation: a provider
            // answer for any other id says nothing about this edit.
            const text = citem && String(citem.id ?? "") === String(observedTargetId) && citem.snippet?.textOriginal
              ? String(citem.snippet.textOriginal)
              : null;
            if (text === null) {
              observation = "unavailable";
            } else {
              observedText = text;
              observation = normaliseText(text) === normaliseText(inp.text)
                ? "requested_text_observed"
                : "different_text_observed";
            }
          } else {
            observation = "unavailable";
          }
        }
      }
    }
    const payload: Stage4OperationStatusPayload = {
      operation_id: data.operation_id,
      action: data.action,
      state: data.state,
      reason: data.reason,
      provider_class: data.provider_class,
      moderation_status: data.moderation_status,
      ban_requested: data.ban_requested === true,
      result_thread_id: data.result_thread_id,
      result_comment_id: data.result_comment_id,
      binding_generation: data.binding_generation,
      channel_id: data.channel_id,
      observation,
      observed_text: observedText,
    };
    return ok({ ok: true, request_id: requestId, data: payload }, headers);
  }

  // Should never reach here (discriminated union covers all actions).
  return refusal(deps, 400, "invalid_request", requestId, headers, { action, userId, accountId, operationId: null });
}
