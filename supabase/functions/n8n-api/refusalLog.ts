// The durable half of an API refusal: one system_logs row per refusal, so a
// refusal nobody watched still leaves a trace (project rule: every early
// return that refuses work writes a log row).
//
// The row carries the route, the code, the status and the ids only: never the
// request body, never the recipient, never the message text, never a token.
// An account id or a post id is written down only when it is a real uuid,
// because an id the caller made up must not reach the log.
import { isValidUuid } from "./requestGuards.ts";

// The window a rate-limit refusal is recorded once in. One row per (user,
// route) per minute is enough to leave the trace; more than that is write
// amplification on a client that is hammering the API by definition.
const REFUSAL_THROTTLE_WINDOW_MS = 60_000;

// The bound on the throttle map. An isolate must not grow it without limit,
// so a client that throttles on many routes cannot fill the edge memory.
const REFUSAL_THROTTLE_MAX = 10_000;

// How long the 429 waits for its refusal row. The row is the trace; the 429
// is the answer, and the answer cannot be held hostage by the same database
// pressure that caused the throttling: a caller that waits for a row that
// never lands gets an edge timeout instead of its refusal. So the insert is
// raced against this deadline, and the caller is answered either way.
export const RATE_LIMIT_REFUSAL_DEADLINE_MS = 2_000;

// The last write time per (user, route). The insertion order is the write
// order: a write deletes and re-sets its key, so the first key in the map is
// the one written longest ago.
const rateLimitRefusalThrottle = new Map<string, number>();

/**
 * Clears the throttle map. Only the tests call this: the map is module
 * level on purpose, because the throttle is per isolate.
 */
export function resetRateLimitRefusalThrottleForTests(): void {
  rateLimitRefusalThrottle.clear();
}

/**
 * Writes the row one refusal leaves behind. It never throws: a refusal that
 * cannot be recorded is still a refusal, the caller gets the same answer, and
 * the edge log is the only sink left when the database refuses the row.
 */
export async function recordApiRefusal(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  request: { userId: string; route: string; code: string; status: number; postId?: string; accountId?: string },
): Promise<void> {
  const { userId, route, code, status, postId, accountId } = request;
  try {
    const { error: insertError } = await supabase
      .from("system_logs")
      .insert({
        source: "n8n-api",
        // The category has to be one the column accepts: system_logs_category_check
        // allows auth, edge, database, token, post, system, ai, scheduler,
        // webhook, payment and media. An "api" row would be rejected by the
        // constraint, so the refusal would leave no durable row at all.
        category: "edge",
        level: "warn",
        message: `${route} refused: ${code}`,
        user_id: userId,
        metadata: {
          route,
          code,
          status,
          ...(postId && isValidUuid(postId) ? { post_id: postId } : {}),
          ...(accountId && isValidUuid(accountId) ? { account_id: accountId } : {}),
        },
      });
    if (insertError) {
      console.error(
        `[n8n-api] system_logs insert failed while refusing ${route} (${code}, no durable refusal row): ${insertError?.message ?? String(insertError)}`,
      );
    }
  } catch (thrown) {
    // The refusal is still a refusal: the caller gets the same answer, and the
    // edge log is the only sink still reachable.
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    console.error(
      `[n8n-api] system_logs insert failed while refusing ${route} (${code}, no durable refusal row): ${message}`,
    );
  }
}

/**
 * Records the refusal the central rate limiter answers with.
 *
 * The limiter answers before any route runs, so no route can record this
 * refusal itself: without this, a caller that exhausts its quota leaves no
 * trace at all. One row per (user, route) per window is written, because a
 * client that is being throttled is by definition hammering the API, and one
 * row per refused request would amplify writes exactly when the database is
 * under pressure.
 *
 * The 429 never waits more than RATE_LIMIT_REFUSAL_DEADLINE_MS for its log
 * row: a database that hangs under the same pressure that caused the
 * throttling must not turn the caller's 429 into an edge timeout. When the
 * deadline wins, the insert is left to finish on its own and one line says
 * so.
 *
 * It never throws: the caller still gets its 429, whether the row was
 * written or not.
 */
export async function recordRateLimitRefusal(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  request: { userId: string; route: string; now?: number; deadlineMs?: number },
): Promise<void> {
  const { userId, route } = request;
  const now = request.now ?? Date.now();
  const key = `${userId}|${route}`;

  const lastWrite = rateLimitRefusalThrottle.get(key);
  if (lastWrite !== undefined && now - lastWrite < REFUSAL_THROTTLE_WINDOW_MS) {
    // The window is still open: this refusal was already recorded, and a
    // second row would only add write pressure.
    console.warn(
      `[n8n-api] rate limit refusal for ${route} was already recorded within the last ${REFUSAL_THROTTLE_WINDOW_MS / 1000}s: not writing another row`,
    );
    return;
  }

  if (!rateLimitRefusalThrottle.has(key) && rateLimitRefusalThrottle.size >= REFUSAL_THROTTLE_MAX) {
    // The map is full. The oldest key goes, but only when its own window has
    // passed: a live window still owes its caller a row, and evicting it
    // would lose a refusal that has not been written yet.
    const oldestKey: string | undefined = rateLimitRefusalThrottle.keys().next().value;
    const oldestWrite = oldestKey === undefined ? undefined : rateLimitRefusalThrottle.get(oldestKey);
    if (oldestKey === undefined || oldestWrite === undefined || now - oldestWrite < REFUSAL_THROTTLE_WINDOW_MS) {
      console.warn(
        `[n8n-api] rate limit refusal for ${route} was not recorded: the refusal throttle holds ${REFUSAL_THROTTLE_MAX} live entries`,
      );
      return;
    }
    rateLimitRefusalThrottle.delete(oldestKey);
  }

  // The entry is taken before the row is written, so two refusals in the same
  // window cannot both write one. The row itself may fail to be written; the
  // entry stays either way, because a missing row is not worth a second write
  // attempt per window.
  rateLimitRefusalThrottle.delete(key);
  rateLimitRefusalThrottle.set(key, now);

  // The row is written on its own time, but the refusal is not: the 429
  // answers within the deadline no matter what the database does, because a
  // hung insert under throttling pressure would otherwise cost the caller
  // its 429. The insert is not cancelled when the deadline wins — it is
  // left to finish on its own, so a slow row still lands.
  const deadlineMs = request.deadlineMs ?? RATE_LIMIT_REFUSAL_DEADLINE_MS;
  let timer: number | undefined;
  try {
    const insert = recordApiRefusal(supabase, {
      userId,
      route,
      code: "RATE_LIMIT_EXCEEDED",
      status: 429,
    });
    // recordApiRefusal swallows its own errors, but a rejection that arrives
    // after the deadline has already won must not become an unhandled one.
    const written = insert.then(() => "written" as const, () => "written" as const);
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), deadlineMs);
    });

    const outcome = await Promise.race([written, expired]);
    if (outcome === "expired") {
      console.warn(
        `[n8n-api] rate limit refusal row for ${route} did not finish within ${deadlineMs}ms; answering 429 anyway`,
      );
    }
  } finally {
    // A finished insert must not keep the isolate awake for the rest of the
    // deadline.
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
