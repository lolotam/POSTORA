import { createLogger } from "../_shared/logging.ts";
import { sanitizeErrorMessage } from "../_shared/errorSanitizer.ts";
import {
  evaluateTikTokPublishPolicy,
  type PolicyViolation,
  type TikTokReviewSettings,
} from "../_shared/tiktokPublishPolicy.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import {
  applyPendingWebhookEvents,
  applyTikTokPublishOutcome,
} from "../_shared/tiktokPublishOutcome.ts";
import { mapDatabaseError, ReviewError } from "./errors.ts";
import {
  mapPublishStatus,
  type PlatformPostSnapshot,
  type PostSnapshot,
  type SubmissionSnapshot,
} from "./status.ts";
import { fetchBounded, fetchPublishStatus, queryCreatorInfo } from "./tiktokApi.ts";
import { InvalidReviewRequest, parseReviewRequest, type ReviewRequest } from "./validation.ts";

type Row = Record<string, unknown>;

export interface DbResult {
  data: unknown;
  error: unknown;
}

/** Narrow query port so tests can fake PostgREST without the SDK. */
export interface Query extends PromiseLike<DbResult> {
  select(columns: string): Query;
  eq(column: string, value: unknown): Query;
  is(column: string, value: null): Query;
  in(column: string, values: readonly string[]): Query;
  order(column: string, options: { ascending: boolean }): Query;
  limit(count: number): Query;
  update(values: Row): Query;
  maybeSingle(): Promise<DbResult>;
}

export interface AdminClient {
  from(table: string): Query;
  rpc(name: string, params: Row): Promise<DbResult>;
}

export interface LogEvent {
  event: string;
  action: string;
  code: string;
  user_id: string | null;
  draft_id: string | null;
  submission_id: string | null;
  level: "warn" | "error";
}

export interface Dependencies {
  anonClient(authorization: string): {
    auth: {
      getUser(): PromiseLike<{ data: { user: { id: string } | null }; error: unknown }>;
    };
  };
  admin: AdminClient;
  serviceRoleKey: string;
  supabaseUrl: string;
  fetch: typeof fetch;
  now(): number;
  edgeRuntime?: { waitUntil(promise: Promise<unknown>): void };
  log(event: LogEvent): void | Promise<void>;
}

export interface Result {
  status: number;
  body: {
    ok: boolean;
    code?: string;
    message?: string;
    details?: unknown;
    data?: unknown;
  };
}

type ReviewState = "pending_review" | "rejected" | "archived" | "submitted";

type SubmissionSummary = {
  id: string;
  postId: string;
  mode: "now" | "scheduled";
  scheduledAt: string | null;
};

export type ReviewDraft = {
  id: string;
  accountId: string;
  revision: number;
  state: ReviewState;
  caption: string;
  mediaFileId: string | null;
  mediaDurationSec: number | null;
  settings: TikTokReviewSettings;
  rejectionReason: string | null;
  updatedAt: string;
  submission: SubmissionSummary | null;
};

type OwnedAccount = {
  accessToken: string | null;
  platformUserId: string | null;
  platformUsername: string | null;
  avatarUrl: string | null;
};

type StoredSubmission = SubmissionSnapshot & {
  id: string;
  postId: string;
  socialAccountId: string;
  providerPublishId: string | null;
  lastStatusCheckAt: string | null;
};

const DRAFT_COLUMNS =
  "id, social_account_id, revision, state, caption, media_file_id, media_duration_sec, settings, rejection_reason, updated_at";
const ACCOUNT_COLUMNS =
  "id, platform_user_id, platform_username, access_token, account_metadata, avatar_url";
const STATUS_REFRESH_MS = 15_000;
const PROCESS_POST_TIMEOUT_MS = 150_000;
const ACTIONS = [
  "creator_info",
  "list",
  "get",
  "create",
  "save",
  "reject",
  "archive",
  "restore",
  "submit",
  "status",
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function success(data: unknown): Result {
  return { status: 200, body: { ok: true, data } };
}

function failure(status: number, code: string, message: string, details?: unknown): Result {
  return {
    status,
    body: {
      ok: false,
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

function readFailed(error: unknown): ReviewError {
  return new ReviewError(500, "INTERNAL", sanitizeErrorMessage(error));
}

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRow(value: unknown): Row {
  if (!isRow(value)) throw readFailed(new Error("Expected a row."));
  return value;
}

function unwrapRpc(data: unknown): Row {
  const value = Array.isArray(data) ? data[0] : data;
  return requireRow(value);
}

async function safeLog(deps: Dependencies, event: LogEvent): Promise<void> {
  try {
    await deps.log(event);
  } catch {
    console.error("tiktok-review log failed");
  }
}

export function createReviewLog(admin: unknown): Dependencies["log"] {
  const logger = createLogger(admin, "tiktok-review", "edge");
  return (event) => {
    const metadata = {
      event: event.event,
      action: event.action,
      code: event.code,
      draft_id: event.draft_id,
      submission_id: event.submission_id,
    };
    const userId = event.user_id ?? undefined;
    if (event.level === "error") return logger.error(event.event, metadata, userId);
    return logger.warn(event.event, metadata, userId);
  };
}

/**
 * The service-role client satisfies `SupabaseClient` at the index seam.
 * Tests pass a fake `AdminClient`; the cast stays here so the outcome module
 * keeps the signature slice S3 publishes.
 */
function asServiceRole(admin: AdminClient): SupabaseClient {
  return admin as unknown as SupabaseClient;
}

function uuidOrNull(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

function peekLogIds(body: unknown): { action: string; draftId: string | null; submissionId: string | null } {
  if (!isRow(body)) return { action: "unknown", draftId: null, submissionId: null };
  const action = typeof body.action === "string" && ACTIONS.includes(body.action) ? body.action : "unknown";
  return {
    action,
    draftId: uuidOrNull(body.draftId),
    submissionId: uuidOrNull(body.submissionId),
  };
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  throw readFailed(new Error("Expected text."));
}

function readRevision(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
  throw readFailed(new Error("Expected a revision."));
}

function readColumnDuration(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw readFailed(new Error("Expected a duration."));
}

function positiveDuration(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

const SETTING_FLAGS = [
  "allowComment",
  "allowDuet",
  "allowStitch",
  "disclose",
  "yourBrand",
  "brandedContent",
  "aiGenerated",
] as const;

function readSettings(value: unknown): TikTokReviewSettings {
  if (!isRow(value)) throw readFailed(new Error("Expected settings."));
  const privacy = value.privacy;
  if (privacy !== null && privacy !== undefined && typeof privacy !== "string") {
    throw readFailed(new Error("Expected privacy."));
  }
  const flags: Record<(typeof SETTING_FLAGS)[number], boolean> = {
    allowComment: false,
    allowDuet: false,
    allowStitch: false,
    disclose: false,
    yourBrand: false,
    brandedContent: false,
    aiGenerated: false,
  };
  for (const key of SETTING_FLAGS) {
    const flag = value[key];
    if (flag === undefined) continue;
    if (typeof flag !== "boolean") throw readFailed(new Error("Expected a setting flag."));
    flags[key] = flag;
  }
  return {
    privacy: typeof privacy === "string" ? privacy : null,
    ...flags,
  };
}

function readState(value: unknown): ReviewState {
  if (
    value === "pending_review" || value === "rejected" || value === "archived" || value === "submitted"
  ) {
    return value;
  }
  throw readFailed(new Error("Expected a review state."));
}

function mapDraftRow(row: Row): ReviewDraft {
  const id = readString(row.id);
  const accountId = readString(row.social_account_id);
  const caption = readString(row.caption);
  const updatedAt = readString(row.updated_at);
  const mediaFileId = readNullableString(row.media_file_id);
  const rejectionReason = readNullableString(row.rejection_reason);
  if (!id || !accountId || caption === null || !updatedAt) {
    throw readFailed(new Error("Draft row is incomplete."));
  }
  return {
    id,
    accountId,
    revision: readRevision(row.revision),
    state: readState(row.state),
    caption,
    mediaFileId,
    mediaDurationSec: readColumnDuration(row.media_duration_sec),
    settings: readSettings(row.settings),
    rejectionReason,
    updatedAt,
    submission: null,
  };
}

function mapSubmissionSummary(row: Row): { draftId: string; summary: SubmissionSummary } {
  const draftId = readString(row.draft_id);
  const id = readString(row.id);
  const postId = readString(row.post_id);
  const mode = row.mode;
  if (!draftId || !id || !postId || (mode !== "now" && mode !== "scheduled")) {
    throw readFailed(new Error("Submission row is incomplete."));
  }
  return {
    draftId,
    summary: {
      id,
      postId,
      mode,
      scheduledAt: readNullableString(row.scheduled_at),
    },
  };
}

async function assertRead(result: DbResult): Promise<void> {
  if (result.error) throw readFailed(result.error);
}

async function loadDraftRow(admin: AdminClient, userId: string, draftId: string): Promise<ReviewDraft> {
  const result = await admin.from("tiktok_review_drafts")
    .select(DRAFT_COLUMNS)
    .eq("id", draftId)
    .eq("user_id", userId)
    .maybeSingle();
  await assertRead(result);
  if (!isRow(result.data)) {
    throw new ReviewError(404, "NOT_FOUND", "That draft could not be found.");
  }
  return mapDraftRow(result.data);
}

async function attachSubmissions(
  admin: AdminClient,
  userId: string,
  drafts: ReviewDraft[],
): Promise<ReviewDraft[]> {
  const submittedIds = drafts.filter((draft) => draft.state === "submitted").map((draft) => draft.id);
  if (submittedIds.length === 0) return drafts;
  const result = await admin.from("tiktok_review_submissions")
    .select("id, draft_id, post_id, mode, scheduled_at, created_at")
    .eq("user_id", userId)
    .in("draft_id", submittedIds)
    .order("created_at", { ascending: false });
  await assertRead(result);
  if (!Array.isArray(result.data)) throw readFailed(new Error("Submission list missing."));
  const latest = new Map<string, SubmissionSummary>();
  for (const value of result.data) {
    const mapped = mapSubmissionSummary(requireRow(value));
    if (!latest.has(mapped.draftId)) latest.set(mapped.draftId, mapped.summary);
  }
  return drafts.map((draft) => {
    if (draft.state !== "submitted") return draft;
    return { ...draft, submission: latest.get(draft.id) ?? null };
  });
}

async function loadDraft(admin: AdminClient, userId: string, draftId: string): Promise<ReviewDraft> {
  const draft = await loadDraftRow(admin, userId, draftId);
  const [withSubmission] = await attachSubmissions(admin, userId, [draft]);
  return withSubmission;
}

async function findAccount(
  admin: AdminClient,
  userId: string,
  accountId: string,
): Promise<OwnedAccount | null> {
  const result = await admin.from("social_accounts")
    .select(ACCOUNT_COLUMNS)
    .eq("id", accountId)
    .eq("user_id", userId)
    .eq("platform", "tiktok")
    .eq("is_active", true)
    .maybeSingle();
  await assertRead(result);
  if (!isRow(result.data)) return null;
  const token = result.data.access_token;
  return {
    accessToken: typeof token === "string" && token.length > 0 ? token : null,
    platformUserId: typeof result.data.platform_user_id === "string" ? result.data.platform_user_id : null,
    platformUsername: typeof result.data.platform_username === "string" ? result.data.platform_username : null,
    avatarUrl: typeof result.data.avatar_url === "string" ? result.data.avatar_url : null,
  };
}

async function requireAccount(
  deps: Dependencies,
  userId: string,
  accountId: string,
): Promise<OwnedAccount & { accessToken: string }> {
  const account = await findAccount(deps.admin, userId, accountId);
  if (!account) {
    throw new ReviewError(404, "ACCOUNT_NOT_FOUND", "That TikTok account isn't connected.");
  }
  if (!account.accessToken) {
    throw new ReviewError(422, "TOKEN_INVALID", "Reconnect your TikTok account.");
  }
  return { ...account, accessToken: account.accessToken };
}

async function creatorLookup(deps: Dependencies, userId: string, accountId: string) {
  const account = await requireAccount(deps, userId, accountId);
  const lookup = await queryCreatorInfo(
    deps.fetch,
    account.accessToken,
    account.platformUsername,
    account.avatarUrl,
  );
  if (lookup.kind === "token_invalid") {
    throw new ReviewError(422, "TOKEN_INVALID", "Reconnect your TikTok account.");
  }
  if (lookup.kind === "unavailable") {
    throw new ReviewError(502, "PROVIDER_UNAVAILABLE", "TikTok is unavailable right now. Try again shortly.");
  }
  return lookup;
}

async function callRpc(admin: AdminClient, name: string, params: Row): Promise<unknown> {
  const { data, error } = await admin.rpc(name, params);
  if (error) throw mapDatabaseError(error);
  return data;
}

async function draftFromRpc(admin: AdminClient, userId: string, data: unknown): Promise<ReviewDraft> {
  const draft = mapDraftRow(unwrapRpc(data));
  const [withSubmission] = await attachSubmissions(admin, userId, [draft]);
  return withSubmission;
}

function policyRefusal(violations: PolicyViolation[]): ReviewError {
  const first = violations[0];
  if (!first) return readFailed(new Error("Policy returned no violation."));
  return new ReviewError(422, `POLICY_${first.code}`, first.message, violations);
}

async function mediaDuration(
  admin: AdminClient,
  userId: string,
  draft: ReviewDraft,
): Promise<number | null> {
  if (!draft.mediaFileId) return draft.mediaDurationSec;
  const result = await admin.from("media_files")
    .select("metadata")
    .eq("id", draft.mediaFileId)
    .eq("user_id", userId)
    .maybeSingle();
  await assertRead(result);
  if (!isRow(result.data)) return draft.mediaDurationSec;
  const metadata = isRow(result.data.metadata) ? result.data.metadata : null;
  const fromFile = metadata ? positiveDuration(metadata.duration) : null;
  return fromFile ?? draft.mediaDurationSec;
}

async function assertOwnedMedia(admin: AdminClient, userId: string, mediaFileId: string): Promise<void> {
  const result = await admin.from("media_files")
    .select("id")
    .eq("id", mediaFileId)
    .eq("user_id", userId)
    .maybeSingle();
  await assertRead(result);
  if (!isRow(result.data)) {
    throw new ReviewError(422, "MEDIA_NOT_OWNED", "Choose a video from your library.");
  }
}

async function setDispatchState(
  admin: AdminClient,
  submissionId: string,
  from: string[],
  to: string,
): Promise<boolean> {
  const { data, error } = await admin.rpc("tiktok_review_set_dispatch_state", {
    p_submission_id: submissionId,
    p_from: from,
    p_to: to,
  });
  if (error) throw mapDatabaseError(error);
  return data === true;
}

async function dispatchNow(
  deps: Dependencies,
  userId: string,
  submissionId: string,
  postId: string,
): Promise<void> {
  const logDispatch = (code: string) =>
    safeLog(deps, {
      event: "tiktok_review_dispatch",
      action: "submit",
      code,
      user_id: userId,
      draft_id: null,
      submission_id: submissionId,
      level: "error",
    });

  let claimed = false;
  try {
    claimed = await setDispatchState(deps.admin, submissionId, ["pending_dispatch"], "dispatching");
  } catch {
    await logDispatch("DISPATCH_CLAIM_FAILED");
    return;
  }
  if (!claimed) return;

  const run = async () => {
    try {
      const base = deps.supabaseUrl.replace(/\/$/, "");
      const response = await fetchBounded(
        deps.fetch,
        `${base}/functions/v1/process-post`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${deps.serviceRoleKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ post_id: postId, expected_scheduled_at: null }),
        },
        PROCESS_POST_TIMEOUT_MS,
      );
      const httpStatus = response.status;
      await response.body?.cancel().catch(() => undefined);
      const next = response.ok ? "dispatched" : "needs_attention";
      try {
        await setDispatchState(deps.admin, submissionId, ["dispatching"], next);
      } catch {
        await logDispatch("DISPATCH_STATE_FAILED");
        return;
      }
      if (!response.ok) await logDispatch(`DISPATCH_HTTP_${httpStatus}`);
    } catch {
      try {
        await setDispatchState(deps.admin, submissionId, ["dispatching"], "unknown");
      } catch {
        await logDispatch("DISPATCH_STATE_FAILED");
      }
      await logDispatch("DISPATCH_UNKNOWN");
    }
  };

  const task = run();
  if (deps.edgeRuntime) {
    try {
      // Called on the runtime object: an unbound waitUntil loses `this`.
      deps.edgeRuntime.waitUntil(task);
      return;
    } catch {
      await task;
      return;
    }
  }
  await task;
}

async function submitDraft(
  deps: Dependencies,
  userId: string,
  request: Extract<ReviewRequest, { action: "submit" }>,
): Promise<Result> {
  const draft = await loadDraft(deps.admin, userId, request.draftId);
  if (draft.revision !== request.expectedRevision) {
    throw new ReviewError(409, "REVISION_CONFLICT", "This draft was updated. Reload it and try again.");
  }
  const lookup = await creatorLookup(deps, userId, draft.accountId);
  if (lookup.kind === "blocked") {
    if (!lookup.capabilities) {
      throw new ReviewError(
        422,
        "POLICY_POSTING_BLOCKED",
        lookup.creator.postingBlockedReason ?? "TikTok is blocking new posts from this account.",
      );
    }
    const violations = evaluateTikTokPublishPolicy({
      caption: draft.caption,
      settings: draft.settings,
      mediaFileId: draft.mediaFileId,
      durationSec: await mediaDuration(deps.admin, userId, draft),
      creator: { ...lookup.capabilities, postingBlocked: true },
    });
    throw policyRefusal(violations);
  }
  const durationSec = await mediaDuration(deps.admin, userId, draft);
  const violations = evaluateTikTokPublishPolicy({
    caption: draft.caption,
    settings: draft.settings,
    mediaFileId: draft.mediaFileId,
    durationSec,
    creator: lookup.capabilities,
  });
  if (violations.length > 0) throw policyRefusal(violations);

  const data = await callRpc(deps.admin, "tiktok_review_submit", {
    p_user_id: userId,
    p_draft_id: request.draftId,
    p_expected_revision: request.expectedRevision,
    p_request_id: request.requestId,
    p_mode: request.mode,
    p_scheduled_at: request.scheduledAt,
    p_time_zone: request.timeZone,
  });
  const row = unwrapRpc(data);
  const submissionId = readString(row.submission_id);
  const postId = readString(row.post_id);
  const mode = row.mode;
  if (!submissionId || !postId || (mode !== "now" && mode !== "scheduled") || typeof row.created !== "boolean") {
    throw readFailed(new Error("Submit result is incomplete."));
  }
  if (row.created === true && mode === "now") {
    await dispatchNow(deps, userId, submissionId, postId);
  }
  return success({
    submissionId,
    postId,
    state: mode === "scheduled" ? "scheduled" : "queued",
  });
}

function mapPost(row: Row): PostSnapshot {
  const status = row.status;
  if (status !== null && status !== undefined && typeof status !== "string") {
    throw readFailed(new Error("Expected a post status."));
  }
  return {
    status: typeof status === "string" ? status : null,
    createdAt: readNullableString(row.created_at),
    postedAt: readNullableString(row.posted_at),
    scheduledAt: readNullableString(row.scheduled_at),
  };
}

type PlatformRow = PlatformPostSnapshot & { responseData: unknown };

function mapPlatform(row: Row): PlatformPostSnapshot {
  const status = row.status;
  if (status !== null && status !== undefined && typeof status !== "string") {
    throw readFailed(new Error("Expected a platform status."));
  }
  return {
    status: typeof status === "string" ? status : null,
    platformPostUrl: readNullableString(row.platform_post_url),
    errorMessage: readNullableString(row.error_message),
    createdAt: readNullableString(row.created_at),
    postedAt: readNullableString(row.posted_at),
  };
}

async function loadSubmission(admin: AdminClient, userId: string, submissionId: string): Promise<StoredSubmission> {
  const result = await admin.from("tiktok_review_submissions")
    .select(
      "id, post_id, social_account_id, dispatch_state, provider_publish_id, last_status_check_at, updated_at",
    )
    .eq("id", submissionId)
    .eq("user_id", userId)
    .maybeSingle();
  await assertRead(result);
  if (!isRow(result.data)) {
    throw new ReviewError(404, "NOT_FOUND", "That submission could not be found.");
  }
  const row = result.data;
  const id = readString(row.id);
  const postId = readString(row.post_id);
  const socialAccountId = readString(row.social_account_id);
  const dispatchState = readString(row.dispatch_state);
  const updatedAt = readString(row.updated_at);
  if (!id || !postId || !socialAccountId || !dispatchState || !updatedAt) {
    throw readFailed(new Error("Submission row is incomplete."));
  }
  return {
    id,
    postId,
    socialAccountId,
    dispatchState,
    updatedAt,
    providerPublishId: readNullableString(row.provider_publish_id),
    lastStatusCheckAt: readNullableString(row.last_status_check_at),
  };
}

async function loadOwnedPost(admin: AdminClient, userId: string, postId: string): Promise<PostSnapshot> {
  const result = await admin.from("posts")
    .select("status, created_at, posted_at, scheduled_at")
    .eq("id", postId)
    .eq("user_id", userId)
    .maybeSingle();
  await assertRead(result);
  if (!isRow(result.data)) throw readFailed(new Error("Post row is missing."));
  return mapPost(result.data);
}

async function loadPlatformPost(admin: AdminClient, postId: string): Promise<PlatformRow | null> {
  const result = await admin.from("platform_posts")
    .select("status, platform_post_url, error_message, response_data, created_at, posted_at")
    .eq("post_id", postId)
    .eq("platform", "tiktok")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  await assertRead(result);
  if (!isRow(result.data)) return null;
  return { ...mapPlatform(result.data), responseData: result.data.response_data };
}

function publishIdOf(platform: PlatformRow | null, submission: StoredSubmission): string | null {
  if (platform && isRow(platform.responseData)) {
    const fromRow = platform.responseData.tiktok_publish_id;
    if (typeof fromRow === "string" && fromRow.length > 0) return fromRow;
  }
  if (submission.providerPublishId && submission.providerPublishId.length > 0) {
    return submission.providerPublishId;
  }
  return null;
}

function checkIsStale(lastStatusCheckAt: string | null, nowMs: number): boolean {
  if (lastStatusCheckAt === null) return true;
  const checkedMs = Date.parse(lastStatusCheckAt);
  if (!Number.isFinite(checkedMs)) return true;
  return nowMs - checkedMs > STATUS_REFRESH_MS;
}

async function claimStatusCheck(
  admin: AdminClient,
  userId: string,
  submission: StoredSubmission,
  nowIso: string,
): Promise<boolean> {
  let query = admin.from("tiktok_review_submissions")
    .update({ last_status_check_at: nowIso })
    .eq("id", submission.id)
    .eq("user_id", userId);
  query = submission.lastStatusCheckAt === null
    ? query.is("last_status_check_at", null)
    : query.eq("last_status_check_at", submission.lastStatusCheckAt);
  const result = await query.select("id");
  await assertRead(result);
  if (Array.isArray(result.data)) return result.data.length > 0;
  return isRow(result.data);
}

async function refreshStatus(
  deps: Dependencies,
  userId: string,
  submission: StoredSubmission,
  platform: PlatformRow | null,
): Promise<boolean> {
  if (!platform || platform.status !== "pending") return false;
  const publishId = publishIdOf(platform, submission);
  if (!publishId || !checkIsStale(submission.lastStatusCheckAt, deps.now())) return false;
  const claimed = await claimStatusCheck(
    deps.admin,
    userId,
    submission,
    new Date(deps.now()).toISOString(),
  );
  if (!claimed) return false;

  const logProvider = (code: string) =>
    safeLog(deps, {
      event: "tiktok_review_provider_failed",
      action: "status",
      code,
      user_id: userId,
      draft_id: null,
      submission_id: submission.id,
      level: "error",
    });

  try {
    await applyPendingWebhookEvents(asServiceRole(deps.admin), publishId);
  } catch {
    await logProvider("PROVIDER_UNAVAILABLE");
  }

  const current = await loadPlatformPost(deps.admin, submission.postId);
  if (!current || current.status !== "pending") return true;

  const account = await findAccount(deps.admin, userId, submission.socialAccountId);
  if (!account?.accessToken) {
    await logProvider(account ? "TOKEN_INVALID" : "ACCOUNT_NOT_FOUND");
    return true;
  }
  const fetched = await fetchPublishStatus(deps.fetch, account.accessToken, publishId);
  if (fetched.kind === "unavailable") {
    await logProvider(fetched.code);
    return true;
  }
  if (fetched.kind === "pending") return true;
  try {
    const outcome = fetched.kind === "complete"
      ? { kind: "published" as const, providerPostId: fetched.providerPostId }
      : { kind: "failed" as const, reason: fetched.reason };
    await applyTikTokPublishOutcome(asServiceRole(deps.admin), {
      publishId,
      userOpenId: account.platformUserId,
      outcome,
    });
  } catch {
    await logProvider("PROVIDER_UNAVAILABLE");
  }
  return true;
}

async function readStatus(deps: Dependencies, userId: string, submissionId: string): Promise<Result> {
  const submission = await loadSubmission(deps.admin, userId, submissionId);
  const post = await loadOwnedPost(deps.admin, userId, submission.postId);
  const platform = await loadPlatformPost(deps.admin, submission.postId);
  const refreshed = await refreshStatus(deps, userId, submission, platform);
  const currentSubmission = refreshed ? await loadSubmission(deps.admin, userId, submissionId) : submission;
  const currentPost = refreshed ? await loadOwnedPost(deps.admin, userId, submission.postId) : post;
  const currentPlatform = refreshed ? await loadPlatformPost(deps.admin, submission.postId) : platform;
  return success(mapPublishStatus({
    platformPost: currentPlatform,
    post: currentPost,
    submission: {
      dispatchState: currentSubmission.dispatchState,
      updatedAt: currentSubmission.updatedAt,
    },
    nowMs: deps.now(),
  }));
}

async function perform(
  deps: Dependencies,
  userId: string,
  request: ReviewRequest,
): Promise<Result> {
  switch (request.action) {
    case "creator_info": {
      const lookup = await creatorLookup(deps, userId, request.accountId);
      return success(lookup.creator);
    }
    case "list": {
      const result = await deps.admin.from("tiktok_review_drafts")
        .select(DRAFT_COLUMNS)
        .eq("user_id", userId)
        .eq("social_account_id", request.accountId)
        .eq("state", request.state)
        .order("updated_at", { ascending: false })
        .limit(100);
      await assertRead(result);
      if (!Array.isArray(result.data)) throw readFailed(new Error("Draft list missing."));
      const drafts = result.data.map((value) => mapDraftRow(requireRow(value)));
      return success(await attachSubmissions(deps.admin, userId, drafts));
    }
    case "get":
      return success(await loadDraft(deps.admin, userId, request.draftId));
    case "create": {
      const data = await callRpc(deps.admin, "tiktok_review_create_draft", {
        p_user_id: userId,
        p_social_account_id: request.accountId,
      });
      return success(await draftFromRpc(deps.admin, userId, data));
    }
    case "save": {
      if (request.mediaFileId) await assertOwnedMedia(deps.admin, userId, request.mediaFileId);
      const data = await callRpc(deps.admin, "tiktok_review_save_draft", {
        p_user_id: userId,
        p_draft_id: request.draftId,
        p_expected_revision: request.expectedRevision,
        p_caption: request.caption,
        p_media_file_id: request.mediaFileId,
        p_media_duration_sec: request.mediaDurationSec,
        p_settings: request.settings,
      });
      return success(await draftFromRpc(deps.admin, userId, data));
    }
    case "reject": {
      if (request.reason.trim().length === 0) {
        throw new ReviewError(422, "REASON_REQUIRED", "Enter a reason to reject this draft.");
      }
      const data = await callRpc(deps.admin, "tiktok_review_transition", {
        p_user_id: userId,
        p_draft_id: request.draftId,
        p_expected_revision: request.expectedRevision,
        p_action: "reject",
        p_reason: request.reason.trim(),
      });
      return success(await draftFromRpc(deps.admin, userId, data));
    }
    case "archive":
    case "restore": {
      const data = await callRpc(deps.admin, "tiktok_review_transition", {
        p_user_id: userId,
        p_draft_id: request.draftId,
        p_expected_revision: request.expectedRevision,
        p_action: request.action,
        p_reason: null,
      });
      return success(await draftFromRpc(deps.admin, userId, data));
    }
    case "submit":
      return await submitDraft(deps, userId, request);
    case "status":
      return await readStatus(deps, userId, request.submissionId);
  }
}

/** Body parser stays lazy: JSON is read only after the anon client accepts the JWT. */
export async function handleRequest(
  req: Request,
  deps: Dependencies,
  readJson: () => Promise<unknown> = () => req.json(),
): Promise<Result> {
  const ctx = {
    userId: null as string | null,
    action: "unknown",
    draftId: null as string | null,
    submissionId: null as string | null,
  };
  let result = failure(500, "INTERNAL", sanitizeErrorMessage(new Error("unhandled")));
  try {
    const authorization = req.headers.get("Authorization") ?? "";
    const token = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
    if (!token) {
      result = failure(401, "UNAUTHORIZED", "Sign in to continue.");
      return result;
    }
    if (token === deps.serviceRoleKey) {
      result = failure(403, "FORBIDDEN", "This action isn't available.");
      return result;
    }
    const { data, error } = await deps.anonClient(authorization).auth.getUser();
    if (error || !data.user) {
      result = failure(401, "UNAUTHORIZED", "Sign in to continue.");
      return result;
    }
    ctx.userId = data.user.id;
    if (req.method !== "POST") {
      result = failure(405, "METHOD_NOT_ALLOWED", "Use POST.");
      return result;
    }
    let body: unknown;
    try {
      body = await readJson();
    } catch {
      result = failure(400, "INVALID_REQUEST", "The request is invalid.");
      return result;
    }
    const peeked = peekLogIds(body);
    ctx.action = peeked.action;
    ctx.draftId = peeked.draftId;
    ctx.submissionId = peeked.submissionId;
    const request = parseReviewRequest(body);
    ctx.action = request.action;
    if ("draftId" in request) ctx.draftId = request.draftId;
    if (request.action === "status") ctx.submissionId = request.submissionId;
    result = await perform(deps, ctx.userId, request);
    if (result.body.data && isRow(result.body.data)) {
      const submissionId = result.body.data.submissionId;
      if (typeof submissionId === "string") ctx.submissionId = submissionId;
    }
    return result;
  } catch (error) {
    if (error instanceof InvalidReviewRequest) {
      result = failure(400, "INVALID_REQUEST", "The request is invalid.");
    } else if (error instanceof ReviewError) {
      result = failure(error.status, error.code, error.message, error.details);
    } else {
      result = failure(500, "INTERNAL", sanitizeErrorMessage(error));
    }
    return result;
  } finally {
    if (result.status >= 400) {
      await safeLog(deps, {
        event: result.status >= 500 ? "tiktok_review_failed" : "tiktok_review_refused",
        action: ctx.action,
        code: result.body.code ?? "INTERNAL",
        user_id: ctx.userId,
        draft_id: ctx.draftId,
        submission_id: ctx.submissionId,
        level: result.status >= 500 ? "error" : "warn",
      });
    }
  }
}
