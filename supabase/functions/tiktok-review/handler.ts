import { createLogger } from "../_shared/logging.ts";
import { timingSafeTokenEqual } from "../_shared/auth-helper.ts";
import { sanitizeErrorMessage } from "../_shared/errorSanitizer.ts";
import {
  evaluateTikTokPublishPolicy,
  type PolicyViolation,
  resolveReviewDurationSec,
  type TikTokReviewSettings,
} from "../_shared/tiktokPublishPolicy.ts";
import { mapDatabaseError, ReviewError } from "./errors.ts";
import { queryCreatorInfo } from "../_shared/tiktokContentPostingApi.ts";
import {
  type AdminClient,
  type Dependencies,
  type OwnedAccount,
  type Result,
  type Row,
  assertRead,
  findAccount,
  isRow,
  readFailed,
  readNullableString,
  readString,
  requireRow,
  safeLog,
  success,
} from "./context.ts";
import { dispatchNow } from "./dispatch.ts";
import { readStatus } from "./statusRefresh.ts";
import { InvalidReviewRequest, parseReviewRequest, type ReviewRequest } from "./validation.ts";

export type { AdminClient, DbResult, Dependencies, LogEvent, Query, Result } from "./context.ts";

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

const DRAFT_COLUMNS =
  "id, social_account_id, revision, state, caption, media_file_id, media_duration_sec, settings, rejection_reason, updated_at";
const ACTIONS = [
  "creator_info",
  "list",
  "get",
  "create",
  "save",
  "reject",
  "archive",
  "restore",
  "reopen",
  "submit",
  "status",
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function unwrapRpc(data: unknown): Row {
  const value = Array.isArray(data) ? data[0] : data;
  return requireRow(value);
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

function readRevision(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
  throw readFailed(new Error("Expected a revision."));
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
    mediaDurationSec: resolveReviewDurationSec(null, row.media_duration_sec),
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
  return resolveReviewDurationSec(result.data.metadata, draft.mediaDurationSec);
}

async function assertOwnedMedia(admin: AdminClient, userId: string, mediaFileId: string): Promise<void> {
  const video = await admin.from("media_files")
    .select("id")
    .eq("id", mediaFileId)
    .eq("user_id", userId)
    .eq("file_type", "video")
    .maybeSingle();
  await assertRead(video);
  if (isRow(video.data)) return;
  const owned = await admin.from("media_files")
    .select("id")
    .eq("id", mediaFileId)
    .eq("user_id", userId)
    .maybeSingle();
  await assertRead(owned);
  if (!isRow(owned.data)) {
    throw new ReviewError(422, "MEDIA_NOT_OWNED", "Choose a video from your library.");
  }
  throw new ReviewError(422, "MEDIA_NOT_VIDEO", "Choose a video file.");
}

async function submitDraft(
  deps: Dependencies,
  userId: string,
  request: Extract<ReviewRequest, { action: "submit" }>,
): Promise<Result> {
  const replay = await deps.admin.from("tiktok_review_submissions")
    .select("id, draft_id, post_id, mode")
    .eq("user_id", userId)
    .eq("request_id", request.requestId)
    .maybeSingle();
  await assertRead(replay);
  if (isRow(replay.data)) {
    const { id, draft_id: draftId, post_id: postId, mode } = replay.data;
    if (typeof draftId !== "string") throw readFailed(new Error("Submission row is incomplete."));
    if (draftId !== request.draftId) {
      throw mapDatabaseError(new Error("TIKTOK_REVIEW_REQUEST_REUSED"));
    }
    if (typeof id !== "string" || typeof postId !== "string" || (mode !== "now" && mode !== "scheduled")) {
      throw readFailed(new Error("Submission row is incomplete."));
    }
    return success({ submissionId: id, postId, state: mode === "scheduled" ? "scheduled" : "queued" });
  }
  const draft = await loadDraftRow(deps.admin, userId, request.draftId);
  if (draft.revision !== request.expectedRevision) {
    throw new ReviewError(409, "REVISION_CONFLICT", "This draft was updated. Reload it and try again.");
  }
  if (draft.state !== "pending_review") {
    throw mapDatabaseError(new Error("TIKTOK_REVIEW_INVALID_STATE"));
  }
  if (draft.mediaFileId) await assertOwnedMedia(deps.admin, userId, draft.mediaFileId);
  const lookup = await creatorLookup(deps, userId, draft.accountId);
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
    creator: { ...lookup.capabilities, postingBlocked: lookup.kind === "blocked" },
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
    case "restore":
    case "reopen": {
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
    if (timingSafeTokenEqual(token, deps.serviceRoleKey)) {
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
      const message = ctx.action === "reopen" && error.code === "INVALID_STATE"
        ? "TikTok may still have this post. Check TikTok before trying again."
        : error.message;
      result = failure(error.status, error.code, message, error.details);
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
