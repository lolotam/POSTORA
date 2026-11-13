// The alert dispatch, split out of the entrypoint so the timeout and the summary handling
// are testable without a network (ARCHITECTURE.md §26: every provider call needs an
// explicit timeout).

/** How long the watcher waits for the sender before it gives up on the account. */
export const ALERT_DISPATCH_TIMEOUT_MS = 10_000;

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

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/** Reads the sender's summary. Anything unexpected is read as "nothing went out". */
export function readAlertSummary(payload: unknown): AlertDispatchResult {
  const record = typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  return {
    ownerSent: record.ownerSent === true,
    adminSent: record.adminSent === true,
    failed: asStringArray(record.failed),
    skipped: typeof record.skipped === "string" ? record.skipped : null,
  };
}

/**
 * Asks the sender to email the owner and the admins about one account.
 *
 * Raises when the sender cannot be reached, answers with a failure, or answers without a
 * readable summary: all three leave the watcher without evidence that an alert went out.
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
