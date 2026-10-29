/**
 * Turns a Resend send error into a log line that names the cause.
 *
 * Shared by the two OTP senders. Before this, send-change-password-otp logged only
 * "resend send failed", and a revoked RESEND_API_KEY took a server shell to find.
 * Only Resend's status and error name are logged: neither is secret.
 */

export interface ResendFailure {
  statusCode: number;
  name: string;
  /** Resend refused the API key itself: every email fails until the key is replaced. */
  keyRejected: boolean;
}

const KEY_ERROR_NAMES = new Set(["missing_api_key", "restricted_api_key", "invalid_api_key"]);

export function describeResendFailure(error: unknown): ResendFailure {
  const fields = (error && typeof error === "object" ? error : {}) as Record<string, unknown>;
  const statusCode = Number(fields.statusCode) || 0;
  const name = typeof fields.name === "string" ? fields.name : "unknown";
  const message = typeof fields.message === "string" ? fields.message : "";
  // Resend reports a revoked or deleted key as a 400 validation_error, not as a key error.
  const keyRejected = KEY_ERROR_NAMES.has(name) || (name === "validation_error" && /api key is invalid/i.test(message));
  return { statusCode, name, keyRejected };
}

export function resendFailureLog(source: string, failure: ResendFailure): string {
  const line = `${source}: resend send failed (status ${failure.statusCode}, ${failure.name})`;
  return failure.keyRejected
    ? `${line}; RESEND_API_KEY rejected by Resend: issue a new key and recreate the functions container`
    : line;
}
