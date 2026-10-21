// The use cases behind the n8n API routes for posts and accounts. Each one is a pure
// async function that returns an ActionResult (status + JSON body); toResponse is the
// only adapter that turns one into an HTTP response.
//
// This function runs with the service role, so RLS is not the boundary: every query and
// every write on `posts` carries .eq("user_id", userId), and `platform_posts` is only
// ever reached through a read that joins the parent post and filters on its owner.
import { z } from "npm:zod@3.23.8";
import { validateRequestBody } from "../_shared/validate.ts";
import { containsSensitiveInfo } from "../_shared/errorSanitizer.ts";
import { restrictedCorsHeaders } from "../_shared/cors.ts";
import { fetchWithTimeout } from "../_shared/request-timeout.ts";
import {
  defaultYouTubeDeps,
  type YouTubeCommentsDeps,
} from "../_shared/youtubeComments.ts";
import { isValidUuid } from "./requestGuards.ts";
import {
  deletePublishedPost,
  type DeleteAccount,
  type PlatformDeleteOutcome,
  type PublishedPlatformPost,
} from "./platformPostDelete.ts";

export interface ActionResult {
  status: number;
  body: Record<string, unknown>;
}

export interface PostActionDeps {
  // deno-lint-ignore no-explicit-any
  supabase: any;
  fetcher: typeof fetch;
  now: () => Date;
  supabaseUrl: string;
  serviceRoleKey: string;
  youtubeDeps: () => YouTubeCommentsDeps;
}

export function defaultPostActionDeps(
  // deno-lint-ignore no-explicit-any
  supabase: any,
): PostActionDeps {
  return {
    supabase,
    fetcher: fetch,
    now: () => new Date(),
    supabaseUrl: Deno.env.get("SUPABASE_URL") ?? "",
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    youtubeDeps: defaultYouTubeDeps,
  };
}

export function toResponse(req: Request, result: ActionResult): Response {
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { ...restrictedCorsHeaders(req), "Content-Type": "application/json" },
  });
}

function ok(body: Record<string, unknown>, status = 200): ActionResult {
  return { status, body: { success: true, ...body } };
}

function error(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): ActionResult {
  return {
    status,
    body: {
      success: false,
      error: {
        code,
        message,
        ...(details !== undefined ? { details } : {}),
      },
    },
  };
}

// One message whether the id does not exist or belongs to somebody else: the difference
// is the caller's business, not something the API hands out.
const NOT_FOUND = error(404, "POST_NOT_FOUND", "Post not found.");

const SCHEDULED_STATUSES = ["scheduled", "pending"];

const PostIdSchema = z.object({ post_id: z.string() });

const DeletePostSchema = z.object({
  post_id: z.string(),
  // A form-encoded body carries every value as a string, so the flag arrives as
  // "true" instead of true.
  delete_record_if_platform_fails: z.union([z.boolean(), z.enum(["true", "false"])]).optional(),
});

const RescheduleSchema = z.object({
  post_id: z.string(),
  scheduled_at: z.string(),
});

const BestTimesSchema = z.object({
  platforms: z.array(z.string().min(1).max(50)).min(1).max(12),
});

const BEST_TIMES_TIMEOUT_MS = 60_000;

// An ISO 8601 instant without an offset is ambiguous: two machines read it as two
// different instants, and the post would publish at the wrong hour. A trailing Z or a
// +HH:MM offset is required.
const EXPLICIT_OFFSET_RE = /(Z|[+-]\d{2}:\d{2})$/i;

function invalidBody(failure: { details: unknown }): ActionResult {
  return error(400, "INVALID_REQUEST", "Invalid request body", failure.details);
}

function actionErrorCode(result: ActionResult): string {
  const failure = result.body.error as { code?: unknown } | undefined;
  return typeof failure?.code === "string" ? failure.code : "ERROR";
}

// Every refusal leaves a line behind. Ids only: never a token, never a request body.
function refuse(
  route: string,
  subject: string,
  result: ActionResult,
): ActionResult {
  console.warn(`[n8n-api] ${route}: ${actionErrorCode(result)} (${subject})`);
  return result;
}

// A refusal is logged; a server fault is not, because the fault was already logged
// where it happened.
function refuseOrFail(
  route: string,
  subject: string,
  result: ActionResult,
): ActionResult {
  if (result.status >= 500) return result;
  return refuse(route, subject, result);
}

// One answer for every caller that hands over something that is not a post id,
// so the wording of the refusal cannot drift between routes.
function invalidPostId(): ActionResult {
  return error(
    400,
    "INVALID_POST_ID",
    "post_id must be a Postora post UUID (from list_posts or get_post).",
  );
}

function requirePostId(body: unknown): string | ActionResult {
  const parsed = validateRequestBody(PostIdSchema, body);
  if (!parsed.success) return invalidBody(parsed);
  if (!isValidUuid(parsed.data.post_id)) {
    return invalidPostId();
  }
  return parsed.data.post_id;
}

interface DeleteOptions {
  post_id: string;
  delete_record_if_platform_fails: boolean;
}

// The delete route takes one more field than the other post routes: the caller may
// say that the Postora record may go even when a platform copy cannot be deleted.
function requireDeleteOptions(body: unknown): DeleteOptions | ActionResult {
  const parsed = validateRequestBody(DeletePostSchema, body);
  if (!parsed.success) return invalidBody(parsed);
  if (!isValidUuid(parsed.data.post_id)) {
    return invalidPostId();
  }
  return {
    post_id: parsed.data.post_id,
    delete_record_if_platform_fails: parsed.data.delete_record_if_platform_fails === true ||
      parsed.data.delete_record_if_platform_fails === "true",
  };
}

interface PostRow {
  id: string;
  status: string;
  scheduled_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface PlatformResultRow {
  id: string;
  platform: string;
  status: string;
  social_account_id: string | null;
  platform_post_id?: string | null;
  response_data?: unknown;
}

// Every post use case needs the same owned read, and every one of them has to
// refuse the same way when the row is missing or unreadable.
async function readOwnedPost(
  deps: PostActionDeps,
  route: string,
  postId: string,
  userId: string,
  columns: string,
): Promise<PostRow | ActionResult> {
  const { data, error: readError } = await deps.supabase
    .from("posts")
    .select(columns)
    .eq("id", postId)
    .eq("user_id", userId)
    .maybeSingle();

  if (readError) {
    console.error(`[n8n-api] ${route}: reading post ${postId} failed: ${readError.message}`);
    return error(500, "INTERNAL_ERROR", "Reading the post failed. Please try again.");
  }
  if (!data) return refuse(route, `post ${postId}, user ${userId}`, NOT_FOUND);
  return data as PostRow;
}

// The helpers below answer with either a row or an ActionResult, so the caller has
// to tell them apart before it goes on.
function isActionResult(value: unknown): value is ActionResult {
  return typeof value === "object" && value !== null &&
    "status" in value && "body" in value;
}

function isFutureScheduled(
  post: { status?: string | null; scheduled_at?: string | null },
  now: Date,
): boolean {
  return SCHEDULED_STATUSES.includes(String(post.status)) &&
    typeof post.scheduled_at === "string" &&
    post.scheduled_at.length > 0 &&
    Date.parse(post.scheduled_at) > now.getTime();
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function distinct(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

// ── shared: the per-platform results of a post ─────────────────────────────────
//
// A delete reads the results of a post through the owner-scoped query and clears
// the ones that are gone on their platform. Both halves keep the ownership in the
// query itself, not in a check the caller has to do first.

// The per-platform results of one post. The read joins the parent post and
// filters on its owner, so the ownership is part of the query itself and not
// something the caller has to have checked first.
export async function readPlatformResults(
  deps: PostActionDeps,
  route: string,
  request: { postId: string; userId: string; columns: string },
): Promise<PlatformResultRow[] | ActionResult> {
  const { data, error: readError } = await deps.supabase
    .from("platform_posts")
    .select(`${request.columns}, posts!inner(user_id)`)
    .eq("post_id", request.postId)
    .eq("posts.user_id", request.userId);

  if (readError) {
    console.error(
      `[n8n-api] ${route}: reading the platform results of post ${request.postId} failed: ${readError.message}`,
    );
    return error(500, "INTERNAL_ERROR", "Reading the publish results failed. Please try again.");
  }
  if (!Array.isArray(data)) return [];
  // The join adds the parent post to every row; the rows keep the shape they had
  // before it.
  return (data as Array<PlatformResultRow & { posts?: unknown }>)
    .map(({ posts: _joined, ...row }) => row as PlatformResultRow);
}

// Removes the platform_posts rows of a post by id. The ids are checked against an
// owner-scoped read first, so the ownership is part of the delete itself and not
// something the caller has to have checked before: a row that is not this user's
// is never deleted, whatever the caller asked for. Returns the warning the caller
// has to show when the rows could not be cleared.
async function clearDeletedResults(
  deps: PostActionDeps,
  route: string,
  request: { postId: string; userId: string; rowIds: string[]; warning: string },
): Promise<string | null> {
  if (request.rowIds.length === 0) return null;

  const owned = await readPlatformResults(deps, route, {
    postId: request.postId,
    userId: request.userId,
    columns: "id",
  });
  if (isActionResult(owned)) {
    console.error(
      `[n8n-api] ${route}: the results of post ${request.postId} could not be read, so none of them were cleared`,
    );
    return request.warning;
  }

  const ownedIds = new Set(owned.map((row) => row.id));
  const rowIds = request.rowIds.filter((rowId) => ownedIds.has(rowId));
  // None of the requested rows belongs to this user: there is nothing to delete.
  if (rowIds.length === 0) return null;

  const { error: deleteError } = await deps.supabase
    .from("platform_posts")
    .delete()
    .eq("post_id", request.postId)
    .in("id", rowIds);

  if (!deleteError) return null;
  console.error(
    `[n8n-api] ${route}: clearing the results of post ${request.postId} failed: ${deleteError.message}`,
  );
  return request.warning;
}

// ── 1. posts/cancel ────────────────────────────────────────────────────────────

export async function cancelScheduledPost(
  deps: PostActionDeps,
  userId: string,
  body: unknown,
): Promise<ActionResult> {
  const route = "posts/cancel";
  const postId = requirePostId(body);
  if (typeof postId !== "string") {
    return refuse(route, `post unknown, user ${userId}`, postId);
  }
  const subject = `post ${postId}, user ${userId}`;
  const now = deps.now();

  const read = await readOwnedPost(deps, route, postId, userId, "id, status, scheduled_at");
  if (isActionResult(read)) return read;
  const post = read;

  if (!isFutureScheduled(post, now)) {
    return refuse(
      route,
      subject,
      error(
        409,
        "POST_NOT_SCHEDULED",
        "Only a scheduled post whose time has not come yet can be cancelled.",
        { status: post.status, scheduled_at: post.scheduled_at ?? null },
      ),
    );
  }

  const refusal = await cancelScheduledRow(deps, route, { postId, userId, now });
  if (refusal) return refuseOrFail(route, subject, refusal);

  return ok({ post_id: postId, cancelled: true });
}

// Compare-and-set: the scheduler claims the same row by flipping it to `processing`,
// so the delete only lands while the post is still scheduled for the future. The
// platform_posts rows go with it through the existing ON DELETE CASCADE.
async function cancelScheduledRow(
  deps: PostActionDeps,
  route: string,
  request: { postId: string; userId: string; now: Date },
): Promise<ActionResult | null> {
  const { data: deleted, error: deleteError } = await deps.supabase
    .from("posts")
    .delete()
    .eq("id", request.postId)
    .eq("user_id", request.userId)
    .in("status", SCHEDULED_STATUSES)
    .gt("scheduled_at", request.now.toISOString())
    .select("id");

  if (deleteError) {
    console.error(
      `[n8n-api] ${route}: deleting post ${request.postId} failed: ${deleteError.message}`,
    );
    return error(500, "INTERNAL_ERROR", "Cancelling the post failed. Please try again.");
  }
  if (!deleted || deleted.length === 0) {
    return error(
      409,
      "POST_STATE_CHANGED",
      "The post changed while it was being cancelled (it may already be publishing). Check get_post.",
    );
  }
  return null;
}

// ── 2. posts/reschedule ────────────────────────────────────────────────────────

// A post created by the TikTok review flow is bound to the instant the user
// consented to: process-post refuses to publish it when posts.scheduled_at no
// longer matches the consented instant on the review submission, so a reschedule
// here would break the publish instead of moving it.
const CONSENT_BOUND_POST = error(
  409,
  "CONSENT_BOUND_POST",
  "This post was scheduled through the TikTok review consent flow; reschedule it from the Postora dashboard so the consent is renewed.",
);

// The review submission a TikTok review post was created through. A post that
// carries one may not be moved from here.
function isConsentBoundPost(post: PostRow): boolean {
  const submissionId = post.metadata?.tiktok_review_submission_id;
  return typeof submissionId === "string" && submissionId.length > 0;
}

export async function reschedulePost(
  deps: PostActionDeps,
  userId: string,
  body: unknown,
): Promise<ActionResult> {
  const route = "posts/reschedule";
  const parsed = validateRequestBody(RescheduleSchema, body);
  if (!parsed.success) {
    return refuse(route, `post unknown, user ${userId}`, invalidBody(parsed));
  }
  const { post_id: postId, scheduled_at: scheduledAt } = parsed.data;
  if (!isValidUuid(postId)) {
    return refuse(route, `post unknown, user ${userId}`, invalidPostId());
  }
  const subject = `post ${postId}, user ${userId}`;
  const now = deps.now();

  const invalid = rescheduleRefusal({
    route,
    subject,
    scheduledAt,
    now,
  });
  if (invalid) return invalid;

  const read = await readOwnedPost(deps, route, postId, userId, "id, status, scheduled_at, metadata");
  if (isActionResult(read)) return read;
  const post = read;

  // The consent of a TikTok review post covers one account and one publish
  // instant, so the post may not be moved from here.
  if (isConsentBoundPost(post)) {
    return refuse(route, subject, CONSENT_BOUND_POST);
  }

  if (!isFutureScheduled(post, now)) {
    return refuse(
      route,
      subject,
      error(
        409,
        "POST_NOT_SCHEDULED",
        "Only a scheduled post whose time has not come yet can be rescheduled.",
      ),
    );
  }

  // Only the instant is written. The timezone is a label for the UI, and
  // rebuilding the whole metadata object from an earlier read would overwrite a
  // dashboard edit that landed in the meantime.
  const payload: Record<string, unknown> = {
    scheduled_at: new Date(scheduledAt).toISOString(),
  };

  const updated = await rescheduleRow(deps, route, { postId, userId, payload, now });
  if (isActionResult(updated)) return refuseOrFail(route, subject, updated);

  return ok({ post: updated.post, previous_scheduled_at: post.scheduled_at });
}

// The offset of an ISO 8601 instant in minutes, or null when the string does
// not end in one. A Z offset is zero minutes.
function offsetMinutesOf(value: string): number | null {
  if (/z$/i.test(value)) return 0;
  const match = /([+-])(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

// Date.parse accepts a day the calendar does not have: "2026-02-30" is read
// as the second of March, so the post would be published on a day nobody asked
// for. The written date is checked against the calendar instead: the parsed
// instant, shifted by the offset that was written (nothing for a Z), has to
// land on the same year, month and day.
function hasRealCalendarDate(value: string): boolean {
  const written = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  const offsetMinutes = offsetMinutesOf(value);
  if (!written || offsetMinutes === null) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const local = new Date(parsed + offsetMinutes * 60_000);
  return local.getUTCFullYear() === Number(written[1]) &&
    local.getUTCMonth() + 1 === Number(written[2]) &&
    local.getUTCDate() === Number(written[3]);
}

// The body of a reschedule is checked before the post is even read: a time that
// cannot be published is the caller's mistake, not the post's state.
function rescheduleRefusal(request: {
  route: string;
  subject: string;
  scheduledAt: string;
  now: Date;
}): ActionResult | null {
  const { route, subject, scheduledAt, now } = request;
  if (
    !EXPLICIT_OFFSET_RE.test(scheduledAt) ||
    !Number.isFinite(Date.parse(scheduledAt)) ||
    !hasRealCalendarDate(scheduledAt)
  ) {
    return refuse(
      route,
      subject,
      error(
        400,
        "INVALID_SCHEDULED_AT",
        "scheduled_at must be an ISO 8601 timestamp with a UTC offset, e.g. 2026-06-05T14:30:00Z or 2026-06-05T17:30:00+03:00.",
      ),
    );
  }
  if (Date.parse(scheduledAt) <= now.getTime()) {
    return refuse(
      route,
      subject,
      error(400, "SCHEDULED_AT_IN_PAST", "scheduled_at must be in the future."),
    );
  }
  return null;
}

async function rescheduleRow(
  deps: PostActionDeps,
  route: string,
  request: {
    postId: string;
    userId: string;
    payload: Record<string, unknown>;
    now: Date;
  },
): Promise<{ post: Record<string, unknown> } | ActionResult> {
  const { data: rows, error: updateError } = await deps.supabase
    .from("posts")
    .update(request.payload)
    .eq("id", request.postId)
    .eq("user_id", request.userId)
    .in("status", SCHEDULED_STATUSES)
    .gt("scheduled_at", request.now.toISOString())
    .select("id, status, scheduled_at");

  if (updateError) {
    console.error(
      `[n8n-api] ${route}: updating post ${request.postId} failed: ${updateError.message}`,
    );
    return error(500, "INTERNAL_ERROR", "Rescheduling the post failed. Please try again.");
  }
  if (!rows || rows.length === 0) {
    return error(
      409,
      "POST_STATE_CHANGED",
      "The post changed while it was being rescheduled (it may already be publishing). Check get_post.",
    );
  }
  return { post: rows[0] };
}

// ── 3. posts/delete ────────────────────────────────────────────────────────────

const POST_PROCESSING_DELETE = error(
  409,
  "POST_PROCESSING",
  "The post is publishing right now. Delete it when it has finished.",
);

const CLEARED_ROWS_WARNING =
  "Some deleted platform results could not be cleared; a retry may report them as failed.";

// A platform copy that cannot be deleted keeps the Postora record alive, unless the
// caller says the record may go anyway. The hint is part of the message because the
// caller has to know the way out exists.
const PLATFORM_DELETE_FAILED_MESSAGE =
  "The post could not be deleted on every platform. The Postora record was kept so you can retry." +
  " Pass delete_record_if_platform_fails: true to delete the Postora record anyway" +
  " (for example when the post was already removed on the platform).";

// The Postora record could not be removed.
const RECORD_DELETE_FAILED_MESSAGE = "Deleting the Postora record failed. Please try again.";

// Something else moved the post while the delete was running.
const POST_STATE_CHANGED_MESSAGE = "The post changed while it was being deleted. Check get_post.";

// A publish landed while the delete was running: the record may not go, or the new
// result would be orphaned by the delete.
const POST_PUBLISHED_AGAIN_MESSAGE =
  "The post was published again while it was being deleted. Check get_post.";

// Every answer that does not remove the record says so, says what happened on each
// platform, and says whether a result could not be cleared.
function deleteDetails(
  report: Array<Record<string, unknown>>,
  warning: string | null,
): Record<string, unknown> {
  const details: Record<string, unknown> = { record_deleted: false, platforms: report };
  if (warning) details.warning = warning;
  return details;
}

export async function deletePost(
  deps: PostActionDeps,
  userId: string,
  body: unknown,
): Promise<ActionResult> {
  const route = "posts/delete";
  const options = requireDeleteOptions(body);
  if (isActionResult(options)) {
    return refuse(route, `post unknown, user ${userId}`, options);
  }
  const postId = options.post_id;
  const subject = `post ${postId}, user ${userId}`;

  const read = await readOwnedPost(deps, route, postId, userId, "id, status");
  if (isActionResult(read)) return read;
  const post = read;
  if (post.status === "processing") return refuse(route, subject, POST_PROCESSING_DELETE);

  // The delete never claims the post. A claim that is not given back (the function
  // is cut off between two platforms) would leave the post `processing` for good,
  // and every later delete would be refused.
  const snapshot = await readDeleteSnapshot(deps, route, { postId, userId });
  if (isActionResult(snapshot)) return snapshot;

  const accountById = await loadPublishingAccounts(deps, route, {
    postId,
    userId,
    accountIds: distinct(snapshot.published.map((row) => row.social_account_id)),
  });
  if (isActionResult(accountById)) return accountById;

  const { report, warning } = await deleteOnPlatforms(deps, route, {
    postId,
    userId,
    published: snapshot.published,
    accountById,
  });

  const failed = report.some((item) => item.outcome === "failed");
  if (failed && !options.delete_record_if_platform_fails) {
    return refuseOrFail(route, subject, error(
      422,
      "PLATFORM_DELETE_FAILED",
      PLATFORM_DELETE_FAILED_MESSAGE,
      deleteDetails(report, warning),
    ));
  }

  // The optimistic check: the record goes only while the results are still the ones
  // this delete started from. A publish that landed meanwhile (or one that is still
  // running) would be orphaned by the delete, so the record stays and the caller is
  // told to look at the post.
  const current = await readPlatformResults(deps, route, {
    postId,
    userId,
    columns: "id, status",
  });
  if (isActionResult(current)) {
    return refuseOrFail(route, subject, error(
      500,
      "INTERNAL_ERROR",
      RECORD_DELETE_FAILED_MESSAGE,
      deleteDetails(report, warning),
    ));
  }
  const publishedAgain = current.some((row) =>
    !snapshot.rowIds.has(row.id) || row.status === "pending"
  );
  if (publishedAgain) {
    return refuse(route, subject, error(
      409,
      "POST_STATE_CHANGED",
      POST_PUBLISHED_AGAIN_MESSAGE,
      deleteDetails(report, warning),
    ));
  }

  const deletion = await deleteRecord(deps, route, { postId, userId });
  if (deletion.kind === "deleted") {
    // The media files stay in the library: they may be attached to another post, and
    // a library entry is not part of "this post".
    return ok({
      post_id: postId,
      record_deleted: true,
      media_kept_in_library: true,
      platforms: report,
      ...(failed ? { kept_despite_failures: true } : {}),
    });
  }
  return refuseOrFail(route, subject, error(
    deletion.kind === "error" ? 500 : 409,
    deletion.kind === "error" ? "INTERNAL_ERROR" : "POST_STATE_CHANGED",
    deletion.kind === "error" ? RECORD_DELETE_FAILED_MESSAGE : POST_STATE_CHANGED_MESSAGE,
    deleteDetails(report, warning),
  ));
}

// The results the delete works from, and the ids it remembers. A row that shows up
// in a later read is a publish that landed while the delete was running.
async function readDeleteSnapshot(
  deps: PostActionDeps,
  route: string,
  request: { postId: string; userId: string },
): Promise<{ rowIds: Set<string>; published: PlatformResultRow[] } | ActionResult> {
  const results = await readPlatformResults(deps, route, {
    postId: request.postId,
    userId: request.userId,
    columns: "id, platform, status, platform_post_id, social_account_id, response_data",
  });
  if (isActionResult(results)) return results;

  // A platform that is still publishing (an async publish records a pending row
  // while the parent post is already `completed`) is left alone: the delete would
  // orphan the result it is about to write.
  const pending = results.filter((row) => row.status === "pending");
  if (pending.length > 0) {
    return refuse(
      route,
      `post ${request.postId}, user ${request.userId}`,
      error(
        409,
        "RESULTS_PENDING",
        "A platform is still publishing this post. Delete it when every result has finished.",
        { pending_platforms: distinct(pending.map((row) => row.platform)) },
      ),
    );
  }

  return {
    rowIds: new Set(results.map((row) => row.id)),
    published: results.filter((row) => row.status === "success"),
  };
}

async function loadPublishingAccounts(
  deps: PostActionDeps,
  route: string,
  request: { postId: string; userId: string; accountIds: string[] },
): Promise<Map<string, DeleteAccount> | ActionResult> {
  const accountById = new Map<string, DeleteAccount>();
  if (request.accountIds.length === 0) return accountById;

  const { data, error: readError } = await deps.supabase
    .from("social_accounts")
    .select("id, user_id, platform, access_token, refresh_token, token_expires_at, auth_provider, connection_id, workspace_id, platform_user_id, account_metadata")
    .eq("user_id", request.userId)
    .in("id", request.accountIds);

  if (readError) {
    console.error(
      `[n8n-api] ${route}: reading the social accounts for post ${request.postId} failed: ${readError.message}`,
    );
    return error(500, "INTERNAL_ERROR", "Reading the social account failed. Please try again.");
  }
  for (const account of (data ?? []) as DeleteAccount[]) {
    accountById.set(account.id, account);
  }
  return accountById;
}

// Deletes the published copies of the post on their platforms and reports what
// happened to each of them. A copy that is gone is cleared from the results right
// away, so a delete that is cut short never offers it to a platform a second time.
async function deleteOnPlatforms(
  deps: PostActionDeps,
  route: string,
  request: {
    postId: string;
    userId: string;
    published: PlatformResultRow[];
    accountById: Map<string, DeleteAccount>;
  },
): Promise<{ report: Array<Record<string, unknown>>; warning: string | null }> {
  const report: Array<Record<string, unknown>> = [];
  let warning: string | null = null;
  // One platform at a time: a provider that rate-limits is told about one delete, not
  // about a burst of them.
  for (const row of request.published) {
    const publishedRow: PublishedPlatformPost = {
      id: row.id,
      platform: row.platform,
      platform_post_id: row.platform_post_id ?? null,
      social_account_id: row.social_account_id ?? null,
      response_data: row.response_data ?? null,
    };
    const outcome: PlatformDeleteOutcome = await deletePublishedPost(
      publishedRow,
      row.social_account_id ? request.accountById.get(row.social_account_id) ?? null : null,
      { fetcher: deps.fetcher, youtubeDeps: deps.youtubeDeps },
    );
    const item: Record<string, unknown> = {
      platform: row.platform,
      platform_post_id: row.platform_post_id ?? null,
      social_account_id: row.social_account_id ?? null,
      outcome: outcome.outcome,
      deleted_on_platform: outcome.outcome === "deleted",
    };
    if (outcome.outcome === "deleted") {
      if (outcome.note) item.note = outcome.note;
      // The row is cleared before the next platform is asked anything: the copy is
      // already gone, so a retry must not call the platform with it again.
      const clearWarning = await clearDeletedResults(deps, route, {
        postId: request.postId,
        userId: request.userId,
        rowIds: [row.id],
        warning: CLEARED_ROWS_WARNING,
      });
      if (clearWarning) warning = clearWarning;
    } else {
      item.reason = outcome.reason;
    }
    report.push(item);
  }
  return { report, warning };
}

type RecordDeletion =
  | { kind: "deleted" }
  | { kind: "error" }
  | { kind: "missing" };

async function deleteRecord(
  deps: PostActionDeps,
  route: string,
  request: { postId: string; userId: string },
): Promise<RecordDeletion> {
  // The post may not be publishing while it goes: a publish that is running now
  // would write its result into a record that no longer exists.
  const { data, error: readError } = await deps.supabase
    .from("posts")
    .delete()
    .eq("id", request.postId)
    .eq("user_id", request.userId)
    .neq("status", "processing")
    .select("id");

  if (readError) {
    console.error(
      `[n8n-api] ${route}: deleting post ${request.postId} failed: ${readError.message}`,
    );
    return { kind: "error" };
  }
  if (!Array.isArray(data) || data.length === 0) return { kind: "missing" };
  return { kind: "deleted" };
}

// ── 4. accounts/health ─────────────────────────────────────────────────────────

export async function checkAccountHealth(
  deps: PostActionDeps,
  userId: string,
  accountId: string | null,
): Promise<ActionResult> {
  const route = "accounts/health";
  if (!accountId) {
    return refuse(
      route,
      `account unknown, user ${userId}`,
      error(400, "INVALID_ACCOUNT_ID", "social_account_id is required."),
    );
  }
  if (!isValidUuid(accountId)) {
    return refuse(
      route,
      `account <invalid id>, user ${userId}`,
      error(
        400,
        "INVALID_ACCOUNT_ID",
        `social_account_id must be a Postora account UUID (from GET /api/v1/accounts), not '${accountId}'.`,
      ),
    );
  }
  const subject = `account ${accountId}, user ${userId}`;

  // Never the tokens: this answer is read by a workflow, not by a person with a
  // permission problem to solve.
  const { data, error: readError } = await deps.supabase
    .from("social_accounts")
    .select("id, platform, platform_username, is_active, needs_reauth, failure_count, last_refresh_error, token_expires_at")
    .eq("id", accountId)
    .eq("user_id", userId)
    .maybeSingle();

  if (readError) {
    console.error(`[n8n-api] ${route}: reading social account ${accountId} failed: ${readError.message}`);
    return error(500, "INTERNAL_ERROR", "Reading the social account failed. Please try again.");
  }
  if (!data) {
    return refuse(
      route,
      subject,
      error(
        404,
        "ACCOUNT_NOT_FOUND",
        "Social account not found or not owned by the authenticated user.",
      ),
    );
  }

  const account = data as Record<string, unknown>;
  const now = deps.now().getTime();
  const expiresMs = account.token_expires_at ? Date.parse(String(account.token_expires_at)) : NaN;
  const tokenExpired = Number.isFinite(expiresMs) ? expiresMs <= now : null;
  const daysUntilExpiry = Number.isFinite(expiresMs)
    ? Math.floor((expiresMs - now) / 86_400_000)
    : null;
  const lastRefreshError = typeof account.last_refresh_error === "string"
    ? (containsSensitiveInfo(account.last_refresh_error) ? "redacted" : account.last_refresh_error)
    : null;
  const needsReauth = account.needs_reauth === true;
  const isActive = account.is_active === true;

  return ok({
    account: {
      id: account.id,
      platform: account.platform,
      platform_username: account.platform_username ?? null,
      is_active: account.is_active,
      needs_reauth: needsReauth,
      failure_count: account.failure_count ?? 0,
      last_refresh_error: lastRefreshError,
      token_expires_at: account.token_expires_at ?? null,
      token_expired: tokenExpired,
      days_until_expiry: daysUntilExpiry,
      healthy: isActive && !needsReauth && tokenExpired !== true,
    },
  });
}

// ── 5. best-times ──────────────────────────────────────────────────────────────

export function computePostingHistogram(
  postedAts: string[],
  timeZone: string,
): {
  hourCounts: Record<number, number>;
  dayCounts: Record<number, number>;
  totalPosts: number;
} {
  const hourCounts: Record<number, number> = {};
  const dayCounts: Record<number, number> = {};
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hourCycle: "h23",
    weekday: "short",
  });
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let totalPosts = 0;

  for (const postedAt of postedAts) {
    const date = new Date(postedAt);
    if (Number.isNaN(date.getTime())) continue;
    const parts = formatter.formatToParts(date);
    const hourPart = parts.find((part) => part.type === "hour");
    const weekdayPart = parts.find((part) => part.type === "weekday");
    if (!hourPart || !weekdayPart) continue;
    const hour = Number(hourPart.value);
    const day = weekdays.indexOf(weekdayPart.value);
    if (!Number.isFinite(hour) || day < 0) continue;
    hourCounts[hour] = (hourCounts[hour] ?? 0) + 1;
    dayCounts[day] = (dayCounts[day] ?? 0) + 1;
    totalPosts += 1;
  }

  return { hourCounts, dayCounts, totalPosts };
}

export async function suggestBestTimes(
  deps: PostActionDeps,
  userId: string,
  body: unknown,
  preferredTimezone: string | null,
): Promise<ActionResult> {
  const route = "best-times";
  const parsed = validateRequestBody(BestTimesSchema, body);
  if (!parsed.success) {
    return refuse(route, `user ${userId}`, invalidBody(parsed));
  }
  const { platforms } = parsed.data;

  const timeZone = preferredTimezone && isValidTimeZone(preferredTimezone)
    ? preferredTimezone
    : "UTC";

  const { data, error: readError } = await deps.supabase
    .from("posts")
    .select("posted_at")
    .eq("user_id", userId)
    .eq("status", "completed")
    .not("posted_at", "is", null)
    .order("posted_at", { ascending: false })
    .limit(500);

  if (readError) {
    console.error(`[n8n-api] ${route}: reading the posting history failed: ${readError.message}`);
    return error(500, "INTERNAL_ERROR", "Reading the posting history failed. Please try again.");
  }

  const postedAts = ((data ?? []) as Array<{ posted_at: string | null }>)
    .map((row) => row.posted_at)
    .filter((value): value is string => typeof value === "string");
  const historicalData = computePostingHistogram(postedAts, timeZone);

  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${deps.supabaseUrl}/functions/v1/suggest-best-times`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${deps.serviceRoleKey}`,
        },
        body: JSON.stringify({ platforms, historicalData }),
      },
      BEST_TIMES_TIMEOUT_MS,
      deps.fetcher,
    );
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    if (message === "Request timed out") {
      return error(
        504,
        "BEST_TIMES_TIMEOUT",
        "The suggestion service did not answer in time. Try again.",
      );
    }
    console.error(`[n8n-api] ${route}: the suggestion service could not be reached`);
    return error(502, "BEST_TIMES_FAILED", "Could not get suggestions right now. Try again.");
  }

  if (!response.ok) {
    console.error(`[n8n-api] ${route}: the suggestion service answered ${response.status}`);
    return error(502, "BEST_TIMES_FAILED", "Could not get suggestions right now. Try again.");
  }

  const json = await response.json().catch(() => null) as Record<string, unknown> | null;
  return ok({
    timezone: timeZone,
    based_on_posts: historicalData.totalPosts,
    suggestions: Array.isArray(json?.suggestions) ? json.suggestions : [],
  });
}

// ── route adapters ─────────────────────────────────────────────────────────────

export const handleCancelScheduledPost = async (
  req: Request,
  // deno-lint-ignore no-explicit-any
  supabase: any,
  userId: string,
  body: unknown,
): Promise<Response> =>
  toResponse(req, await cancelScheduledPost(defaultPostActionDeps(supabase), userId, body));

export const handleReschedulePost = async (
  req: Request,
  // deno-lint-ignore no-explicit-any
  supabase: any,
  userId: string,
  body: unknown,
): Promise<Response> =>
  toResponse(req, await reschedulePost(defaultPostActionDeps(supabase), userId, body));

export const handleDeletePost = async (
  req: Request,
  // deno-lint-ignore no-explicit-any
  supabase: any,
  userId: string,
  body: unknown,
): Promise<Response> =>
  toResponse(req, await deletePost(defaultPostActionDeps(supabase), userId, body));

export const handleSuggestBestTimes = async (
  req: Request,
  // deno-lint-ignore no-explicit-any
  supabase: any,
  userId: string,
  body: unknown,
  preferredTimezone: string | null,
): Promise<Response> =>
  toResponse(
    req,
    await suggestBestTimes(defaultPostActionDeps(supabase), userId, body, preferredTimezone),
  );

export const handleCheckAccountHealth = async (
  req: Request,
  // deno-lint-ignore no-explicit-any
  supabase: any,
  userId: string,
  url: URL,
): Promise<Response> =>
  toResponse(
    req,
    await checkAccountHealth(
      defaultPostActionDeps(supabase),
      userId,
      url.searchParams.get("social_account_id"),
    ),
  );
