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

/** "timeout" for an aborted request, "network_error" for anything else the fetch threw. */
function failureCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (name === "TimeoutError" || name === "AbortError") return "timeout";
  }
  return "network_error";
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

    // 409 on OUR OWN idempotency key means the key was already used: the first
    // request with it was accepted, so the email went out (invalid_idempotent_request
    // -- the body changed since -- or concurrent_idempotent_requests -- the first
    // request is still in flight). Treating that as a failure would send a second
    // copy on the next run; treating it as "not sent" would leave the recipient to be
    // told again about the same outage. Either way the mail is out.
    if (response.status === 409) {
      console.warn(
        "[send-whatsapp-disconnect-alert] the provider already accepted this idempotency key; treating the conflict as sent",
      );
      return;
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
