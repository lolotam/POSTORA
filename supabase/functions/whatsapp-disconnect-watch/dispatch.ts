// The alert dispatch, split out of the entrypoint so the timeout and the summary handling
// are testable without a network (ARCHITECTURE.md §26: every provider call needs an
// explicit timeout).

/** How long the watcher waits for the sender before it gives up on the account. */
// Two recipient groups, each with two 10s Resend attempts and a 500ms retry delay,
// plus database/HTTP overhead. The 50s run budget is checked between accounts.
export const ALERT_DISPATCH_TIMEOUT_MS = 50_000;

/**
 * What the sender reports back.
 *
 * The sender answers 200 even when it could not reach a recipient, so its summary is
 * the only evidence of a mail that really went out. Counting the alert from the HTTP
 * status alone would claim an alert for every recipient the sender failed on.
 */
export interface AlertDispatchResult {
  /** The owner was emailed. */
  ownerSent: boolean;
  /** The admins were emailed. */
  adminSent: boolean;
  /** The recipients the sender could not reach. */
  failed: string[];
  /** Why nothing went out, when nothing did. */
  skipped: string | null;
}

export interface AlertDispatchOptions {
  url: string;
  serviceRoleKey: string;
  accountId: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

/** The message every invalid summary fails with. */
const INVALID_SUMMARY = "alert dispatch returned an invalid summary";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Reads the sender's summary, strictly.
 *
 * The summary is the only evidence that an alert went out, so a body that does not carry
 * it -- an empty object, a field that is missing, a field of the wrong type -- says
 * NOTHING about what the sender did. Reading that as "nothing went out" would report a
 * clean run for a sender that never ran, so an unreadable summary is a dispatch failure.
 *
 * @throws when the body is not a summary.
 */
export function readAlertSummary(payload: unknown): AlertDispatchResult {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(INVALID_SUMMARY);
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.ownerSent !== "boolean" || typeof record.adminSent !== "boolean") {
    throw new Error(INVALID_SUMMARY);
  }
  if (!isStringArray(record.failed)) {
    throw new Error(INVALID_SUMMARY);
  }
  if (record.skipped !== null && typeof record.skipped !== "string") {
    throw new Error(INVALID_SUMMARY);
  }
  return {
    ownerSent: record.ownerSent,
    adminSent: record.adminSent,
    failed: [...record.failed],
    skipped: record.skipped,
  };
}

/**
 * Asks the sender to email the owner and the admins about one account.
 *
 * Raises when the sender cannot be reached, answers with a failure, answers without a
 * summary, or answers with a body that is not a summary: all of those leave the watcher
 * without evidence that an alert went out, and a watcher that reported "nothing to
 * report" for a sender that never ran would hide the outage.
 */
export async function dispatchDisconnectAlert(
  options: AlertDispatchOptions,
): Promise<AlertDispatchResult> {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? ALERT_DISPATCH_TIMEOUT_MS;

  const response = await fetcher(options.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${options.serviceRoleKey}`,
    },
    body: JSON.stringify({ account_id: options.accountId }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`alert dispatch failed with status ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // A sender that answers 200 without a summary says nothing about what it did.
    // Claiming an alert that never went out is worse than reporting the failure.
    throw new Error("alert dispatch returned no summary");
  }
  return readAlertSummary(payload);
}
