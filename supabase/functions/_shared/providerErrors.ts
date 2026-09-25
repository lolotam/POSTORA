// The gateway authenticated the key but refuses inference until billing is set up.
export function isBillingBlocked(status: number, bodyText: string): boolean {
  return status === 403 && bodyText.includes("customer_verification_required");
}

export class ProviderTestError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message);
  }
}

// Maps a provider's failed HTTP response to the message the admin Test card shows.
export function describeProviderFailure(name: string, status: number, bodyText: string): string {
  if (isBillingBlocked(status, bodyText)) {
    return "Key is valid — add a credit card to your Vercel team (AI Gateway) to enable requests";
  }
  if (status === 401) return "Invalid API key";
  // xAI answers an out-of-credit team with 403 permission-denied.
  if (status === 403 && /used all available credits|spending limit/i.test(bodyText)) {
    return "API key is valid, but the account has used its credits or reached its spending limit. Please top up your account.";
  }
  if (status === 403) return "API key lacks required permissions";
  if (status === 429) {
    if (bodyText.includes("insufficient_balance") || bodyText.includes("1008")) {
      return "API key is valid, but the account has insufficient balance. Please top up your account.";
    }
    return "Rate limit exceeded";
  }
  try {
    const parsed = JSON.parse(bodyText);
    const message = parsed?.error?.message || parsed?.message || parsed?.error;
    if (typeof message === "string" && message) return `${name}: ${message}`;
  } catch { /* not JSON */ }
  return `${name} API error: ${status}`;
}
