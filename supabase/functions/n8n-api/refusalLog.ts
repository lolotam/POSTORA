// The durable half of an API refusal: one system_logs row per refusal, so a
// refusal nobody watched still leaves a trace (project rule: every early
// return that refuses work writes a log row).
//
// The row carries the route, the code, the status and the ids only: never the
// request body, never the recipient, never the message text, never a token.
// An account id or a post id is written down only when it is a real uuid,
// because an id the caller made up must not reach the log.
import { isValidUuid } from "./requestGuards.ts";
import { runInBackground } from "../_shared/background.ts";

// The window a rate-limit refusal is recorded once in. One row per (user,
// route) per minute is enough to leave the trace; more than that is write
// amplification on a client that is hammering the API by definition.
const REFUSAL_THROTTLE_WINDOW_MS = 60_000;

// The bound on the throttle map. An isolate must not grow it without limit,
// so a client that throttles on many routes cannot fill the edge memory.
const REFUSAL_THROTTLE_MAX = 10_000;

// The throttle state per (user, route): either the time a write finished, or
// the time a write started and is still in flight. The insertion order is the
// write order: a write deletes and re-sets its key, so the first key in the
// map is the one written longest ago. An entry stands for a row that is really
// there, or for a write that is on its way to put one there.
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
 *
 * It answers whether the row landed: true when the insert succeeded, false
 * when the insert failed or the client threw. A caller that only wants the
 * refusal recorded can ignore the answer; the throttled writer needs it,
 * because a refusal row that was never written may not be throttled away.
 */
export async function recordApiRefusal(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  request: { userId: string; route: string; code: string; status: number; postId?: string; accountId?: string },
): Promise<boolean> {
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
      return false;
    }
    return true;
  } catch (thrown) {
    // The refusal is still a refusal: the caller gets the same answer, and the
    // edge log is the only sink still reachable.
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    console.error(
      `[n8n-api] system_logs insert failed while refusing ${route} (${code}, no durable refusal row): ${message}`,
    );
    return false;
  }
}

/**
 * Records the refusal the central rate limiter answers with.
 *
 * The limiter answers before any route runs, so no route can record this
 * refusal itself: without this, a caller that exhausts its quota leaves no
 * trace at all. One row per (user, route) per minute is written, because a
 * client that is being throttled is by definition hammering the API, and one
 * row per refused request would amplify writes exactly when the database is
 * under pressure.
 *
 * The row is written off the response path, through runInBackground: the 429
 * is the answer, and the answer cannot be held hostage by the same database
 * pressure that caused the throttling. The write keeps running after the
 * response is returned (waitUntil on the normal runtime, a 2s cap on the
 * degraded path), so a slow row still lands and the caller is answered
 * either way. There is no deadline of its own here: the write is detached,
 * not raced.
 *
 * The key is claimed before the write starts, and the claim is synchronous:
 * no await stands between the checks and the claim, so a burst of identical
 * refusals cannot each schedule a row. The refusals that arrive while the
 * first write is in flight find the claim and write nothing.
 *
 * Only the write that made the claim may settle it. A write that did not
 * land releases its claim, so the next identical refusal tries its row
 * again: there is no row behind the entry, and an entry that stands for a
 * row nobody can see must not silence the next refusal. A write that did
 * land turns its claim into the window, counted from the moment the row was
 * written and not from the moment the write started: a slow row must not
 * leave behind a window that is already spent.
 *
 * It never throws: the caller still gets its 429, whether the row was
 * written or not.
 */
export async function recordRateLimitRefusal(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  request: { userId: string; route: string; now?: number; clock?: () => number },
): Promise<void> {
  const { userId, route } = request;
  const injectedNow = request.now;
  const now = injectedNow ?? Date.now();
  // The clock reads the moment the write finished, so the window can start
  // there. It defaults to Date.now; when the caller injected a fixed `now`
  // without a clock of its own, the clock follows that injected timeline,
  // so the two never disagree about what time it is.
  const clock = request.clock ?? (injectedNow === undefined ? () => Date.now() : () => injectedNow);
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
    // passed: an entry that is still inside its window stands for the only
    // row of that refusal, and evicting it would let the identical refusal
    // write a second row inside the same minute. When nothing has expired,
    // this refusal is not written at all.
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

  // The claim is taken synchronously, before the write is even started: no
  // await stands between the checks above and this line, so a burst of
  // identical refusals finds the claim of the first one and writes nothing
  // more. The claim carries the start time of the write; the window it
  // becomes is counted from the completion of the write.
  const claim = now;
  rateLimitRefusalThrottle.delete(key);
  rateLimitRefusalThrottle.set(key, claim);

  // The row is written off the response path. The 429 is the answer, and it
  // is answered no matter what the database does: a hung insert under
  // throttling pressure would otherwise cost the caller its refusal. The
  // insert is not cancelled either: it is left to finish on its own, so a
  // slow row still lands.
  await runInBackground("rate-limit refusal row", async () => {
    const landed = await recordApiRefusal(supabase, {
      userId,
      route,
      code: "RATE_LIMIT_EXCEEDED",
      status: 429,
    });
    if (!landed) {
      // The write did not land, so there is no row and no window: the claim
      // is released. Only when the map still holds this call's claim, so a
      // later claim is never dropped by a write that failed before it.
      if (rateLimitRefusalThrottle.get(key) === claim) {
        rateLimitRefusalThrottle.delete(key);
      }
      return;
    }

    // The row landed, so the window starts now: it runs from the completion
    // of the write, not from its start, so a slow row does not leave a
    // window that is already spent. The claim only becomes the window when
    // the map still holds this call's claim.
    const completedAt = clock();
    if (rateLimitRefusalThrottle.get(key) === claim) {
      rateLimitRefusalThrottle.delete(key);
      rateLimitRefusalThrottle.set(key, completedAt);
    }
  });
}
