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

export function redactProviderError(message: string, apiKey: string): string {
  return (apiKey ? message.split(apiKey).join("[REDACTED]") : message)
    .replace(
      /["']?(authorization|x-api-key)["']?\s*[:=]\s*[^\r\n,}]+/gi,
      "$1: [REDACTED]",
    )
    .slice(0, 500);
}
