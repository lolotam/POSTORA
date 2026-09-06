export const PROVIDERS = ["openai", "claude", "gemini", "openrouter"] as const;
export type Provider = typeof PROVIDERS[number];
export type ValidationOutcome = "valid" | "invalid" | "transient";

export function isProvider(value: unknown): value is Provider {
  return PROVIDERS.some((provider) => provider === value);
}

export function validationRequest(provider: Provider, apiKey: string): Request {
  const urls = {
    openai: "https://api.openai.com/v1/models",
    claude: "https://api.anthropic.com/v1/models",
    gemini: "https://generativelanguage.googleapis.com/v1beta/models",
    openrouter: "https://openrouter.ai/api/v1/key",
  };
  const url = new URL(urls[provider]);
  const headers = new Headers();
  if (provider === "claude") {
    headers.set("x-api-key", apiKey);
    headers.set("anthropic-version", "2023-06-01");
  } else if (provider === "gemini") {
    url.searchParams.set("key", apiKey);
  } else {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  // Never follow a redirect carrying a credential to a different endpoint.
  return new Request(url, { method: "GET", headers, redirect: "error" });
}

// 403 is "authenticated, but this probe endpoint is outside the key's scope":
// an OpenAI key restricted to chat completions is denied the model list yet
// works on the execution path. Only 401 (and Gemini's 400 for a bad key)
// prove the credential itself is wrong.
export function classifyResponse(status: number): ValidationOutcome {
  if (status >= 200 && status < 300) return "valid";
  if (status === 403) return "valid";
  if (status === 429 || status >= 500) return "transient";
  return "invalid";
}

export async function validateKey(
  provider: Provider,
  apiKey: string,
  fetcher: typeof fetch,
): Promise<ValidationOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetcher(validationRequest(provider, apiKey), {
      signal: controller.signal,
    });
    const outcome = classifyResponse(response.status);
    // Only the status is needed; do not read, retain, or log upstream bodies.
    await response.body?.cancel();
    return outcome;
  } catch {
    return "transient";
  } finally {
    clearTimeout(timer);
  }
}
