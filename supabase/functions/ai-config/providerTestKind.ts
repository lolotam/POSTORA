// Which probe proves a provider's key works. test-connection, set-service-key and
// test-service each used to carry their own copy of this chain; they drifted, and
// the card Test sent Firecrawl and ElevenLabs keys to /chat/completions.
export type ProviderTestKind =
  | "firecrawl" | "apify" | "elevenlabs" | "brave" | "exa" | "jina"
  | "zai" | "xai" | "minimax" | "perplexity"
  | "google" | "anthropic" | "openai";

const BY_CODE: Record<string, ProviderTestKind> = {
  firecrawl: "firecrawl", apify: "apify", elevenlabs: "elevenlabs", brave_search: "brave", exa: "exa",
  jina: "jina", zai: "zai", xai: "xai", minimax: "minimax", perplexity: "perplexity",
};

export function providerTestKind(provider: { provider_code: string; api_type?: string | null }): ProviderTestKind {
  const byCode = BY_CODE[provider.provider_code];
  if (byCode) return byCode;
  if (provider.api_type === "elevenlabs") return "elevenlabs";
  if (provider.api_type === "google") return "google";
  if (provider.api_type === "anthropic") return "anthropic";
  return "openai";
}
