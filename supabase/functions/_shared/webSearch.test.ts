// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { formatSearchResult, resolveSearchTiers, searchWeb, type WebSearchTier } from "./webSearch.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const perplexity: WebSearchTier = { provider: "perplexity", model: "sonar", apiKey: "pk" };
const brave: WebSearchTier = { provider: "brave_search", model: "brave-web-search", apiKey: "bk" };
const exa: WebSearchTier = { provider: "exa", model: "exa", apiKey: "ek" };

Deno.test("perplexity answers with its sources, key in the header", async () => {
  const seen: { url?: string; init?: RequestInit } = {};
  const run = await searchWeb("gold price in Kuwait today?", [perplexity], {
    fetcher: (url, init) => {
      seen.url = String(url);
      seen.init = init;
      return Promise.resolve(json({
        choices: [{ message: { content: "About 41.44 KWD per gram (24K)." } }],
        search_results: [{ title: "Gulf News", url: "https://gulfnews.com/gold" }],
      }));
    },
  });
  assertEquals(seen.url, "https://api.perplexity.ai/chat/completions");
  assertEquals((seen.init?.headers as Record<string, string>).Authorization, "Bearer pk");
  assertEquals(JSON.parse(String(seen.init?.body)).model, "sonar");
  assertEquals(run.result, {
    provider: "perplexity", model: "sonar", answer: "About 41.44 KWD per gram (24K).",
    sources: [{ title: "Gulf News", url: "https://gulfnews.com/gold" }],
  });
});

Deno.test("a failing tier falls through: perplexity 401 -> brave digest", async () => {
  const run = await searchWeb("gold price kuwait", [perplexity, brave], {
    fetcher: (url) =>
      Promise.resolve(String(url).includes("perplexity")
        ? new Response("bad key: secret echo", { status: 401 })
        : json({ web: { results: [{ title: "Kuwait gold", url: "https://x.example/g", description: "<b>41.4</b> KWD" }] } })),
  });
  assertEquals(run.result?.provider, "brave_search");
  assertEquals(run.result?.answer, "- Kuwait gold: 41.4 KWD");
  assertEquals(run.errors, [{ tier: "perplexity/sonar", error: "perplexity 401" }], "status only, never the body");
});

Deno.test("exa results become a digest with sources", async () => {
  const run = await searchWeb("q", [exa], {
    fetcher: () => Promise.resolve(json({ results: [{ title: "T", url: "https://e.example", text: " body " }] })),
  });
  assertEquals(run.result?.answer, "- T: body");
  assertEquals(run.result?.sources, [{ title: "T", url: "https://e.example" }]);
});

Deno.test("no result is an ordinary outcome, never a throw", async () => {
  const run = await searchWeb("q", [brave, exa], { fetcher: () => Promise.reject(new TypeError("reset")) });
  assertEquals(run.result, null);
  assertEquals(run.errors.length, 2);
  assertEquals((await searchWeb("   ", [brave])).result, null, "an empty query searches nothing");
});

Deno.test("a slow tier is cut so the next still answers", async () => {
  const run = await searchWeb("q", [perplexity, brave], {
    tierTimeoutMs: 50,
    budgetMs: 1000,
    fetcher: (url, init) =>
      String(url).includes("perplexity")
        ? new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))
        : Promise.resolve(json({ web: { results: [{ title: "ok", url: "https://ok.example", description: "d" }] } })),
  });
  assertEquals(run.result?.provider, "brave_search");
  assertEquals(run.errors, [{ tier: "perplexity/sonar", error: "timeout" }]);
});

Deno.test("formatSearchResult lists the sources under the answer", () => {
  assertEquals(
    formatSearchResult({ provider: "exa", model: "", answer: "A", sources: [{ title: "T", url: "https://u" }] }),
    "A\nSources:\n- T (https://u)",
  );
});

Deno.test("the ladder keeps only callable rungs, skips deep research, and dedupes", async () => {
  const rows = [
    { key: "default_ai_model_search", value: { provider_code: "perplexity", model_id: "sonar-deep-research" } },
    { key: "default_ai_model_search_fallback", value: { provider_code: "brave_search", model_id: "brave-web-search" } },
  ];
  const admin = {
    from: (table: string) => {
      if (table === "system_settings") return { select: () => ({ in: () => Promise.resolve({ data: rows, error: null }) }) };
      // provider_api_keys / ai_providers lookups used by resolveProviderKey
      const chain: any = { select: () => chain, eq: () => chain, maybeSingle: () => Promise.resolve({ data: { api_key: "k" }, error: null }) };
      return chain;
    },
  };
  const tiers = await resolveSearchTiers(admin);
  assertEquals(tiers.map((t) => `${t.provider}/${t.model}`), ["brave_search/brave-web-search"]);
  assert(tiers.every((t) => t.apiKey === "k"));
});
