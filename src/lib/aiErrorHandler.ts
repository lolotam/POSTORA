import { toast } from "@/hooks/use-toast";

/**
 * Patterns that indicate sensitive database/internal information in error messages
 * These should NEVER be shown to users
 */
const SENSITIVE_PATTERNS = [
  /duplicate key value violates unique constraint/i,
  /violates foreign key constraint/i,
  /violates check constraint/i,
  /column "([^"]+)" of relation/i,
  /relation "([^"]+)" does not exist/i,
  /permission denied for (table|relation|schema)/i,
  /row-level security/i,
  /policy "([^"]+)"/i,
  /Key \(([^)]+)\)=\(([^)]+)\)/i,
  /DETAIL:/i,
  /HINT:/i,
  /CONTEXT:/i,
  /postgres/i,
  /pg_/i,
  /auth\.users/i,
  /public\./i,
  /storage\./i,
  /supabase/i,
  /\.sql/i,
];

/**
 * Check if an error message contains sensitive database/internal information
 */
function containsSensitiveInfo(message: string): boolean {
  return SENSITIVE_PATTERNS.some(pattern => pattern.test(message));
}

/**
 * Sanitize an error message for safe display to users
 * Removes any database schema, table names, or internal implementation details
 */
export function sanitizeErrorMessage(error: unknown): string {
  const rawMessage = getRawErrorMessage(error);
  
  // If the message contains sensitive info, return a generic message
  if (containsSensitiveInfo(rawMessage)) {
    return "An error occurred. Please try again or contact support if the problem persists.";
  }
  
  // For safe messages, return them (but cap length)
  return rawMessage.length > 200 
    ? rawMessage.substring(0, 200) + "..." 
    : rawMessage;
}

/**
 * Extract raw error message from various error types
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
    return (e.message as string) || (e.error as string) || (e.msg as string) || 'An error occurred';
  }
  return 'An error occurred';
}

export function handleAIError(error: unknown, context: string = "AI request") {
  // Log detailed error for debugging (server-side/console only)
  console.error(`${context} error:`, error);

  // Check if it's a FunctionsHttpError with status
  const status = getErrorStatus(error);
  const rawMessage = getRawErrorMessage(error);

  // Handle specific status codes with safe messages
  if (status === 401 || rawMessage.includes("401") || rawMessage.toLowerCase().includes("unauthorized") || rawMessage.toLowerCase().includes("invalid jwt")) {
    toast({
      title: "Session Expired",
      description: "Your session has expired. Please log out and log back in to continue using AI features.",
      variant: "destructive",
    });
    return { isAuthError: true };
  }

  if (status === 402 || rawMessage.includes("402") || rawMessage.toLowerCase().includes("credits") || rawMessage.toLowerCase().includes("payment")) {
    toast({
      title: "AI Credits Exhausted",
      description: "Your AI credits have run out. Please add credits to your workspace to continue using AI features.",
      variant: "destructive",
    });
    return { isCreditsError: true };
  }

  if (status === 429 || rawMessage.includes("429") || rawMessage.toLowerCase().includes("rate limit")) {
    toast({
      title: "Too Many Requests",
      description: "You've exceeded the rate limit. Please wait a moment and try again.",
      variant: "destructive",
    });
    return { isRateLimitError: true };
  }

  // Generic error - use sanitized message
  const safeMessage = sanitizeErrorMessage(error);
  toast({
    title: `${context} Failed`,
    description: safeMessage,
    variant: "destructive",
  });

  return { isGenericError: true };
}

// Type-safe wrapper for edge function errors (including FunctionsHttpError.context.status)
export function getErrorStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    if (typeof record.status === 'number') return record.status;
    if (typeof record.code === 'number') return record.code;
    if (typeof record.context === 'object' && record.context !== null) {
      const ctxStatus = (record.context as Record<string, unknown>).status;
      if (typeof ctxStatus === 'number') return ctxStatus;
    }
  }
  return undefined;
}
