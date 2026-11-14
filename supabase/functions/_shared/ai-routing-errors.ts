export const AI_CONNECTION_REQUIRED = "AI_CONNECTION_REQUIRED";
export const AI_USER_KEY_INVALID = "AI_USER_KEY_INVALID";
export const AI_PROVIDER_UNREACHABLE = "AI_PROVIDER_UNREACHABLE";

export class ProviderHttpError extends Error {
  status: number;
  provider: string;
  credentialSource: "user" | "platform";

  constructor(message: string, details: {
    status: number;
    provider: string;
    credentialSource: "user" | "platform";
  }) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = details.status;
    this.provider = details.provider;
    this.credentialSource = details.credentialSource;
  }
}

/**
 * Strips the query string out of every URL in a message and redacts a parameter
 * that names a credential, whether or not it sits inside a URL.
 *
 * WHY this exists
 * A provider request that carries its credential in the URL puts that credential in
 * every error message about the request: a fetch rejection embeds the URL, a proxy
 * log line embeds it, an access log embeds it. The query string is the part that
 * holds the secret, so it goes; the origin and the path stay, because they say
 * which provider was reached and carry nothing secret.
 */
export function redactProviderUrl(message: string): string {
  return message
    // A whole URL: keep the origin and the path, drop the query string.
    .replace(/(https?:\/\/[^\s"'<>?]+)\?[^\s"'<>]*/g, "$1?[REDACTED]")
    // A credential-named parameter on its own, with or without a URL around it.
    .replace(
      /((?:^|[?&\s])(?:key|api[_-]?key|token|access[_-]?token|secret|password|auth)=)[^&\s"'<>]*/gi,
      "$1[REDACTED]",
    );
}

export function redactProviderError(message: string, apiKey: string): string {
  return redactProviderUrl(
    (apiKey ? message.split(apiKey).join("[REDACTED]") : message).replace(
      /["']?(authorization|x-api-key)["']?\s*[:=]\s*[^\r\n,}]+/gi,
      "$1: [REDACTED]",
    ),
  ).slice(0, 500);
}
