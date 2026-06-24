/**
 * Frontend OAuth error normalizer.
 *
 * Edge functions return structured JSON errors (`{ error: "<message>" }`) on
 * non-2xx responses, but `supabase.functions.invoke` surfaces them as a
 * `FunctionsHttpError` whose `.message` is the opaque generic
 * "Edge Function returned a non-2xx status code". The result: users see a
 * meaningless string instead of a helpful explanation.
 *
 * This helper reads the underlying response body (available on
 * `error.context`, which is the `Response` object; see
 * `@supabase/functions-js` `FunctionsClient.invoke`) and matches it against a
 * set of KNOWN, safe backend strings. Anything that matches returns a curated,
 * user-friendly message; anything that does not match falls back to a generic
 * safe message. **Raw server text is never surfaced to the user**, so internal
 * details (variable names, file paths, partial secrets) cannot leak.
 *
 * No backend behavior is changed - this is a read-only, presentation-layer map.
 */

export type OAuthPlatformLabel =
  | "Instagram"
  | "Instagram Business"
  | "TikTok"
  | "Pinterest";

interface OAuthErrorHint {
  name: string;
  message: string;
  status: number;
}

const unavailableMessage = (platform: OAuthPlatformLabel, includeNetworkHint = false) =>
  includeNetworkHint
    ? `${platform} connection service is temporarily unavailable. Please check your internet connection and try again.`
    : `${platform} connection service is temporarily unavailable. Please try again in a moment.`;

function isNetworkFailure(name: string, message: string): boolean {
  return (
    name === "FunctionsFetchError" ||
    name === "FunctionsRelayError" ||
    (name === "TypeError" && /fetch|network|failed to fetch/i.test(message))
  );
}

function parseResponseMessage(raw: string): string {
  try {
    const body = JSON.parse(raw);
    return typeof body?.error === "string"
      ? body.error
      : typeof body?.message === "string"
        ? body.message
        : "";
  } catch {
    return raw.trim().slice(0, 200);
  }
}

async function getOAuthErrorHint(error: unknown): Promise<OAuthErrorHint> {
  const name = (error as { name?: string } | null)?.name ?? "";
  const fallbackMessage = error instanceof Error ? error.message : "";
  const context = (error as { context?: Response } | null)?.context;

  if (!context || typeof context.status !== "number") {
    return { name, message: fallbackMessage, status: 0 };
  }

  const raw = await context.clone().text().catch(() => "");
  return { name, message: parseResponseMessage(raw), status: context.status };
}

function mapOAuthHintToMessage(
  hint: OAuthErrorHint,
  platform: OAuthPlatformLabel,
): string | null {
  if (isNetworkFailure(hint.name, hint.message)) {
    return unavailableMessage(platform, hint.name !== "FunctionsRelayError");
  }
  if ([502, 503, 504].includes(hint.status)) {
    return unavailableMessage(platform);
  }
  if (
    hint.status === 401 ||
    /\bunauthorized\b|\bnot authenticated\b|session[\s-]*(expired|invalid)/i.test(hint.message)
  ) {
    return `Your session has expired. Please sign in again, then reconnect ${platform}.`;
  }
  if (
    hint.status === 403 ||
    /\baccess_denied\b|\bforbidden\b|\bdenied\b|\bcancel/i.test(hint.message)
  ) {
    return `${platform} connection was denied or cancelled. Please try again and approve the permission prompt.`;
  }
  return null;
}

function mapKnownProviderMessage(
  message: string,
  platform: OAuthPlatformLabel,
): string | null {
  if (/redirect[_ ]?uri|redirect.*mismatch|mismatch.*redirect/i.test(message)) {
    return `The ${platform} redirect address isn't registered correctly. Please contact support.`;
  }
  if (
    /authentication failed|invalid (?:client|credentials|app|token)|app credentials/i.test(message)
  ) {
    return `We couldn't authenticate the ${platform} connection. Please try again, or contact support if it continues.`;
  }
  if (
    /not configured|configuration is incomplete|service configuration error|credentials not configured/i.test(message)
  ) {
    return `${platform} isn't set up correctly on the server yet. Please try again later or contact support.`;
  }
  if (/no authorization url|no .*url.*received/i.test(message)) {
    return `We couldn't start the ${platform} connection. Please try again.`;
  }
  return null;
}

/**
 * Map an OAuth `invoke` error (or a locally thrown `Error`) to a safe,
 * user-facing message for the given platform.
 *
 * Safe by construction: the returned string is always one of the curated
 * messages below - never a pass-through of server-provided text.
 */
export async function describeOAuthError(
  error: unknown,
  platform: OAuthPlatformLabel,
): Promise<string> {
  const hint = await getOAuthErrorHint(error);
  const statusMessage = mapOAuthHintToMessage(hint, platform);
  if (statusMessage) return statusMessage;

  const providerMessage = mapKnownProviderMessage(hint.message, platform);
  if (providerMessage) return providerMessage;

  if (hint.status >= 500) {
    return `${platform} connection service hit an unexpected error. Please try again in a moment.`;
  }

  return `We couldn't connect to ${platform}. Please try again, or contact support if it continues.`;
}
