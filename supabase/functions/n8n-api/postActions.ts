// The use cases behind the n8n API routes for posts and accounts. Each one is a pure
// async function that returns an ActionResult (status + JSON body); toResponse is the
// only adapter that turns one into an HTTP response.
//
// This function runs with the service role, so RLS is not the boundary: every query and
// every write on `posts` carries .eq("user_id", userId).
import { z } from "npm:zod@3.23.8";
import { validateRequestBody } from "../_shared/validate.ts";
import { containsSensitiveInfo } from "../_shared/errorSanitizer.ts";
import { restrictedCorsHeaders } from "../_shared/cors.ts";
import { fetchWithTimeout } from "../_shared/request-timeout.ts";
import { isValidUuid } from "./requestGuards.ts";

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

interface PostRow {
  id: string;
  status: string;
  scheduled_at?: string | null;
  metadata?: Record<string, unknown> | null;
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

// ── 3. accounts/health ─────────────────────────────────────────────────────────

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

// ── 4. best-times ──────────────────────────────────────────────────────────────

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

  // The suggestion service is called with the service role, so it has no user JWT
  // to read the caller from. The id of the API-key owner travels in the body
  // instead, so the AI call is logged against that user and not against nobody.
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
        body: JSON.stringify({ platforms, historicalData, user_id: userId }),
      },
      BEST_TIMES_TIMEOUT_MS,
      deps.fetcher,
    );
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    if (message === "Request timed out") {
      console.error(`[n8n-api] ${route}: the suggestion service did not answer within ${BEST_TIMES_TIMEOUT_MS / 1000}s (user ${userId})`);
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

  // A 2xx with a body that carries no suggestion list is a failed read, not an
  // empty result: answering 200 with no suggestions would tell the caller the
  // service had nothing to say, when in fact it never answered. An empty array
  // from the service is a real answer and stays a 200.
  const json = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (json === null || !Array.isArray(json.suggestions)) {
    console.error(`[n8n-api] ${route}: the suggestion service answered without a suggestions list (user ${userId})`);
    return error(502, "BEST_TIMES_FAILED", "Could not get suggestions right now. Try again.");
  }

  return ok({
    timezone: timeZone,
    based_on_posts: historicalData.totalPosts,
    suggestions: json.suggestions,
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
