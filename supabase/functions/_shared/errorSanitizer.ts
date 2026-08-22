/**
 * Error Sanitization Utilities for Edge Functions
 * 
 * These utilities help prevent database schema and internal implementation
 * details from leaking to clients through error messages.
 * 
 * @example
 * import { sanitizeError, sanitizeErrorMessage, getSafeErrorResponse } from "../_shared/errorSanitizer.ts";
 * 
 * try {
 *   // operation that might fail
 * } catch (error) {
 *   console.error('Detailed error for debugging:', error);
 *   return getSafeErrorResponse(error);
 * }
 */

import { corsHeaders } from "./cors.ts";

/**
 * PostgreSQL error codes that should be mapped to user-friendly messages
 * https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
const POSTGRES_ERROR_CODES: Record<string, string> = {
  // Integrity Constraint Violations
  '23000': 'This operation cannot be completed due to data constraints.',
  '23001': 'This operation cannot be completed due to data restrictions.',
  '23502': 'Required information is missing.',
  '23503': 'This item is linked to other data and cannot be modified.',
  '23505': 'This item already exists.',
  '23514': 'The provided data does not meet the required criteria.',
  
  // Authorization Errors
  '42501': 'You do not have permission to perform this action.',
  '28000': 'Authentication failed.',
  '28P01': 'Invalid credentials.',
  
  // Syntax/Access Errors (should never reach client but just in case)
  '42000': 'An error occurred processing your request.',
  '42601': 'An error occurred processing your request.',
  '42602': 'An error occurred processing your request.',
  '42703': 'An error occurred processing your request.',
  '42P01': 'An error occurred processing your request.',
  
  // Connection Errors
  '08000': 'Service temporarily unavailable. Please try again.',
  '08003': 'Service temporarily unavailable. Please try again.',
  '08006': 'Service temporarily unavailable. Please try again.',
  
  // Resource Errors
  '53000': 'Service is busy. Please try again later.',
  '53100': 'Service is busy. Please try again later.',
  '53200': 'Service is busy. Please try again later.',
  '53300': 'Service is busy. Please try again later.',
  '57014': 'Request timed out. Please try again.',
};

/**
 * Patterns in error messages that indicate sensitive information
 */
const SENSITIVE_PATTERNS = [
  /duplicate key value violates unique constraint "([^"]+)"/i,
  /violates foreign key constraint "([^"]+)"/i,
  /violates check constraint "([^"]+)"/i,
  /column "([^"]+)" of relation "([^"]+)"/i,
  /relation "([^"]+)" does not exist/i,
  /column "([^"]+)" does not exist/i,
  /permission denied for (table|relation|schema) "?([^"]+)"?/i,
  /row-level security/i,
  /policy "([^"]+)"/i,
  /Key \(([^)]+)\)=\(([^)]+)\)/i,
  /DETAIL:/i,
  /HINT:/i,
  /CONTEXT:/i,
  /supabase/i,
  /postgres/i,
  /pg_/i,
  /auth\.users/i,
  /public\./i,
  /storage\./i,
];

/**
 * Known safe error messages that can be passed through
 */
const SAFE_ERROR_PATTERNS = [
  /invalid.*api.*key/i,
  /unauthorized/i,
  /authentication.*required/i,
  /rate.*limit/i,
  /file.*too.*large/i,
  /invalid.*format/i,
  /missing.*required/i,
  /not.*found/i,
  /invalid.*token/i,
  /expired/i,
  /invalid.*request/i,
  /validation.*failed/i,
];

/**
 * Check if an error message contains sensitive information
 */
export function containsSensitiveInfo(message: string): boolean {
  return SENSITIVE_PATTERNS.some(pattern => pattern.test(message));
}

/**
 * Check if an error message is safe to expose
 */
function isSafeError(message: string): boolean {
  if (containsSensitiveInfo(message)) {
    return false;
  }
  return SAFE_ERROR_PATTERNS.some(pattern => pattern.test(message));
}

/**
 * Extract error code from various error formats
 */
function getErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null) {
    const e = error as Record<string, unknown>;
    return (e.code as string) || (e.pgCode as string) || (e.errorCode as string);
  }
  return undefined;
}

/**
 * Get the raw error message from various error types
 */
function getRawErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (typeof error === 'object' && error !== null) {
    const e = error as Record<string, unknown>;
    return (e.message as string) || (e.error as string) || (e.msg as string) || 'Unknown error';
  }
  return 'Unknown error';
}

/**
 * Sanitize an error message for safe client exposure
 * @param error - The original error (Error object, string, or any object with message)
 * @returns A sanitized, user-friendly error message
 */
export function sanitizeErrorMessage(error: unknown): string {
  const code = getErrorCode(error);
  const rawMessage = getRawErrorMessage(error);
  
  // Check for PostgreSQL error codes first
  if (code && POSTGRES_ERROR_CODES[code]) {
    return POSTGRES_ERROR_CODES[code];
  }
  
  // Check if the message is safe to expose
  if (isSafeError(rawMessage)) {
    // Even safe messages should be cleaned of any accidental sensitive data
    if (!containsSensitiveInfo(rawMessage)) {
      return rawMessage;
    }
  }
  
  // For any potentially sensitive errors, return a generic message
  return 'An error occurred. Please try again or contact support if the problem persists.';
}

/**
 * Get the HTTP status code for an error
 */
export function getErrorStatus(error: unknown): number {
  if (typeof error === 'object' && error !== null) {
    const e = error as Record<string, unknown>;
    const status = (e.status as number) || (e.statusCode as number) || (e.code as number);
    if (typeof status === 'number' && status >= 400 && status < 600) {
      return status;
    }
    
    // Map PostgreSQL error codes to HTTP status
    const pgCode = getErrorCode(error);
    if (pgCode) {
      if (pgCode.startsWith('23')) return 400; // Constraint violations
      if (pgCode.startsWith('28') || pgCode === '42501') return 401; // Auth errors
      if (pgCode.startsWith('42')) return 400; // Syntax/Invalid
      if (pgCode.startsWith('53') || pgCode.startsWith('08')) return 503; // Service unavailable
    }
  }
  return 500;
}

/**
 * Create a safe error response with CORS headers
 * @param error - The original error
 * @param defaultMessage - Optional default message to use instead of sanitized message
 * @returns Response with sanitized error and CORS headers
 */
export function getSafeErrorResponse(
  error: unknown,
  defaultMessage?: string
): Response {
  const status = getErrorStatus(error);
  const message = defaultMessage || sanitizeErrorMessage(error);
  
  return new Response(
    JSON.stringify({ error: message }),
    {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    }
  );
}

/**
 * Create a safe error response with a specific status code
 */
export function getSafeErrorResponseWithStatus(
  error: unknown,
  status: number,
  defaultMessage?: string
): Response {
  const message = defaultMessage || sanitizeErrorMessage(error);
  
  return new Response(
    JSON.stringify({ error: message }),
    {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    }
  );
}

/**
 * Sanitize an array of error details (e.g., for batch operations)
 * Returns a generic message if any error contains sensitive info
 */
export function sanitizeErrorDetails(errors: unknown[]): string[] {
  const hasSensitive = errors.some(e => {
    const msg = getRawErrorMessage(e);
    return containsSensitiveInfo(msg);
  });
  
  if (hasSensitive) {
    return ['Some items could not be processed. Please check your input and try again.'];
  }
  
  return errors.map(e => sanitizeErrorMessage(e));
}

/**
 * Log detailed error information server-side while returning sanitized response
 * @param context - Description of where the error occurred
 * @param error - The original error
 * @param additionalInfo - Any additional context to log
 * @returns Sanitized error response
 */
export function logAndSanitize(
  context: string,
  error: unknown,
  additionalInfo?: Record<string, unknown>
): Response {
  console.error(`[ERROR] ${context}:`, {
    error: error instanceof Error ? { 
      message: error.message, 
      stack: error.stack,
      name: error.name 
    } : error,
    ...additionalInfo,
    timestamp: new Date().toISOString(),
  });
  
  return getSafeErrorResponse(error);
}
