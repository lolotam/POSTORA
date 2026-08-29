import { isPermanentMetaError, type MetaProviderError } from "../_shared/metaErrors.ts";

/**
 * Should this failure flip the account to needs_reauth now, rather than after
 * MAX_FAILURES_BEFORE_REAUTH attempts?
 *
 * Extracted as a pure function so the decision is testable without a database: it is
 * the rule that decides whether a working account goes red, and it has been wrong twice.
 */
export function shouldEscalateToReauth(input: {
  failureCount: number;
  maxFailures: number;
  isPermanentMessage: boolean;
  canAttemptRefresh: boolean;
  providerError?: MetaProviderError;
}): boolean {
  if (input.isPermanentMessage) return true;
  if (!input.canAttemptRefresh) return true;
  if (input.providerError && isPermanentMetaError(input.providerError)) return true;

  // A known-transient failure never latches, at any count. An unreachable provider is
  // not evidence that a grant is dead, and the latch is one-way: the cron filters
  // flagged rows out, so a wrongly-latched account is never retried again.
  if (input.providerError?.transient) return false;

  return input.failureCount >= input.maxFailures;
}
