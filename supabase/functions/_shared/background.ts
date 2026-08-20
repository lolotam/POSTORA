declare const EdgeRuntime: {
  waitUntil: (promise: Promise<unknown>) => void;
} | undefined;

let pathLogged = false;

/**
 * Runs best-effort work off the response path.
 *
 * On the normal runtime `EdgeRuntime.waitUntil` keeps the work alive after the
 * Response is returned, and the returned promise settles immediately — callers
 * pay nothing. When that primitive is missing the work is awaited here under a
 * 2s cap, so an awaiting caller's response is delayed by up to 2s. That delay is
 * the deliberate trade: dropping a customer message on a detached promise is
 * worse than a slow webhook ack.
 *
 * Callers must `await` this. Not awaiting silently reintroduces the detached
 * promise on the degraded path.
 *
 * Delivery is best-effort, not durable — there is no outbox behind this.
 */
export async function runInBackground(label: string, fn: () => Promise<unknown>): Promise<void> {
  const runtime = typeof EdgeRuntime !== "undefined" ? EdgeRuntime : undefined;
  const waitUntil = runtime?.waitUntil;

  if (!pathLogged) {
    pathLogged = true;
    console.log(`[background] ${typeof waitUntil === "function" ? "waitUntil" : "degraded inline"} path active`);
  }

  let work: Promise<unknown>;
  try {
    work = Promise.resolve(fn());
  } catch (error) {
    work = Promise.reject(error);
  }
  const guarded = work.catch((error) => {
    console.error(`[background] ${label} failed:`, error);
  });

  if (typeof waitUntil === "function") {
    waitUntil(guarded);
    return;
  }

  let capTimer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((resolve) => {
    capTimer = setTimeout(() => {
      console.error(`[background] ${label} exceeded the 2s degraded cap`);
      resolve();
    }, 2_000);
  });
  await Promise.race([guarded, cap]);
  if (capTimer !== undefined) clearTimeout(capTimer);
}
