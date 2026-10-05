// Web search over the admin's Search ladder (/admin/settings → Search Models).
//
// Opt-in only: the AI agent exposes a `web_search` tool only when its account switched
// "Use web search" on, and caption generation searches only when the request asks for
// it. A search adds one to several seconds, so it never runs by default.
//
// Spec: docs/superpowers/specs/2026-10-05-vision-ladder-and-model-cleanup.md (Phase D)

import { fetchCategoryAiSettings } from "./ai-fallback.ts";
import { resolveProviderKey } from "./providerKeys.ts";

export interface WebSearchTier {
  provider: string;
  model: string;
  apiKey: string;
}

export interface WebSearchSource {
  title: string;
  url: string;
}

export interface WebSearchResult {
  provider: string;
  model: string;
  /** A short answer or digest, ready to hand to a model. */
  answer: string;
  sources: WebSearchSource[];
}

export interface WebSearchRun {
  result: WebSearchResult | null;
  errors: Array<{ tier: string; error: string }>;
}

/** Providers this module can call. Anything else in a ladder slot is skipped. */
export const SEARCH_PROVIDERS = ["perplexity", "brave_search", "exa"] as const;
type SearchProvider = typeof SEARCH_PROVIDERS[number];

const isSearchProvider = (code: string): code is SearchProvider =>
  (SEARCH_PROVIDERS as readonly string[]).includes(code);

/**
 * Perplexity's deep-research models took over 40 s on 2026-10-05; nothing interactive
 * can wait for that, so such a rung is skipped rather than allowed to burn the budget
 * on every search. `sonar` / `sonar-pro` answered in 1.8 s.
 */
const isInteractiveModel = (provider: string, model: string) =>
  !(provider === "perplexity" && model.toLowerCase().includes("deep-research"));

const MAX_ANSWER_CHARS = 2000;
const MAX_SOURCES = 5;
const MAX_QUERY_CHARS = 400;

export const DEFAULT_SEARCH_TIER_TIMEOUT_MS = 8000;

/** The admin's Search ladder, in order, keeping only rungs this module can call with a key. */
export async function resolveSearchTiers(
  // deno-lint-ignore no-explicit-any
  admin: any,
): Promise<WebSearchTier[]> {
  const settings = await fetchCategoryAiSettings(admin, "search");
  const ordered = [
    { provider: settings.primaryProvider, model: settings.primaryModel },
    { provider: settings.fallbackProvider, model: settings.fallbackModel },
    { provider: settings.lastResortProvider, model: settings.lastResortModel },
  ];
  const tiers: WebSearchTier[] = [];
  const seen = new Set<string>();
  const keys = new Map<string, string | null>();
  for (const { provider, model } of ordered) {
    if (!provider || !isSearchProvider(provider) || !isInteractiveModel(provider, model ?? "")) continue;
    const dedupe = `${provider}/${model}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    if (!keys.has(provider)) keys.set(provider, await resolveProviderKey(admin, provider));
    const apiKey = keys.get(provider);
    if (!apiKey) {
      console.warn(`[web-search] no API key for ${provider}; skipping that tier`);
      continue;
    }
    tiers.push({ provider, model: model ?? "", apiKey });
  }
  return tiers;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function sourcesFrom(items: unknown): WebSearchSource[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    if (typeof item === "string") return [{ title: item, url: item }];
    const row = item as { title?: unknown; url?: unknown };
    return typeof row?.url === "string" ? [{ title: typeof row.title === "string" ? row.title : row.url, url: row.url }] : [];
  }).slice(0, MAX_SOURCES);
}

async function searchPerplexity(tier: WebSearchTier, query: string, signal: AbortSignal, fetcher: typeof fetch) {
  const response = await fetcher("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${tier.apiKey}`, "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model: tier.model || "sonar",
      max_tokens: 400,
      messages: [
        { role: "system", content: "Answer briefly with current, factual information. Keep the original language of the question." },
        { role: "user", content: query },
      ],
    }),
  });
  if (!response.ok) throw new Error(`perplexity ${response.status}`);
  const data = await response.json();
  const answer = String(data?.choices?.[0]?.message?.content ?? "").trim();
  if (!answer) throw new Error("perplexity returned no answer");
  return { answer, sources: sourcesFrom(data?.search_results ?? data?.citations) };
}

async function searchBrave(tier: WebSearchTier, query: string, signal: AbortSignal, fetcher: typeof fetch) {
  const url = `https://api.search.brave.com/res/v1/web/search?count=${MAX_SOURCES}&q=${encodeURIComponent(query)}`;
  const response = await fetcher(url, {
    headers: { "X-Subscription-Token": tier.apiKey, Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`brave ${response.status}`);
  const data = await response.json();
  const results = (data?.web?.results ?? []) as Array<{ title?: string; url?: string; description?: string }>;
  if (!results.length) throw new Error("brave returned no results");
  const answer = results.slice(0, MAX_SOURCES)
    .map((r) => `- ${r.title ?? ""}: ${(r.description ?? "").replace(/<[^>]+>/g, "")}`).join("\n");
  return { answer, sources: sourcesFrom(results) };
}

async function searchExa(tier: WebSearchTier, query: string, signal: AbortSignal, fetcher: typeof fetch) {
  const response = await fetcher("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": tier.apiKey, "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({ query, numResults: MAX_SOURCES, contents: { text: { maxCharacters: 300 } } }),
  });
  if (!response.ok) throw new Error(`exa ${response.status}`);
  const data = await response.json();
  const results = (data?.results ?? []) as Array<{ title?: string; url?: string; text?: string }>;
  if (!results.length) throw new Error("exa returned no results");
  const answer = results.slice(0, MAX_SOURCES).map((r) => `- ${r.title ?? ""}: ${(r.text ?? "").trim()}`).join("\n");
  return { answer, sources: sourcesFrom(results) };
}

const ADAPTERS: Record<SearchProvider, typeof searchPerplexity> = {
  perplexity: searchPerplexity,
  brave_search: searchBrave,
  exa: searchExa,
};

/**
 * Tries each tier in order under one overall budget. Never throws: a failed search is an
 * ordinary outcome, and the caller simply answers without fresh web results. Errors carry
 * the status only, never a provider body or a key.
 */
export async function searchWeb(
  query: string,
  tiers: WebSearchTier[],
  options: { tierTimeoutMs?: number; budgetMs?: number; fetcher?: typeof fetch; now?: () => number } = {},
): Promise<WebSearchRun> {
  const tierTimeoutMs = options.tierTimeoutMs ?? DEFAULT_SEARCH_TIER_TIMEOUT_MS;
  const budgetMs = options.budgetMs ?? tierTimeoutMs * 2;
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const trimmed = query.trim().slice(0, MAX_QUERY_CHARS);
  const errors: WebSearchRun["errors"] = [];
  if (!trimmed) return { result: null, errors: [{ tier: "-", error: "empty query" }] };

  const startedAt = now();
  for (const tier of tiers) {
    const label = `${tier.provider}/${tier.model}`;
    const remaining = budgetMs - (now() - startedAt);
    if (remaining <= 0) {
      errors.push({ tier: label, error: "budget exhausted" });
      break;
    }
    if (!isSearchProvider(tier.provider)) {
      errors.push({ tier: label, error: "unsupported provider" });
      continue;
    }
    try {
      const signal = AbortSignal.timeout(Math.min(tierTimeoutMs, remaining));
      const { answer, sources } = await ADAPTERS[tier.provider](tier, trimmed, signal, fetcher);
      return {
        result: { provider: tier.provider, model: tier.model, answer: clip(answer, MAX_ANSWER_CHARS), sources },
        errors,
      };
    } catch (error) {
      errors.push({ tier: label, error: error instanceof Error ? (error.name === "TimeoutError" ? "timeout" : error.message) : "error" });
    }
  }
  return { result: null, errors };
}

/** A result as plain text a model can quote from, with its sources listed. */
export function formatSearchResult(result: WebSearchResult): string {
  const sources = result.sources.length
    ? `\nSources:\n${result.sources.map((s) => `- ${s.title} (${s.url})`).join("\n")}`
    : "";
  return `${result.answer}${sources}`;
}
