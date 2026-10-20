// The use cases behind the n8n API routes for posts and accounts. Each one is a pure
// async function that returns an ActionResult (status + JSON body); toResponse is the
// only adapter that turns one into an HTTP response.
//
// This function runs with the service role, so RLS is not the boundary: every query and
// every write on `posts` carries .eq("user_id", userId), and `platform_posts` is only
// ever touched through row ids that came out of a read scoped the same way.
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

interface PostRow {
  id: string;
  status: string;
  scheduled_at: string | null;
  metadata?: Record<string, unknown> | null;
  platform_posts?: PlatformResultRow[] | null;
}

interface PlatformResultRow {
  id: string;
  platform: string;
  status: string;
  social_account_id: string | null;
  platform_post_id?: string | null;
  response_data?: unknown;
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

  const { data, error: readError } = await deps.supabase
    .from("posts")
    .select("id, status, scheduled_at")
    .eq("id", postId)
    .eq("user_id", userId)
    .maybeSingle();

  if (readError) {
    console.error(`[n8n-api] ${route}: reading post ${postId} failed: ${readError.message}`);
    return error(500, "INTERNAL_ERROR", "Reading the post failed. Please try again.");
  }
  if (!data) return refuse(route, subject, NOT_FOUND);

  const post = data as PostRow;
  if (!isFutureScheduled(post, now)) {
    return refuse(
      route,
      subject,
      error(
        409,
        "POST_NOT_SCHEDULED",
        "Only a scheduled post whose time has not come yet can be cancelled.",
        { status: post.status, scheduled_at: post.scheduled_at },
      ),
    );
  }

  // Compare-and-set: the scheduler claims the same row by flipping it to `processing`,
  // so the delete only lands while the post is still scheduled for the future. The
  // platform_posts rows go with it through the existing ON DELETE CASCADE.
  const { data: deleted, error: deleteError } = await deps.supabase
    .from("posts")
    .delete()
    .eq("id", postId)
    .eq("user_id", userId)
    .in("status", SCHEDULED_STATUSES)
    .gt("scheduled_at", now.toISOString())
    .select("id");

  if (deleteError) {
    console.error(`[n8n-api] ${route}: deleting post ${postId} failed: ${deleteError.message}`);
    return error(500, "INTERNAL_ERROR", "Cancelling the post failed. Please try again.");
  }
  if (!deleted || deleted.length === 0) {
    return refuse(
      route,
      subject,
      error(
        409,
        "POST_STATE_CHANGED",
        "The post changed while it was being cancelled (it may already be publishing). Check get_post.",
      ),
    );
  }

  return ok({ post_id: postId, cancelled: true });
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

  const { data, error: readError } = await deps.supabase
    .from("posts")
    .select("id, status, scheduled_at, metadata")
    .eq("id", postId)
    .eq("user_id", userId)
    .maybeSingle();

  if (readError) {
    console.error(`[n8n-api] ${route}: reading post ${postId} failed: ${readError.message}`);
    return error(500, "INTERNAL_ERROR", "Reading the post failed. Please try again.");
  }
  if (!data) return refuse(route, subject, NOT_FOUND);

  const post = data as PostRow;
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

  const { data: rows, error: updateError } = await deps.supabase
    .from("posts")
    .update(payload)
    .eq("id", postId)
    .eq("user_id", userId)
    .in("status", SCHEDULED_STATUSES)
    .gt("scheduled_at", now.toISOString())
    .select("id, status, scheduled_at");

  if (updateError) {
    console.error(`[n8n-api] ${route}: updating post ${postId} failed: ${updateError.message}`);
    return error(500, "INTERNAL_ERROR", "Rescheduling the post failed. Please try again.");
  }
  if (!rows || rows.length === 0) {
    return refuse(
      route,
      subject,
      error(
        409,
        "POST_STATE_CHANGED",
        "The post changed while it was being rescheduled (it may already be publishing). Check get_post.",
      ),
    );
  }

  return ok({ post: rows[0], previous_scheduled_at: post.scheduled_at });
}

// ── 3. posts/retry ─────────────────────────────────────────────────────────────

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
  const now = deps.now();

  const { data, error: readError } = await deps.supabase
    .from("posts")
    .select("id, status, scheduled_at, platform_posts(id, platform, status, social_account_id)")
    .eq("id", postId)
    .eq("user_id", userId)
    .maybeSingle();

  if (readError) {
    console.error(`[n8n-api] ${route}: reading post ${postId} failed: ${readError.message}`);
    return error(500, "INTERNAL_ERROR", "Reading the post failed. Please try again.");
  }
  if (!data) return refuse(route, subject, NOT_FOUND);

  const post = data as PostRow;
  if (post.status === "processing") {
    return refuse(
      route,
      subject,
      error(
        409,
        "POST_PROCESSING",
        "The post is publishing right now. Try again when it has finished.",
      ),
    );
  }
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

  const results: PlatformResultRow[] = Array.isArray(post.platform_posts)
    ? post.platform_posts
    : [];
  const failedRows = results.filter((row) => row.status === "failed");
  const hasAccount = (row: PlatformResultRow) =>
    typeof row.social_account_id === "string" && row.social_account_id.length > 0;
  // Only the failed rows go: a platform that already succeeded must never be posted
  // twice, so the retry asks process-post for exactly these platforms and accounts.
  const retryable = failedRows.filter(hasAccount);
  const notRetried = failedRows
    .filter((row) => !hasAccount(row))
    .map((row) => ({
      platform: row.platform,
      reason: "No account is recorded for this result; retry it from the Postora dashboard.",
    }));

  if (retryable.length === 0) {
    return refuse(
      route,
      subject,
      error(
        409,
        "NO_FAILED_PLATFORMS",
        "This post has no failed platforms to retry.",
        notRetried.length > 0 ? { not_retried: notRetried } : undefined,
      ),
    );
  }

  // Lock the post first: two retries landing together must not publish twice.
  const { data: locked, error: lockError } = await deps.supabase
    .from("posts")
    .update({ status: "processing" })
    .eq("id", postId)
    .eq("user_id", userId)
    .neq("status", "processing")
    .select("id");

  if (lockError) {
    console.error(`[n8n-api] ${route}: locking post ${postId} failed: ${lockError.message}`);
    return error(500, "INTERNAL_ERROR", "Starting the retry failed. Please try again.");
  }
  if (!locked || locked.length === 0) {
    return refuse(
      route,
      subject,
      error(
        409,
        "POST_PROCESSING",
        "The post is publishing right now. Try again when it has finished.",
      ),
    );
  }

  const retryableIds = retryable.map((row) => row.id);
  const { error: cleanupError } = await deps.supabase
    .from("platform_posts")
    .delete()
    .eq("post_id", postId)
    .in("id", retryableIds)
    .select("id");

  if (cleanupError) {
    console.error(`[n8n-api] ${route}: clearing failed results for post ${postId} failed: ${cleanupError.message}`);
    // The lock is released again, otherwise the post would sit in `processing` forever.
    const { error: restoreError } = await deps.supabase
      .from("posts")
      .update({ status: post.status })
      .eq("id", postId)
      .eq("user_id", userId);
    if (restoreError) {
      console.error(`[n8n-api] posts/retry: restoring the status of post ${postId} failed: ${restoreError.message}`);
    }
    return error(500, "INTERNAL_ERROR", "Preparing the retry failed. Please try again.");
  }

  const retried = retryable.map((row) => ({
    platform: row.platform,
    social_account_id: row.social_account_id,
  }));

  // The retry starts from a post that already published, so there is no scheduled_at
  // expectation to carry: process-post must claim the row unconditionally.
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
        body: JSON.stringify({
          post_id: postId,
          platforms: distinct(retryable.map((row) => row.platform)),
          account_ids: distinct(retryable.map((row) => row.social_account_id)),
        }),
      },
      RETRY_TIMEOUT_MS,
      deps.fetcher,
    );
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    if (message === "Request timed out") {
      // The publish is still running; only this answer was slow.
      return ok(
        {
          post_id: postId,
          dispatched: true,
          results_pending: true,
          retried,
          message: "Retry started but publishing is still running. Check get_post for the results.",
        },
        202,
      );
    }
    console.error(`[n8n-api] ${route}: dispatching the retry for post ${postId} failed`);
    await markFailedIfProcessing(deps, postId, userId);
    return error(502, "RETRY_DISPATCH_FAILED", "Could not start the retry. Try again.");
  }

  const json = await response.json().catch(() => null) as Record<string, unknown> | null;

  if (!response.ok) {
    await markFailedIfProcessing(deps, postId, userId);
    const reason = json?.error;
    const safe = typeof reason === "string" && !containsSensitiveInfo(reason)
      ? reason
      : "process-post rejected the retry";
    return error(502, "RETRY_FAILED", `Retry failed: ${safe}`);
  }

  const platformResults = Array.isArray(json?.platform_results) ? json.platform_results : [];
  return ok({
    post_id: postId,
    status: json?.status ?? null,
    retried,
    not_retried: notRetried,
    platform_results: platformResults.map((entry) => {
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
    }),
  });
}

// Puts the post back to `failed` when the retry never started. Never throws: a failure
// here must not replace the error the caller is about to receive.
async function markFailedIfProcessing(
  deps: PostActionDeps,
  postId: string,
  userId: string,
): Promise<void> {
  const { error: markError } = await deps.supabase
    .from("posts")
    .update({ status: "failed" })
    .eq("id", postId)
    .eq("user_id", userId)
    .eq("status", "processing");

  if (markError) {
    console.error(`[n8n-api] posts/retry: could not mark post ${postId} as failed: ${markError.message}`);
  }
}

// ── 4. posts/delete ────────────────────────────────────────────────────────────

export async function deletePost(
  deps: PostActionDeps,
  userId: string,
  body: unknown,
): Promise<ActionResult> {
  const route = "posts/delete";
  const postId = requirePostId(body);
  if (typeof postId !== "string") {
    return refuse(route, `post unknown, user ${userId}`, postId);
  }
  const subject = `post ${postId}, user ${userId}`;

  const { data, error: readError } = await deps.supabase
    .from("posts")
    .select("id, status, platform_posts(id, platform, status, platform_post_id, social_account_id, response_data)")
    .eq("id", postId)
    .eq("user_id", userId)
    .maybeSingle();

  if (readError) {
    console.error(`[n8n-api] ${route}: reading post ${postId} failed: ${readError.message}`);
    return error(500, "INTERNAL_ERROR", "Reading the post failed. Please try again.");
  }
  if (!data) return refuse(route, subject, NOT_FOUND);

  const post = data as PostRow;
  if (post.status === "processing") {
    return refuse(
      route,
      subject,
      error(
        409,
        "POST_PROCESSING",
        "The post is publishing right now. Delete it when it has finished.",
      ),
    );
  }

  const results: PlatformResultRow[] = Array.isArray(post.platform_posts)
    ? post.platform_posts
    : [];
  const published = results.filter((row) => row.status === "success");
  const accountIds = distinct(published.map((row) => row.social_account_id));

  const accountById = new Map<string, DeleteAccount>();
  if (accountIds.length > 0) {
    const { data: accounts, error: accountsError } = await deps.supabase
      .from("social_accounts")
      .select("id, user_id, platform, access_token, refresh_token, token_expires_at, auth_provider, connection_id, workspace_id, platform_user_id, account_metadata")
      .eq("user_id", userId)
      .in("id", accountIds);

    if (accountsError) {
      console.error(`[n8n-api] ${route}: reading the social accounts for post ${postId} failed: ${accountsError.message}`);
      return error(500, "INTERNAL_ERROR", "Reading the social account failed. Please try again.");
    }
    for (const account of (accounts ?? []) as DeleteAccount[]) {
      accountById.set(account.id, account);
    }
  }

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
    report.push({
      platform: row.platform,
      platform_post_id: row.platform_post_id ?? null,
      social_account_id: row.social_account_id ?? null,
      outcome: outcome.outcome,
      deleted_on_platform: outcome.outcome === "deleted",
      ...(outcome.outcome !== "deleted" ? { reason: outcome.reason } : {}),
    });
  }

  const failed = report.filter((item) => item.outcome === "failed");
  if (failed.length > 0) {
    // The Postora record is kept so the caller can retry. The rows that DID delete are
    // cleared, so a retry does not try them again.
    const details: Record<string, unknown> = { record_deleted: false, platforms: report };
    if (deletedRowIds.length > 0) {
      const { error: clearError } = await deps.supabase
        .from("platform_posts")
        .delete()
        .eq("post_id", postId)
        .in("id", deletedRowIds);
      if (clearError) {
        console.error(`[n8n-api] ${route}: clearing the deleted results of post ${postId} failed: ${clearError.message}`);
        details.warning = "Some deleted platform results could not be cleared; a retry may report them as failed.";
      }
    }
    return refuse(
      route,
      subject,
      error(
        422,
        "PLATFORM_DELETE_FAILED",
        "The post could not be deleted on every platform. The Postora record was kept so you can retry.",
        details,
      ),
    );
  }

  const { data: deleted, error: deleteError } = await deps.supabase
    .from("posts")
    .delete()
    .eq("id", postId)
    .eq("user_id", userId)
    .neq("status", "processing")
    .select("id");

  if (deleteError) {
    console.error(`[n8n-api] ${route}: deleting post ${postId} failed: ${deleteError.message}`);
    return error(
      500,
      "INTERNAL_ERROR",
      "Deleting the Postora record failed. Please try again.",
      { record_deleted: false, platforms: report },
    );
  }
  if (!deleted || deleted.length === 0) {
    return refuse(
      route,
      subject,
      error(
        409,
        "POST_STATE_CHANGED",
        "The post started publishing while it was being deleted. Check get_post.",
        { record_deleted: false, platforms: report },
      ),
    );
  }

  // The media files stay in the library: they may be attached to another post, and a
  // library entry is not part of "this post".
  return ok({
    post_id: postId,
    record_deleted: true,
    media_kept_in_library: true,
    platforms: report,
  });
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
