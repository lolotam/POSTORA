// The Resend call for the WhatsApp disconnect alert, split out of the entrypoint so the
// timeout, the bounded retry and the idempotency-key handling can be tested without
// Supabase, Resend or a network (ARCHITECTURE.md §26: every provider call needs an
// explicit timeout and a bounded retry policy where safe).

export const RESEND_ENDPOINT = "https://api.resend.com/emails";
export const RESEND_TIMEOUT_MS = 10_000;
export const RESEND_MAX_ATTEMPTS = 2;
export const RESEND_RETRY_DELAY_MS = 500;

export interface ResendEmail {
  to: string[];
  subject: string;
  html: string;
  /** Stable per episode and recipient: the provider dedupes a retry on it. */
  idempotencyKey: string;
}

export interface ResendOptions {
  apiKey: string;
  from: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The failure a send ends with.
 *
 * Only the status is kept: the provider's response body can carry the recipient
 * address and a fragment of the message, and neither belongs in a log line or in an
 * error that a caller might render.
 */
export class ResendSendError extends Error {
  constructor(readonly code: string, readonly status: number | null) {
    super(`Resend send failed: ${code}`);
    this.name = "ResendSendError";
  }
}

/** The only provider conflict name this code is allowed to keep. */
const KNOWN_PERMANENT_CONFLICT = "invalid_idempotent_request";

/**
 * A stable code for a 409 that will not be retried.
 *
 * The known Resend name is kept so the caller can tell a payload mismatch from any
 * other conflict. Every other name, including an empty one, becomes a local code:
 * the provider's name is not a contract and must not reach a log line.
 */
function permanentConflictCode(name: string | null): string {
  return name === KNOWN_PERMANENT_CONFLICT ? name : "idempotency_conflict";
}

/** "timeout" for an aborted request, "network_error" for anything else the fetch threw. */
function failureCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (name === "TimeoutError" || name === "AbortError") return "timeout";
  }
  return "network_error";
}

/**
 * The provider's error name out of a conflict body.
 *
 * Resend names the conflict in the body: `concurrent_idempotent_requests` when the first
 * request with the key is still in flight, `invalid_idempotent_request` when the key was
 * used with a different payload. A body that cannot be read carries no name.
 */
async function readConflictName(response: Response): Promise<string | null> {
  try {
    const body = await response.json();
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      const name = (body as Record<string, unknown>).name;
      if (typeof name === "string" && name.length > 0) return name;
    }
  } catch {
    // An unreadable body carries no name: the conflict cannot be classified, and an
    // unclassified conflict is never treated as a send that went out.
  }
  return null;
}

/**
 * Sends one alert email.
 *
 * The idempotency key is the same on every attempt, so a retry is the SAME email to
 * the provider and never a second copy to the owner.
 */
export async function sendResendEmail(email: ResendEmail, options: ResendOptions): Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? RESEND_TIMEOUT_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? RESEND_MAX_ATTEMPTS);
  const retryDelayMs = options.retryDelayMs ?? RESEND_RETRY_DELAY_MS;
  const sleep = options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const body = JSON.stringify({
    from: options.from,
    to: email.to,
    subject: email.subject,
    html: email.html,
  });

  let lastError: ResendSendError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response;
    try {
      response = await fetcher(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": email.idempotencyKey,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // A network error or a timeout is retryable: the provider may never have seen
      // the request, and the idempotency key makes the second attempt the same email
      // rather than a second one.
      lastError = new ResendSendError(failureCode(error), null);
      if (attempt >= maxAttempts) throw lastError;
      await sleep(retryDelayMs);
      continue;
    }

    if (response.ok) return;

    // A conflict is never a send that went out: only the provider knows which conflict
    // it is, so the body decides what happens next.
    if (response.status === 409) {
      const name = await readConflictName(response);
      if (name === "concurrent_idempotent_requests") {
        // The first request with this key is still in flight. The key and the body are
        // unchanged, so the retry is the very same email: sending it again within the
        // attempt budget is safe, and it is the only conflict worth retrying.
        if (attempt >= maxAttempts) {
          throw new ResendSendError("idempotency_in_flight", 409);
        }
        await sleep(retryDelayMs);
        continue;
      }
      // `invalid_idempotent_request` means the key was already used with a different
      // payload, so the provider will never accept this body and a retry cannot help.
      // Any other name is free text from the provider. It must not become the error
      // code: errorCode logs a string code as-is, and the body can carry an address.
      throw new ResendSendError(permanentConflictCode(name), 409);
    }

    // A rate limit and a server error are worth one more attempt; a client error is
    // the request's own fault and a retry would fail the same way.
    const retryable = response.status === 429 || response.status >= 500;
    lastError = new ResendSendError("provider_error", response.status);
    if (!retryable || attempt >= maxAttempts) throw lastError;
    await sleep(retryDelayMs);
  }

  throw lastError ?? new ResendSendError("unknown_error", null);
}
