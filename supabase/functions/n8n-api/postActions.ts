// The use cases behind the n8n API routes for posts and accounts. Each one is a pure
// async function that returns an ActionResult (status + JSON body); toResponse is the
// only adapter that turns one into an HTTP response.
//
// This function runs with the service role, so RLS is not the boundary: every query and
// every write on `posts` carries .eq("user_id", userId), and `platform_posts` is only
// ever reached through a post_id that came out of such a read.
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
  timezone: z.string().max(64).optional(),
});

const BestTimesSchema = z.object({
  platforms: z.array(z.string().min(1).max(50)).min(1).max(12),
});

const RETRY_TIMEOUT_MS = 120_000;
const BEST_TIMES_TIMEOUT_MS = 60_000;

// How long an ambiguous retry keeps the post closed. It is longer than
// process-post can run, so when the hold expires the earlier publish cannot still
// be in flight.
const RETRY_HOLD_MS = 15 * 60_000;

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

// ── shared: claiming a post ───────────────────────────────────────────────────
//
// A retry and a delete both take the post away from everybody else while they
// work. The claim is a compare-and-set on the status that was read first, so two
// callers can never hold the same post at the same time, and a post that changed
// underneath them is refused instead of overwritten.

interface LockOutcome {
  /** The claim landed: this caller owns the post until it releases it. */
  locked: boolean;
  /** The claim could not be written at all. */
  failed: boolean;
}

async function lockPost(
  deps: PostActionDeps,
  route: string,
  request: { postId: string; userId: string; status: string },
): Promise<LockOutcome> {
  const { data, error: readError } = await deps.supabase
    .from("posts")
    .update({ status: "processing" })
    .eq("id", request.postId)
    .eq("user_id", request.userId)
    .eq("status", request.status)
    .select("id");

  if (readError) {
    console.error(
      `[n8n-api] ${route}: locking post ${request.postId} failed: ${readError.message}`,
    );
    return { locked: false, failed: true };
  }
  return { locked: Array.isArray(data) && data.length > 0, failed: false };
}

// Gives the post back to the status it had before the claim. Never throws: a
// failure here must not replace the answer the caller is about to receive.
async function releaseLock(
  deps: PostActionDeps,
  postId: string,
  userId: string,
  previousStatus: string,
): Promise<void> {
  const { error: readError } = await deps.supabase
    .from("posts")
    .update({ status: previousStatus })
    .eq("id", postId)
    .eq("user_id", userId)
    .eq("status", "processing");

  if (readError) {
    console.error(
      `[n8n-api] posts: restoring the status of post ${postId} failed: ${readError.message}`,
    );
  }
}

// Gives the post back to the status it had before the claim and records a hold on
// it: the retry that is being given up may still be publishing, and a hold is what
// keeps a second retry or a delete away from that post until the earlier publish
// cannot still be running. Never throws: a failure here must not replace the
// answer the caller is about to receive.
async function releaseLockWithHold(
  deps: PostActionDeps,
  request: {
    postId: string;
    userId: string;
    previousStatus: string;
    metadata: Record<string, unknown> | null | undefined;
  },
): Promise<string> {
  const holdUntil = new Date(deps.now().getTime() + RETRY_HOLD_MS).toISOString();
  try {
    const { error: holdError } = await deps.supabase
      .from("posts")
      .update({
        status: request.previousStatus,
        metadata: {
          ...(request.metadata ?? {}),
          retry_hold_until: holdUntil,
        },
      })
      .eq("id", request.postId)
      .eq("user_id", request.userId)
      .eq("status", "processing");

    if (holdError) {
      console.error(
        `[n8n-api] posts: recording the retry hold on post ${request.postId} failed: ${holdError.message}`,
      );
    }
  } catch (thrown) {
    console.error(
      `[n8n-api] posts: recording the retry hold on post ${request.postId} failed: ${thrown instanceof Error ? thrown.name : "unknown"}`,
    );
  }
  return holdUntil;
}

// The per-platform results of one post. The post_id comes from a read that was
// scoped to the caller, and that is the only thing that links these rows to them.
async function readPlatformResults(
  deps: PostActionDeps,
  route: string,
  postId: string,
  columns: string,
): Promise<PlatformResultRow[] | ActionResult> {
  const { data, error: readError } = await deps.supabase
    .from("platform_posts")
    .select(columns)
    .eq("post_id", postId);

  if (readError) {
    console.error(
      `[n8n-api] ${route}: reading the platform results of post ${postId} failed: ${readError.message}`,
    );
    return error(500, "INTERNAL_ERROR", "Reading the publish results failed. Please try again.");
  }
  return Array.isArray(data) ? (data as PlatformResultRow[]) : [];
}

// Removes the platform_posts rows of a post by id. Returns the warning the caller
// has to show when the rows could not be cleared.
async function clearDeletedResults(
  deps: PostActionDeps,
  route: string,
  request: { postId: string; rowIds: string[]; warning: string },
): Promise<string | null> {
  if (request.rowIds.length === 0) return null;
  const { error: readError } = await deps.supabase
    .from("platform_posts")
    .delete()
    .eq("post_id", request.postId)
    .in("id", request.rowIds);

  if (!readError) return null;
  console.error(
    `[n8n-api] ${route}: clearing the results of post ${request.postId} failed: ${readError.message}`,
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
  const { post_id: postId, scheduled_at: scheduledAt, timezone } = parsed.data;
  if (!isValidUuid(postId)) {
    return refuse(route, `post unknown, user ${userId}`, invalidPostId());
  }
  const subject = `post ${postId}, user ${userId}`;
  const now = deps.now();

  const invalid = rescheduleRefusal({
    route,
    subject,
    scheduledAt,
    timezone,
    now,
  });
  if (invalid) return invalid;

  const read = await readOwnedPost(deps, route, postId, userId, "id, status, scheduled_at, metadata");
  if (isActionResult(read)) return read;
  const post = read;

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

  const payload: Record<string, unknown> = {
    scheduled_at: new Date(scheduledAt).toISOString(),
  };
  if (timezone !== undefined) {
    payload.metadata = { ...(post.metadata ?? {}), timezone };
  }

  const updated = await rescheduleRow(deps, route, { postId, userId, payload, now });
  if (isActionResult(updated)) return refuseOrFail(route, subject, updated);

  return ok({ post: updated.post, previous_scheduled_at: post.scheduled_at });
}

// The body of a reschedule is checked before the post is even read: a time that
// cannot be published is the caller's mistake, not the post's state.
function rescheduleRefusal(request: {
  route: string;
  subject: string;
  scheduledAt: string;
  timezone: string | undefined;
  now: Date;
}): ActionResult | null {
  const { route, subject, scheduledAt, timezone, now } = request;
  if (!EXPLICIT_OFFSET_RE.test(scheduledAt) || !Number.isFinite(Date.parse(scheduledAt))) {
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
  // The timezone is a label for the UI, not a conversion: the instant is what publishes.
  if (timezone !== undefined && !isValidTimeZone(timezone)) {
    return refuse(
      route,
      subject,
      error(
        400,
        "INVALID_TIMEZONE",
        `'${timezone}' is not an IANA time zone such as America/New_York.`,
      ),
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

// ── 3. posts/retry ─────────────────────────────────────────────────────────────

const POST_PROCESSING = error(
  409,
  "POST_PROCESSING",
  "The post is publishing right now. Try again when it has finished.",
);

const NO_ACCOUNT_REASON =
  "No account is recorded for this result; retry it from the Postora dashboard.";
const ALREADY_PUBLISHED_REASON = "This account already published this post.";
const STILL_PUBLISHING_REASON = "A publish for this account is still in progress.";
const OLD_RESULTS_WARNING =
  "Old failed results could not be cleared; get_post may show them next to the new ones.";

interface NotRetried {
  platform: string;
  reason: string;
}

interface RetryTarget {
  platform: string;
  social_account_id: string | null;
}

interface RetryRequest {
  postId: string;
  userId: string;
  previousStatus: string;
  /** The metadata the post carried, so a hold can be written without losing it. */
  metadata: Record<string, unknown> | null | undefined;
  targets: PlatformResultRow[];
  notRetried: NotRetried[];
}

// The failed rows of one post, split into the ones that may be published again and
// the ones that must not be. A row is a target only when its account has neither a
// success row nor a pending row on the same post: an account that already published
// must never be posted twice, and one that is still in flight must be left alone.
function pickRetryTargets(rows: PlatformResultRow[]): {
  targets: PlatformResultRow[];
  notRetried: NotRetried[];
} {
  const published = new Set<string>();
  const inFlight = new Set<string>();
  for (const row of rows) {
    const account = row.social_account_id;
    if (!account) continue;
    if (row.status === "success") published.add(account);
    if (row.status === "pending") inFlight.add(account);
  }

  const targets: PlatformResultRow[] = [];
  const notRetried: NotRetried[] = [];
  for (const row of rows) {
    if (row.status !== "failed") continue;
    const account = row.social_account_id;
    if (!account) {
      notRetried.push({ platform: row.platform, reason: NO_ACCOUNT_REASON });
    } else if (published.has(account)) {
      notRetried.push({ platform: row.platform, reason: ALREADY_PUBLISHED_REASON });
    } else if (inFlight.has(account)) {
      notRetried.push({ platform: row.platform, reason: STILL_PUBLISHING_REASON });
    } else {
      targets.push(row);
    }
  }
  return { targets, notRetried };
}

export async function retryFailedPost(
  deps: PostActionDeps,
  userId: string,
  body: unknown,
): Promise<ActionResult> {
  const route = "posts/retry";
  const postId = requirePostId(body);
  if (typeof postId !== "string") {
    return refuse(route, `post unknown, user ${userId}`, postId);
  }
  const subject = `post ${postId}, user ${userId}`;

  const read = await readOwnedPost(deps, route, postId, userId, "id, status, scheduled_at, metadata");
  if (isActionResult(read)) return read;
  const post = read;

  const guard = retryGuard(route, subject, post, deps.now());
  if (guard) return guard;

  // The lock comes before the results are read: two retries that read the same
  // failed rows before either locked would publish them twice, and the second one
  // would do it from a snapshot that is already stale.
  const lock = await lockPost(deps, route, { postId, userId, status: post.status });
  if (lock.failed) {
    return error(500, "INTERNAL_ERROR", "Starting the retry failed. Please try again.");
  }
  if (!lock.locked) return refuse(route, subject, POST_PROCESSING);

  const picked = await pickTargetsUnderLock(deps, route, {
    postId,
    userId,
    previousStatus: post.status,
    subject,
  });
  if (isActionResult(picked)) return picked;

  return reportRetry(deps, route, {
    postId,
    userId,
    previousStatus: post.status,
    metadata: post.metadata,
    targets: picked.targets,
    notRetried: picked.notRetried,
  });
}

// Reads the results of the post while the claim is held and splits them into the
// rows that may be published again and the rows that must not be.
async function pickTargetsUnderLock(
  deps: PostActionDeps,
  route: string,
  request: {
    postId: string;
    userId: string;
    previousStatus: string;
    subject: string;
  },
): Promise<{ targets: PlatformResultRow[]; notRetried: NotRetried[] } | ActionResult> {
  const results = await readPlatformResults(
    deps,
    route,
    request.postId,
    "id, platform, status, social_account_id",
  );
  if (isActionResult(results)) {
    await releaseLock(deps, request.postId, request.userId, request.previousStatus);
    return results;
  }

  const picked = pickRetryTargets(results);
  if (picked.targets.length === 0) {
    await releaseLock(deps, request.postId, request.userId, request.previousStatus);
    return refuse(
      route,
      request.subject,
      error(
        409,
        "NO_FAILED_PLATFORMS",
        "This post has no failed platforms to retry.",
        picked.notRetried.length > 0 ? { not_retried: picked.notRetried } : undefined,
      ),
    );
  }
  return picked;
}

// A retry is only allowed on a post that is neither publishing right now nor
// waiting for its scheduled time.
function retryGuard(
  route: string,
  subject: string,
  post: PostRow,
  now: Date,
): ActionResult | null {
  if (post.status === "processing") return refuse(route, subject, POST_PROCESSING);
  const inDoubt = retryInDoubt(route, subject, post, now, "try again");
  if (inDoubt) return inDoubt;
  if (isFutureScheduled(post, now)) {
    return refuse(
      route,
      subject,
      error(
        409,
        "POST_NOT_DUE",
        "This post is scheduled for the future and has not been published yet.",
      ),
    );
  }
  return null;
}

// The hold an earlier ambiguous retry left on the post: the instant until which
// that retry may still be publishing. It lives on the post's metadata, so it
// outlives the claim that was taken for the retry.
function retryHoldUntil(post: PostRow): string | null {
  const value = post.metadata?.retry_hold_until;
  if (typeof value !== "string") return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

// A post under a hold is not free to be published or deleted: the earlier retry
// may still be running, and process-post writes its platform_posts rows only after
// the provider call, so a second publish or a delete would either publish the same
// account twice or orphan the result that the earlier retry is about to write.
function retryInDoubt(
  route: string,
  subject: string,
  post: PostRow,
  now: Date,
  action: "try again" | "delete",
): ActionResult | null {
  const holdUntil = retryHoldUntil(post);
  if (!holdUntil || !(Date.parse(holdUntil) > now.getTime())) return null;
  return refuse(
    route,
    subject,
    error(
      409,
      "RETRY_IN_DOUBT",
      `An earlier retry may still be publishing. Check get_post, and ${action} after ${holdUntil}.`,
      { retry_hold_until: holdUntil },
    ),
  );
}

type RetryDispatch =
  | { kind: "accepted"; body: Record<string, unknown> | null }
  | { kind: "timeout" }
  | { kind: "unknown" }
  | { kind: "refused"; body: Record<string, unknown> | null };

async function dispatchRetry(
  deps: PostActionDeps,
  request: { postId: string; targets: PlatformResultRow[] },
): Promise<RetryDispatch> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${deps.supabaseUrl}/functions/v1/process-post`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${deps.serviceRoleKey}`,
        },
        // The retry starts from a post that already published, so there is no
        // scheduled_at expectation to carry: process-post must claim the row
        // unconditionally.
        body: JSON.stringify({
          post_id: request.postId,
          platforms: distinct(request.targets.map((row) => row.platform)),
          account_ids: distinct(request.targets.map((row) => row.social_account_id)),
        }),
      },
      RETRY_TIMEOUT_MS,
      deps.fetcher,
    );
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    // A timeout means the publish is still running; any other transport error
    // leaves it unknown whether the request ever reached process-post.
    return message === "Request timed out" ? { kind: "timeout" } : { kind: "unknown" };
  }
  const json = await response.json().catch(() => null) as Record<string, unknown> | null;
  return response.ok ? { kind: "accepted", body: json } : { kind: "refused", body: json };
}

async function reportRetry(
  deps: PostActionDeps,
  route: string,
  request: RetryRequest,
): Promise<ActionResult> {
  const retried = request.targets.map((row) => ({
    platform: row.platform,
    social_account_id: row.social_account_id,
  }));
  const rowIds = request.targets.map((row) => row.id);
  const outcome = await dispatchRetry(deps, {
    postId: request.postId,
    targets: request.targets,
  });

  if (outcome.kind === "unknown") {
    // The request may never have reached process-post, and it may be publishing
    // right now. The claim is released, or the post would stay `processing` and
    // refuse every later retry and delete, but a hold on the row keeps a second
    // retry and a delete away until the earlier publish cannot still be running.
    const holdUntil = await releaseLockWithHold(deps, {
      postId: request.postId,
      userId: request.userId,
      previousStatus: request.previousStatus,
      metadata: request.metadata,
    });
    return ok(unknownRetryBody(request.postId, retried, holdUntil), 202);
  }
  if (outcome.kind === "timeout") {
    return ok(
      await pendingRetryBody(deps, route, { postId: request.postId, rowIds, retried }),
      202,
    );
  }
  if (outcome.kind === "refused") {
    // process-post refused before it published anything, so the old failed rows
    // stay and the post goes back to the status it had.
    await releaseLock(deps, request.postId, request.userId, request.previousStatus);
    return error(
      502,
      "RETRY_FAILED",
      `Retry failed: ${safeProcessPostReason(outcome.body?.error)}`,
    );
  }

  const warning = await clearDeletedResults(deps, route, {
    postId: request.postId,
    rowIds,
    warning: OLD_RESULTS_WARNING,
  });
  return ok(acceptedRetryBody({
    postId: request.postId,
    retried,
    notRetried: request.notRetried,
    body: outcome.body,
    warning,
  }));
}

// The request may or may not have reached process-post. The claim is released
// before this answer goes out, because a post that stays `processing` refuses
// every later retry and delete; that release is safe because it only flips a row
// that is still `processing`, so a publish that did start settles the status
// itself. The release also records a hold on the row: the publish that may be
// running right now writes its platform_posts rows only after the provider call,
// so nothing on the post says that it is still going. The hold is what keeps a
// second retry and a delete away from that publish until it cannot still be
// running. The old failed rows stay: an account that did publish is skipped by
// pickRetryTargets, so a later retry cannot publish it twice.
function unknownRetryBody(
  postId: string,
  retried: RetryTarget[],
  holdUntil: string,
): Record<string, unknown> {
  return {
    post_id: postId,
    dispatched: "unknown",
    results_pending: true,
    retried,
    retry_hold_until: holdUntil,
    message:
      `The retry may or may not have started. Further retries and deletes are paused until ${holdUntil}; check get_post.`,
  };
}

async function pendingRetryBody(
  deps: PostActionDeps,
  route: string,
  request: { postId: string; rowIds: string[]; retried: RetryTarget[] },
): Promise<Record<string, unknown>> {
  // The publish is still running; only this answer was slow. The old rows go now
  // that process-post has the request and writes fresh ones for them.
  const warning = await clearDeletedResults(deps, route, {
    postId: request.postId,
    rowIds: request.rowIds,
    warning: OLD_RESULTS_WARNING,
  });
  return {
    post_id: request.postId,
    dispatched: true,
    results_pending: true,
    retried: request.retried,
    message: "Retry started but publishing is still running. Check get_post for the results.",
    ...(warning ? { warning } : {}),
  };
}

function acceptedRetryBody(request: {
  postId: string;
  retried: RetryTarget[];
  notRetried: NotRetried[];
  body: Record<string, unknown> | null;
  warning: string | null;
}): Record<string, unknown> {
  const bodyResults = request.body?.platform_results;
  const platformResults = Array.isArray(bodyResults) ? bodyResults : [];
  return {
    post_id: request.postId,
    status: request.body?.status ?? null,
    retried: request.retried,
    not_retried: request.notRetried,
    platform_results: platformResults.map(toPublicPlatformResult),
    ...(request.warning ? { warning: request.warning } : {}),
  };
}

function safeProcessPostReason(reason: unknown): string {
  return typeof reason === "string" && !containsSensitiveInfo(reason)
    ? reason
    : "process-post rejected the retry";
}

function toPublicPlatformResult(entry: unknown): Record<string, unknown> {
  const result = (entry ?? {}) as Record<string, unknown>;
  const failure = result.error_message;
  return {
    platform: result.platform,
    status: result.status,
    post_url: result.platform_post_url ?? null,
    error_message: typeof failure === "string" && !containsSensitiveInfo(failure)
      ? failure
      : (failure ? "redacted" : null),
  };
}

// ── 4. posts/delete ────────────────────────────────────────────────────────────

const POST_PROCESSING_DELETE = error(
  409,
  "POST_PROCESSING",
  "The post is publishing right now. Delete it when it has finished.",
);

const POST_STATE_CHANGED_DELETE = error(
  409,
  "POST_STATE_CHANGED",
  "The post changed while it was being deleted. Check get_post.",
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

  const read = await readOwnedPost(deps, route, postId, userId, "id, status, metadata");
  if (isActionResult(read)) return read;
  const post = read;
  if (post.status === "processing") return refuse(route, subject, POST_PROCESSING_DELETE);

  // The hold of an earlier ambiguous retry: the retry may still be publishing, and
  // its result row does not exist yet, so deleting the record now would orphan
  // the result it is about to write.
  const inDoubt = retryInDoubt(route, subject, post, deps.now(), "delete");
  if (inDoubt) return inDoubt;

  // The claim comes before anything is deleted: a retry that lands in the middle of
  // a delete would publish a fresh result that the record delete would orphan.
  const claim = await lockPost(deps, route, {
    postId,
    userId,
    status: post.status,
  });
  if (claim.failed) {
    return error(500, "INTERNAL_ERROR", "Starting the delete failed. Please try again.");
  }
  if (!claim.locked) return refuse(route, subject, POST_STATE_CHANGED_DELETE);

  const state = await deletePublishedResults(deps, route, {
    postId,
    userId,
    previousStatus: post.status,
  });
  if (isActionResult(state)) return state;

  if (state.failed && !options.delete_record_if_platform_fails) {
    return keepRecord(deps, route, {
      ...state,
      status: 422,
      code: "PLATFORM_DELETE_FAILED",
      message: PLATFORM_DELETE_FAILED_MESSAGE,
    });
  }

  return deleteOrKeepRecord(deps, route, state);
}

interface DeleteState {
  postId: string;
  userId: string;
  previousStatus: string;
  report: Array<Record<string, unknown>>;
  deletedRowIds: string[];
  failed: boolean;
}

// Deletes the published copies of the post on their platforms and reports what
// happened to each of them. The claim is held while this runs.
async function deletePublishedResults(
  deps: PostActionDeps,
  route: string,
  state: { postId: string; userId: string; previousStatus: string },
): Promise<DeleteState | ActionResult> {
  const results = await readPlatformResults(
    deps,
    route,
    state.postId,
    "id, platform, status, platform_post_id, social_account_id, response_data",
  );
  if (isActionResult(results)) {
    await releaseLock(deps, state.postId, state.userId, state.previousStatus);
    return results;
  }

  const published = results.filter((row) => row.status === "success");
  const accountById = await loadPublishingAccounts(deps, route, {
    postId: state.postId,
    userId: state.userId,
    accountIds: distinct(published.map((row) => row.social_account_id)),
  });
  if (isActionResult(accountById)) {
    await releaseLock(deps, state.postId, state.userId, state.previousStatus);
    return accountById;
  }

  const { report, deletedRowIds } = await deleteOnPlatforms(deps, published, accountById);
  return {
    ...state,
    report,
    deletedRowIds,
    failed: report.some((item) => item.outcome === "failed"),
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

async function deleteOnPlatforms(
  deps: PostActionDeps,
  published: PlatformResultRow[],
  accountById: Map<string, DeleteAccount>,
): Promise<{ report: Array<Record<string, unknown>>; deletedRowIds: string[] }> {
  const report: Array<Record<string, unknown>> = [];
  // The platform_posts row ids that were deleted on the platform, so a retry does not
  // try them again. Kept beside the report instead of inside it: the report is the
  // caller's contract.
  const deletedRowIds: string[] = [];
  // One platform at a time: a provider that rate-limits is told about one delete, not
  // about a burst of them.
  for (const row of published) {
    const publishedRow: PublishedPlatformPost = {
      id: row.id,
      platform: row.platform,
      platform_post_id: row.platform_post_id ?? null,
      social_account_id: row.social_account_id ?? null,
      response_data: row.response_data ?? null,
    };
    const outcome: PlatformDeleteOutcome = await deletePublishedPost(
      publishedRow,
      row.social_account_id ? accountById.get(row.social_account_id) ?? null : null,
      { fetcher: deps.fetcher, youtubeDeps: deps.youtubeDeps },
    );
    if (outcome.outcome === "deleted") deletedRowIds.push(row.id);
    const item: Record<string, unknown> = {
      platform: row.platform,
      platform_post_id: row.platform_post_id ?? null,
      social_account_id: row.social_account_id ?? null,
      outcome: outcome.outcome,
      deleted_on_platform: outcome.outcome === "deleted",
    };
    if (outcome.outcome === "deleted") {
      if (outcome.note) item.note = outcome.note;
    } else {
      item.reason = outcome.reason;
    }
    report.push(item);
  }
  return { report, deletedRowIds };
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
  // The claim is the condition: the row can only go while this delete holds it.
  const { data, error: readError } = await deps.supabase
    .from("posts")
    .delete()
    .eq("id", request.postId)
    .eq("user_id", request.userId)
    .eq("status", "processing")
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

// Removes the Postora record now that its platform copies are gone, or keeps it
// (and gives the claim back) when that cannot be done.
async function deleteOrKeepRecord(
  deps: PostActionDeps,
  route: string,
  state: DeleteState,
): Promise<ActionResult> {
  const deletion = await deleteRecord(deps, route, {
    postId: state.postId,
    userId: state.userId,
  });
  if (deletion.kind === "deleted") {
    // The media files stay in the library: they may be attached to another post, and
    // a library entry is not part of "this post".
    return ok({
      post_id: state.postId,
      record_deleted: true,
      media_kept_in_library: true,
      platforms: state.report,
      ...(state.failed ? { kept_despite_failures: true } : {}),
    });
  }
  return keepRecord(deps, route, {
    ...state,
    status: deletion.kind === "error" ? 500 : 409,
    code: deletion.kind === "error" ? "INTERNAL_ERROR" : "POST_STATE_CHANGED",
    message: deletion.kind === "error"
      ? "Deleting the Postora record failed. Please try again."
      : "The post changed while it was being deleted. Check get_post.",
  });
}

// The Postora record is kept, so the caller can try again. The rows that DID delete
// on the platform are cleared (a retry must not call the platform again), and the
// claim is given back so the post is not stuck in `processing`.
async function keepRecord(
  deps: PostActionDeps,
  route: string,
  request: DeleteState & { status: number; code: string; message: string },
): Promise<ActionResult> {
  const warning = await clearDeletedResults(deps, route, {
    postId: request.postId,
    rowIds: request.deletedRowIds,
    warning: CLEARED_ROWS_WARNING,
  });
  await releaseLock(deps, request.postId, request.userId, request.previousStatus);

  const details: Record<string, unknown> = {
    record_deleted: false,
    platforms: request.report,
  };
  if (warning) details.warning = warning;
  return refuseOrFail(
    route,
    `post ${request.postId}, user ${request.userId}`,
    error(request.status, request.code, request.message, details),
  );
}

// ── 5. accounts/health ─────────────────────────────────────────────────────────

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

// ── 6. best-times ──────────────────────────────────────────────────────────────

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

export const handleRetryFailedPost = async (
  req: Request,
  // deno-lint-ignore no-explicit-any
  supabase: any,
  userId: string,
  body: unknown,
): Promise<Response> =>
  toResponse(req, await retryFailedPost(defaultPostActionDeps(supabase), userId, body));

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
