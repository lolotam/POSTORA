import { supabase } from "@/integrations/supabase/client";

export const PASSWORD_SIGN_IN_MESSAGE = "Please sign in again before changing your password.";

type FunctionErrorPayload = {
  error?: unknown;
  code?: unknown;
  error_code?: unknown;
};

export type FunctionErrorResult = {
  code?: string;
  error: string;
};

export async function getAuthenticatedFunctionHeaders(): Promise<{ Authorization: string }> {
  const { data: sessionData } = await supabase.auth.getSession();
  let session = sessionData.session;
  const expiresSoon = session?.expires_at
    ? session.expires_at <= Math.floor(Date.now() / 1000) + 60
    : false;

  if (!session?.access_token || expiresSoon) {
    const { data: refreshed, error } = await supabase.auth.refreshSession();
    if (error || !refreshed.session?.access_token) {
      throw new Error(PASSWORD_SIGN_IN_MESSAGE);
    }
    session = refreshed.session;
  }

  return { Authorization: `Bearer ${session.access_token}` };
}

export function friendlyPasswordFunctionMessage(code: string | undefined, fallback?: string): string {
  switch (code) {
    case "unauthorized":
      return PASSWORD_SIGN_IN_MESSAGE;
    case "mfa_required":
      return "Please enter your authenticator code to continue.";
    case "otp_required":
      return "Please enter the email verification code to continue.";
    case "invalid_otp":
      return "Invalid or expired code.";
    case "rate_limited":
      return "Too many attempts. Please try again later.";
    default:
      return fallback || "Unable to change password. Please try again.";
  }
}

/**
 * supabase-js throws `FunctionsHttpError(response)`, so `error.context` IS the
 * `Response`. Also accept a nested `context.response` for wrapped error shapes.
 */
function extractFunctionResponse(error: unknown): Response | undefined {
  const context = (error as { context?: unknown }).context;
  if (context instanceof Response) return context;
  const nested = (context as { response?: unknown } | undefined)?.response;
  return nested instanceof Response ? nested : undefined;
}

export async function readFunctionError(error: unknown): Promise<FunctionErrorResult> {
  const response = extractFunctionResponse(error);
  if (!response) {
    const message = error instanceof Error ? error.message : undefined;
    return { error: friendlyPasswordFunctionMessage(undefined, message) };
  }

  const payload = await response.clone().json().catch(() => null) as FunctionErrorPayload | null;
  const codeValue = payload?.code ?? payload?.error_code;
  const code = typeof codeValue === "string" ? codeValue : response.status === 401 ? "unauthorized" : undefined;
  const errorText = typeof payload?.error === "string" ? payload.error : undefined;

  return {
    code,
    error: friendlyPasswordFunctionMessage(code, errorText || (error instanceof Error ? error.message : undefined)),
  };
}
