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
 * It never throws: the caller still gets its 429, whether the row was
 * written or not.
 */
export async function recordRateLimitRefusal(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  request: { userId: string; route: string; now?: number },
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

  await recordApiRefusal(supabase, {
    userId,
    route,
    code: "RATE_LIMIT_EXCEEDED",
    status: 429,
  });
}
