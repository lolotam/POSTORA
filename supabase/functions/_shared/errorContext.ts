// The loggable shape of a failure, for the edge functions' catch blocks.
//
// A raw error message can carry a recipient address, a phone number, a provider
// payload or a database detail. None of that belongs in a log line, so a failure is
// logged as a stable code plus the sanitized message from the shared sanitizer, and
// the operational context around it goes through the shared redactor.

import { sanitizeErrorMessage } from "./errorSanitizer.ts";

/**
 * A stable, non-revealing code for a failure.
 *
 * The provider's own code when it has one (Postgres error codes, an HTTP status, the
 * Resend error code), the error class name otherwise, and "unknown_error" for a value
 * that is not an error at all.
 */
export function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const candidate = error as Record<string, unknown>;
    for (const key of ["code", "status", "statusCode"]) {
      const value = candidate[key];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
    if (typeof candidate.name === "string" && candidate.name.trim().length > 0) {
      return candidate.name.trim().toLowerCase();
    }
  }
  return "unknown_error";
}

/** The loggable form of a failure: a code and a message that carries nothing sensitive. */
export function sanitizedError(error: unknown): { error_code: string; error: string } {
  return {
    error_code: errorCode(error),
    error: sanitizeErrorMessage(error),
  };
}
