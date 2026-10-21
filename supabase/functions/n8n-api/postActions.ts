// The use cases behind the n8n API routes for posts and accounts. Each one is a pure
// async function that returns an ActionResult (status + JSON body); toResponse is the
// only adapter that turns one into an HTTP response.
//
// This function runs with the service role, so RLS is not the boundary: every query and
// every write on `posts` carries .eq("user_id", userId).
//
// A refusal is a decision, not a fault: every route that refuses work writes one
// system_logs row (route, code, status and ids only) before it answers, so a refusal
// nobody watched still leaves a trace.
import { z } from "npm:zod@3.23.8";
import { validateRequestBody } from "../_shared/validate.ts";
import { containsSensitiveInfo } from "../_shared/errorSanitizer.ts";
import { restrictedCorsHeaders } from "../_shared/cors.ts";
import { fetchWithTimeout } from "../_shared/request-timeout.ts";
import { isValidUuid } from "./requestGuards.ts";
import { recordApiRefusal } from "./refusalLog.ts";

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
  /**
   * The deadline for one suggestion call, headers and body together. It is
   * the production default unless a test asks for a shorter wait.
   */
  bestTimesTimeoutMs?: number;
}

export function defaultPostActionDeps(
  // deno-lint-ignore no-explicit-any
  supabase: any,
): PostActionDeps {
  return {
    supabase,
    fetcher: fetch,
    now: () => new Date(),
    // The two secrets are read when they are used, not when the deps are
    // built: a route that only refuses needs the client alone, and its
    // refusal row must not depend on the environment being readable.
    get supabaseUrl() {
      return Deno.env.get("SUPABASE_URL") ?? "";
    },
    get serviceRoleKey() {
      return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    },
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

// Every platform costs one AI call, so the list is short: six platforms are six
// suggestions, not one history shared by six.
const BEST_TIMES_MAX_PLATFORMS = 6;

const BestTimesSchema = z.object({
  platforms: z.array(z.string().min(1).max(50)).min(1).max(BEST_TIMES_MAX_PLATFORMS),
});

const BEST_TIMES_TIMEOUT_MS = 60_000;

// The body of the answer did not arrive in time. It is an error of its own so
// that a body that never comes is not mistaken for a body that could not be
// read: the first is a service that did not answer, the second is a service
// that answered with something broken.
class SuggestionTimeout extends Error {
  constructor() {
    super("Request timed out");
    this.name = "SuggestionTimeout";
  }
}

// The body of the answer, when it is a JSON object, and null when it is not
// one. A body that is not JSON at all is a failed read, not an empty result.
function parseJsonObject(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  return parsed as Record<string, unknown>;
}

// The body of the answer, before the deadline runs out. A body that never
// arrives is a timeout, and a body that could not be read is a failure: the
// two are told apart, because a service that did not answer and a service that
// answered with something broken are not the same fault.
//
// The deadline also cancels the body it did not get. A service that stalls
// after its headers arrived would otherwise keep the connection open long
// after the caller was answered 504.
type BodyRead =
  | { kind: "ok"; text: string }
  | { kind: "timeout" }
  | { kind: "failed" };

// The whole body, read chunk by chunk. The body is read through an explicit
// reader and not through response.text(): a read that runs into the deadline
// has to be cancellable, and a body that response.text() has locked cannot be
// cancelled any more.
async function readWholeBody(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
): Promise<string> {
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let chunk = await reader.read();
  while (!chunk.done) {
    // A chunk can end in the middle of a character, so the decoder keeps what
    // is left of it until a later chunk says more.
    text += decoder.decode(chunk.value, { stream: true });
    chunk = await reader.read();
  }
  // The last characters of the body are flushed here: the decoder was still
  // holding them.
  return text + decoder.decode();
}

// The body is given up, so the connection to the service is released: a
// service that never answers must not keep it open behind the answer the
// caller already got. The cancel goes through the reader, because the reader
// is what holds the body, and a body that is locked cannot be cancelled any
// other way. A cancel that fails is not a new failure: the caller is
// answered 504 either way.
async function cancelBody(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
): Promise<void> {
  if (!reader) return;
  try {
    await reader.cancel();
  } catch {
    // Swallowed on purpose: cancelling must never turn the timeout into
    // another error.
  }
}

async function readBodyBeforeDeadline(
  response: Response,
  remainingMs: number,
): Promise<BodyRead> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The reader is taken inside the try: a body that was read already throws
    // here, and that is a failed read like any other.
    reader = response.body?.getReader();
    const text = await Promise.race([
      readWholeBody(reader),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SuggestionTimeout()), remainingMs);
      }),
    ]);
    return { kind: "ok", text };
  } catch (thrown) {
    if (thrown instanceof SuggestionTimeout) {
      // The body is cancelled before the 504 goes out, so a stalled service
      // does not keep the connection open behind the answer.
      await cancelBody(reader);
      return { kind: "timeout" };
    }
    return { kind: "failed" };
  } finally {
    // The timer is cleared either way: a deadline nobody waits for any more
    // must not keep the edge awake.
    if (timer !== undefined) clearTimeout(timer);
  }
}

// A scheduled time has to be a whole instant. A date with nothing else
// ("2027-01-01Z") is read by Date.parse as midnight, and an hour with no
// minutes ("2027-01-01T10Z") is not a time at all: both would publish the post
// at a moment the caller never asked for. An instant without an explicit offset
// is ambiguous too: two machines read it as two different instants, and the
// post would publish at the wrong hour. A trailing Z or a +HH:MM offset is
// required.
const ISO_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/i;

function invalidBody(failure: { details: unknown }): ActionResult {
  return error(400, "INVALID_REQUEST", "Invalid request body", failure.details);
}

function actionErrorCode(result: ActionResult): string {
  const failure = result.body.error as { code?: unknown } | undefined;
  return typeof failure?.code === "string" ? failure.code : "ERROR";
}

// What a refusal is about: the owner, and the ids that were in play. Nothing
// else is ever recorded, so an id that the caller made up is not written down.
interface RefusalSubject {
  userId: string;
  postId?: string;
  accountId?: string;
}

// The readable half of a refusal: ids and the route. The caller's raw input
// is never echoed, so an id that is not a uuid never reaches the log.
function describeSubject(route: string, subject: RefusalSubject): string {
  const user = `user ${subject.userId}`;
  if (subject.postId) return `post ${subject.postId}, ${user}`;
  if (subject.accountId && isValidUuid(subject.accountId)) {
    return `account ${subject.accountId}, ${user}`;
  }
  if (route === "accounts/health") return `account unknown, ${user}`;
  if (route.startsWith("posts/")) return `post unknown, ${user}`;
  return user;
}

// The durable half of a refusal: one system_logs row per refusal, so a
// refusal nobody watched still leaves a trace (project rule: every early
// return that refuses work writes a log row). The row itself is written by
// the one writer (./refusalLog.ts), so the route, the code, the status and
// the ids live in exactly one place: never the request body, never a token,
// never the error text the caller was given.
async function writeRefusalRow(
  deps: PostActionDeps,
  route: string,
  subject: RefusalSubject,
  result: ActionResult,
): Promise<void> {
  await recordApiRefusal(deps.supabase, {
    userId: subject.userId,
    route,
    code: actionErrorCode(result),
    status: result.status,
    postId: subject.postId,
    accountId: subject.accountId,
  });
}

// Every refusal leaves a line behind and a row in the database. Ids only:
// never a token, never a request body.
async function refuse(
  deps: PostActionDeps,
  route: string,
  subject: RefusalSubject,
  result: ActionResult,
): Promise<ActionResult> {
  console.warn(
    `[n8n-api] ${route}: ${actionErrorCode(result)} (${describeSubject(route, subject)})`,
  );
  await writeRefusalRow(deps, route, subject, result);
  return result;
}

// A refusal is logged; a server fault is not, because the fault was already logged
// where it happened.
async function refuseOrFail(
  deps: PostActionDeps,
  route: string,
  subject: RefusalSubject,
  result: ActionResult,
): Promise<ActionResult> {
  if (result.status >= 500) return result;
  return await refuse(deps, route, subject, result);
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

// The body is read by the handler, not by the router. When the router parsed
// it first, a malformed or truncated body threw out of the route, the router's
// outer catch answered with a generic 500, and the rate-limit headers were
// dropped on the way out. A body that cannot be parsed is the caller's
// mistake, so it gets the same stable 400 every other refusal gets.
async function parseBody(
  readBody: () => Promise<unknown>,
): Promise<{ body: unknown } | ActionResult> {
  try {
    return { body: await readBody() };
  } catch {
    return error(400, "INVALID_REQUEST", "The request body is not valid JSON.");
  }
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
  if (!data) return await refuse(deps, route, { userId, postId }, NOT_FOUND);
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
    return await refuse(deps, route, { userId }, postId);
  }
  const now = deps.now();

  const read = await readOwnedPost(deps, route, postId, userId, "id, status, scheduled_at");
  if (isActionResult(read)) return read;
  const post = read;

  if (!isFutureScheduled(post, now)) {
    return await refuse(
      deps,
      route,
      { userId, postId },
      error(
        409,
        "POST_NOT_SCHEDULED",
        "Only a scheduled post whose time has not come yet can be cancelled.",
        { status: post.status, scheduled_at: post.scheduled_at ?? null },
      ),
    );
  }

  const refusal = await cancelScheduledRow(deps, route, { postId, userId, now });
  if (refusal) return await refuseOrFail(deps, route, { userId, postId }, refusal);

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
    return await refuse(deps, route, { userId }, invalidBody(parsed));
  }
  const { post_id: postId, scheduled_at: scheduledAt } = parsed.data;
  if (!isValidUuid(postId)) {
    return await refuse(deps, route, { userId }, invalidPostId());
  }
  const now = deps.now();

  const invalid = await rescheduleRefusal(deps, {
    route,
    userId,
    postId,
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
    return await refuse(deps, route, { userId, postId }, CONSENT_BOUND_POST);
  }

  if (!isFutureScheduled(post, now)) {
    return await refuse(
      deps,
      route,
      { userId, postId },
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
  if (isActionResult(updated)) {
    return await refuseOrFail(deps, route, { userId, postId }, updated);
  }

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
async function rescheduleRefusal(
  deps: PostActionDeps,
  request: {
    route: string;
    userId: string;
    postId: string;
    scheduledAt: string;
    now: Date;
  },
): Promise<ActionResult | null> {
  const { route, userId, postId, scheduledAt, now } = request;
  if (
    !ISO_DATE_TIME_RE.test(scheduledAt) ||
    !Number.isFinite(Date.parse(scheduledAt)) ||
    !hasRealCalendarDate(scheduledAt)
  ) {
    return await refuse(
      deps,
      route,
      { userId, postId },
      error(
        400,
        "INVALID_SCHEDULED_AT",
        "scheduled_at must be an ISO 8601 timestamp with a UTC offset, e.g. 2026-06-05T14:30:00Z or 2026-06-05T17:30:00+03:00.",
      ),
    );
  }
  if (Date.parse(scheduledAt) <= now.getTime()) {
    return await refuse(
      deps,
      route,
      { userId, postId },
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
    return await refuse(
      deps,
      route,
      { userId },
      error(400, "INVALID_ACCOUNT_ID", "social_account_id is required."),
    );
  }
  if (!isValidUuid(accountId)) {
    // The id the caller sent is not a uuid, so it is not recorded: only a
    // real account uuid is written down.
    return await refuse(
      deps,
      route,
      { userId },
      error(
        400,
        "INVALID_ACCOUNT_ID",
        `social_account_id must be a Postora account UUID (from GET /api/v1/accounts), not '${accountId}'.`,
      ),
    );
  }

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
    return await refuse(
      deps,
      route,
      { userId, accountId },
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

  // An account that is inactive, needs a reconnect or carries an expired token
  // is not healthy. A token whose expiry is unknown is neither healthy nor
  // unhealthy: the answer is null, so the caller reads an indeterminate state
  // instead of a "healthy" nobody has checked.
  const healthy = !isActive || needsReauth || tokenExpired === true
    ? false
    : tokenExpired === null
    ? null
    : true;

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
      healthy,
    },
  });
}

// ── 4. best-times ──────────────────────────────────────────────────────────────

export interface PostingHistogram {
  hourCounts: Record<number, number>;
  dayCounts: Record<number, number>;
  totalPosts: number;
}

export function computePostingHistogram(
  postedAts: string[],
  timeZone: string,
): PostingHistogram {
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

// The day a suggestion names is a weekday: "Funday" is not a day the caller
// can schedule on, and an empty one is not a day either. The model's spelling
// is not trusted, so the day is checked against the seven real ones instead of
// against a pattern that would accept any word.
const BEST_TIME_DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

// The time is a wall-clock time in one of the two formats a caller writes: the
// 12-hour format the model is asked for ("11:00 AM") and the 24-hour format
// ("18:30"). "25:90" is not a time, and neither is "13:00 PM": the hour of a
// 12-hour clock never goes past twelve, and the minutes never past fifty-nine.
const BEST_TIME_12_HOUR_RE = /^(0?[1-9]|1[0-2]):[0-5]\d\s?(AM|PM)$/i;
const BEST_TIME_24_HOUR_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

function isBestTimeDay(value: string): boolean {
  return BEST_TIME_DAYS.includes(value.trim().toLowerCase());
}

function isBestTimeClock(value: string): boolean {
  const trimmed = value.trim();
  return BEST_TIME_12_HOUR_RE.test(trimmed) || BEST_TIME_24_HOUR_RE.test(trimmed);
}

// A suggestion is only usable when every field the caller schedules from is
// there and carries a value: the platform, the day, the time, a score between
// 0 and 100, and the reason. The model is asked for that shape, but the answer
// is whatever came back, so the shape is checked rather than assumed.
export function isBestTimeSuggestion(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  // A field of the right type is not enough: an empty platform, day, time or
  // reason carries nothing the caller can schedule from, so it is refused the
  // same way a missing field is.
  if (typeof item.platform !== "string" || item.platform.trim().length === 0) return false;
  if (typeof item.day !== "string" || !isBestTimeDay(item.day)) return false;
  if (typeof item.time !== "string" || !isBestTimeClock(item.time)) return false;
  if (typeof item.reason !== "string" || item.reason.trim().length === 0) return false;
  return typeof item.score === "number" &&
    Number.isFinite(item.score) &&
    item.score >= 0 &&
    item.score <= 100;
}

// One platform, one history, one AI call. The suggestion service takes a
// single historicalData, so a platform asked about on its own is the only way
// to keep an Instagram post out of a TikTok suggestion.
async function requestSuggestions(
  deps: PostActionDeps,
  route: string,
  request: {
    platform: string;
    historicalData: PostingHistogram;
    userId: string;
  },
): Promise<{ suggestions: unknown[] } | ActionResult> {
  const { platform, historicalData, userId } = request;

  // The deadline is one deadline for the whole call: the headers and the body
  // together. The clock starts before the request goes out, because a body
  // that stalls after the headers arrived would otherwise be read for as long
  // as the service keeps the connection open.
  const timeoutMs = deps.bestTimesTimeoutMs ?? BEST_TIMES_TIMEOUT_MS;
  const startedAt = deps.now().getTime();

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
        body: JSON.stringify({
          platforms: [platform],
          historicalData,
          user_id: userId,
        }),
      },
      timeoutMs,
      deps.fetcher,
    );
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    if (message === "Request timed out") {
      console.error(`[n8n-api] ${route}: the suggestion service did not answer within ${timeoutMs / 1000}s for ${platform} (user ${userId})`);
      return error(
        504,
        "BEST_TIMES_TIMEOUT",
        "The suggestion service did not answer in time. Try again.",
      );
    }
    console.error(`[n8n-api] ${route}: the suggestion service could not be reached for ${platform}`);
    return error(502, "BEST_TIMES_FAILED", "Could not get suggestions right now. Try again.");
  }

  if (!response.ok) {
    console.error(`[n8n-api] ${route}: the suggestion service answered ${response.status} for ${platform}`);
    return error(502, "BEST_TIMES_FAILED", "Could not get suggestions right now. Try again.");
  }

  // The body gets the rest of the same deadline. A body that never arrives is
  // a service that did not answer in time, not a service that had nothing to
  // say, so it is the same 504 the fetch timeout answers with.
  const remainingMs = Math.max(0, timeoutMs - (deps.now().getTime() - startedAt));
  const bodyRead = await readBodyBeforeDeadline(response, remainingMs);
  if (bodyRead.kind === "timeout") {
    console.error(`[n8n-api] ${route}: the suggestion service did not answer within ${timeoutMs / 1000}s for ${platform} (user ${userId})`);
    return error(
      504,
      "BEST_TIMES_TIMEOUT",
      "The suggestion service did not answer in time. Try again.",
    );
  }
  if (bodyRead.kind === "failed") {
    console.error(`[n8n-api] ${route}: the suggestion service's answer could not be read for ${platform} (user ${userId})`);
    return error(502, "BEST_TIMES_FAILED", "Could not get suggestions right now. Try again.");
  }
  const bodyText = bodyRead.text;

  // A 2xx with a body that carries no suggestion list is a failed read, not an
  // empty result: answering 200 with no suggestions would tell the caller the
  // service had nothing to say, when in fact it never answered. An empty array
  // from the service is a real answer and stays a 200.
  const json = parseJsonObject(bodyText);
  if (json === null || !Array.isArray(json.suggestions)) {
    console.error(`[n8n-api] ${route}: the suggestion service answered without a suggestions list for ${platform} (user ${userId})`);
    return error(502, "BEST_TIMES_FAILED", "Could not get suggestions right now. Try again.");
  }

  // The service flags an answer it could not read: the list is empty because
  // the model's answer failed to parse, not because there was nothing to say.
  // That is a failed read too, so it is a 502 and never a 200 that carries no
  // suggestions.
  if (json.parse_failed === true) {
    console.error(`[n8n-api] best-times: the suggestion service could not read the model's answer (user ${userId})`);
    return error(502, "BEST_TIMES_FAILED", "Could not get suggestions right now. Try again.");
  }

  // The service was asked about one platform, so every suggestion it answers
  // with has to be for that platform: a suggestion for another platform is not
  // an answer to this question. The platform the service answered with is
  // compared the way the request was written: trimmed and lowercased, so a
  // suggestion for " Instagram " is an answer about Instagram. A suggestion
  // that does not carry every field the caller schedules from is dropped for
  // the same reason.
  const returned = (json.suggestions as unknown[]) ?? [];
  const suggestions = returned.filter((value) => {
    if (!isBestTimeSuggestion(value)) return false;
    const item = value as { platform: string };
    return String(item.platform).trim().toLowerCase() === platform.toLowerCase();
  });

  // A list the service answered with and that carries nothing usable is a
  // failed read, not an empty result: answering 200 with no suggestions would
  // tell the caller the service had nothing to say, when in fact it answered
  // with something that is not a suggestion.
  if (returned.length > 0 && suggestions.length === 0) {
    console.error(
      `[n8n-api] ${route}: the suggestion service answered with no usable suggestion for ${platform} (user ${userId})`,
    );
    return error(502, "BEST_TIMES_FAILED", "Could not get suggestions right now. Try again.");
  }

  return { suggestions };
}

// The limit is per platform on purpose. One shared limit across the platforms
// asked for would let a busy platform push every row of another platform out
// of the read, and that platform would then be answered with an empty
// history.
const HISTORY_LIMIT_PER_PLATFORM = 500;

// The history of one platform, read on its own. The rows are the successful
// per-platform results, and the owner is enforced by the join to posts, so the
// read cannot reach another account's rows even though the service role is the
// one doing the reading.
async function readPlatformHistory(
  deps: PostActionDeps,
  route: string,
  request: { userId: string; platform: string },
): Promise<string[] | ActionResult> {
  const { data, error: readError } = await deps.supabase
    .from("platform_posts")
    .select("posted_at, posts!inner(user_id)")
    .eq("posts.user_id", request.userId)
    .eq("status", "success")
    .eq("platform", request.platform)
    .not("posted_at", "is", null)
    .order("posted_at", { ascending: false })
    .limit(HISTORY_LIMIT_PER_PLATFORM);

  if (readError) {
    console.error(`[n8n-api] ${route}: reading the posting history failed: ${readError.message}`);
    return error(500, "INTERNAL_ERROR", "Reading the posting history failed. Please try again.");
  }

  const postedAts: string[] = [];
  for (const row of ((data ?? []) as Array<{ posted_at: string | null }>)) {
    if (typeof row.posted_at !== "string") continue;
    postedAts.push(row.posted_at);
  }
  return postedAts;
}

// The platform identifiers Postora stores are lowercase words: "instagram",
// "tiktok". The spelling the caller used is normalized before the platforms
// are deduplicated and read, so "Instagram" and " instagram " are one platform:
// one history, one AI call, one entry in based_on_posts. The platform names
// themselves are not written down here: the platform contract owns them, and a
// second copy of that list goes stale without anybody noticing.
const PLATFORM_IDENTIFIER_RE = /^[a-z]+$/;

// The platforms of one request: normalized, then deduplicated. The order the
// caller asked for is kept, because it is the order the answers come back in.
// A platform that is not a lowercase word is not a platform at all, so the
// request is refused rather than answered with a history that is empty by
// construction and an AI call that is billed for it.
//
// A lowercase word is not a platform either: "facebok" is one. Whether a name
// is a platform the caller can post to is decided by the caller's own
// connected accounts and not by a list of names written down here, so that is
// where the second check lives (see readConnectedPlatforms).
function normalizePlatforms(platforms: string[]): string[] | null {
  const names: string[] = [];
  for (const platform of platforms) {
    const name = platform.trim().toLowerCase();
    if (!PLATFORM_IDENTIFIER_RE.test(name)) return null;
    names.push(name);
  }
  return [...new Set(names)];
}

// The platforms the caller can actually post to: their own active accounts.
// This is not a list of platform names: the platform contract owns those, and
// a second copy of it here would go stale without anybody noticing. It is the
// caller's own accounts, which is the only list that answers the question that
// actually matters: can this caller post to this platform? A name that passes
// the lowercase-word check but names no account ("facebok") would otherwise
// cost a history read and a paid AI call, and answer with a history that is
// empty by construction.
//
// The read is scoped to the owner, because this function runs with the service
// role and RLS is not the boundary: the rows are the caller's own accounts.
async function readConnectedPlatforms(
  deps: PostActionDeps,
  route: string,
  request: { userId: string; platforms: string[] },
): Promise<Set<string> | ActionResult> {
  const { data, error: readError } = await deps.supabase
    .from("social_accounts")
    .select("platform")
    .eq("user_id", request.userId)
    .eq("is_active", true)
    .in("platform", request.platforms);

  if (readError) {
    console.error(`[n8n-api] ${route}: reading the connected accounts failed: ${readError.message}`);
    return error(500, "INTERNAL_ERROR", "Reading the connected accounts failed. Please try again.");
  }

  const connected = new Set<string>();
  for (const row of ((data ?? []) as Array<{ platform?: unknown }>)) {
    if (typeof row.platform === "string") connected.add(row.platform);
  }
  return connected;
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
    return await refuse(deps, route, { userId }, invalidBody(parsed));
  }
  // The same platform twice is one platform: one history, one AI call. The
  // platforms are normalized before they are deduplicated, because "Instagram"
  // and " instagram " are the same platform and the rows are stored under the
  // lowercase name. Deduplicating the raw spellings would read the history
  // twice, once for a spelling no row carries, and ask for two AI calls that
  // answer with contradictory counts for one platform.
  const platforms = normalizePlatforms(parsed.data.platforms);
  if (!platforms) {
    return await refuse(
      deps,
      route,
      { userId },
      error(
        400,
        "INVALID_REQUEST",
        "platforms must be platform names such as instagram or tiktok.",
      ),
    );
  }
  // The limit is on the platforms that are read and asked about, so it is
  // checked on the list that is actually used. The schema caps the raw list
  // at the same number, and deduplication can only shorten it. The shape of
  // the request is checked before anything is read, so a request that is
  // refused for its shape costs no database read at all.
  if (platforms.length > BEST_TIMES_MAX_PLATFORMS) {
    return await refuse(
      deps,
      route,
      { userId },
      invalidBody({
        details: [
          {
            field: "platforms",
            message: `at most ${BEST_TIMES_MAX_PLATFORMS} platforms`,
          },
        ],
      }),
    );
  }

  // A platform the caller cannot post to is refused here: before the history
  // is read and before the AI is called. A name that is a lowercase word but
  // names no account of the caller ("facebok") would otherwise cost a history
  // read and a paid AI call, and answer with a history that is empty by
  // construction. The caller's own connected accounts are what makes the
  // difference between a platform and a typo, because they are the only
  // platforms the caller can post to.
  const connected = await readConnectedPlatforms(deps, route, { userId, platforms });
  if (isActionResult(connected)) return connected;
  const missing = platforms.filter((platform) => !connected.has(platform));
  if (missing.length > 0) {
    // The names echoed back are the normalized lowercase words the caller
    // sent, so the refusal carries nothing the caller did not already know.
    return await refuse(
      deps,
      route,
      { userId },
      error(
        400,
        "UNKNOWN_PLATFORM",
        `No connected account for: ${missing.join(", ")}. Use list_accounts to see your platforms.`,
        { platforms: missing },
      ),
    );
  }

  const timeZone = preferredTimezone && isValidTimeZone(preferredTimezone)
    ? preferredTimezone
    : "UTC";

  // The history is per platform: a suggestion for TikTok must not be shaped by
  // a LinkedIn-only post, nor by a TikTok publish that failed. Every platform
  // is read on its own, under its own limit, so a busy platform cannot push
  // another platform's rows out of the read. The reads run in parallel: they
  // are independent, and one platform's history must not wait for another's.
  const histories = await Promise.all(
    platforms.map((platform) => readPlatformHistory(deps, route, { userId, platform })),
  );

  // The first history read that failed is the failure that is reported, in the
  // order the platforms were asked for: the caller asked for these platforms
  // in this order.
  const postedAtsByPlatform = new Map<string, string[]>();
  for (const [index, platform] of platforms.entries()) {
    const history = histories[index];
    if (isActionResult(history)) return history;
    postedAtsByPlatform.set(platform, history);
  }

  // Each histogram is built from that platform's own history, so a platform
  // with no history of its own gets an empty histogram instead of another
  // platform's posts.
  const histograms: Record<string, PostingHistogram> = {};
  for (const platform of platforms) {
    histograms[platform] = computePostingHistogram(
      postedAtsByPlatform.get(platform) ?? [],
      timeZone,
    );
  }

  // The suggestion service takes one history per request, so every platform is
  // asked about on its own. The calls run in parallel: six platforms are six
  // AI calls, and waiting for them one after another would cost the caller six
  // times the latency for the same answer.
  const results = await Promise.all(
    platforms.map((platform) =>
      requestSuggestions(deps, route, {
        platform,
        historicalData: histograms[platform],
        userId,
      }),
    ),
  );

  // The first failure in the order the platforms were asked for is the one that
  // is reported: the caller asked for these platforms in this order.
  const suggestions: unknown[] = [];
  const basedOnPosts: Record<string, number> = {};
  for (const [index, platform] of platforms.entries()) {
    const result = results[index];
    if (isActionResult(result)) return result;
    suggestions.push(...result.suggestions);
    basedOnPosts[platform] = histograms[platform].totalPosts;
  }

  return ok({
    timezone: timeZone,
    based_on_posts: basedOnPosts,
    suggestions,
  });
}

// ── route adapters ─────────────────────────────────────────────────────────────

export const handleCancelScheduledPost = async (
  req: Request,
  // deno-lint-ignore no-explicit-any
  supabase: any,
  userId: string,
  readBody: () => Promise<unknown>,
): Promise<Response> => {
  const deps = defaultPostActionDeps(supabase);
  const parsed = await parseBody(readBody);
  if (isActionResult(parsed)) {
    // A body that cannot be read is a refusal, so it leaves a durable row too.
    return toResponse(req, await refuse(deps, "posts/cancel", { userId }, parsed));
  }
  return toResponse(req, await cancelScheduledPost(deps, userId, parsed.body));
};

export const handleReschedulePost = async (
  req: Request,
  // deno-lint-ignore no-explicit-any
  supabase: any,
  userId: string,
  readBody: () => Promise<unknown>,
): Promise<Response> => {
  const deps = defaultPostActionDeps(supabase);
  const parsed = await parseBody(readBody);
  if (isActionResult(parsed)) {
    return toResponse(req, await refuse(deps, "posts/reschedule", { userId }, parsed));
  }
  return toResponse(req, await reschedulePost(deps, userId, parsed.body));
};

export const handleSuggestBestTimes = async (
  req: Request,
  // deno-lint-ignore no-explicit-any
  supabase: any,
  userId: string,
  readBody: () => Promise<unknown>,
  preferredTimezone: string | null,
): Promise<Response> => {
  const deps = defaultPostActionDeps(supabase);
  const parsed = await parseBody(readBody);
  if (isActionResult(parsed)) {
    return toResponse(req, await refuse(deps, "best-times", { userId }, parsed));
  }
  return toResponse(
    req,
    await suggestBestTimes(deps, userId, parsed.body, preferredTimezone),
  );
};

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
