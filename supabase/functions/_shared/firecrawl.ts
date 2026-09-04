/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Firecrawl v2 client.
 *
 * One page is scraped inline; a whole site is a job the queue worker polls,
 * because a crawl outlives the edge runtime's ~60s ceiling by minutes.
 *
 * Every response goes through one reader, which treats a 2xx carrying
 * `success: false` as a failure. That shape has bitten this codebase before:
 * OpenRouter answers 200 with the provider's error and no choices, and six
 * functions still read it as success. A crawl that "succeeded" with no pages
 * would mark a knowledge source ready and contribute nothing to retrieval.
 */

const API = "https://api.firecrawl.dev/v2";

export interface FirecrawlPage {
  url: string;
  title: string;
  markdown: string;
}

export interface CrawlStatus {
  state: "running" | "completed" | "failed";
  completed: number;
  total: number;
  pages: FirecrawlPage[];
  error?: string;
}

export class FirecrawlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirecrawlError";
  }
}

/** Firecrawl's own key, then the admin-managed one. Never a silent no-op. */
export async function resolveFirecrawlKey(admin: any): Promise<string> {
  const fromEnv = Deno.env.get("FIRECRAWL_API_KEY");
  if (fromEnv) return fromEnv;
  const { data } = await admin
    .from("provider_api_keys")
    .select("api_key")
    .eq("provider_code", "firecrawl")
    .maybeSingle();
  if (data?.api_key) return data.api_key as string;
  throw new FirecrawlError(
    "Website scraping is not configured. Add a Firecrawl API key in Admin → Settings → AI Providers.",
  );
}

/**
 * The one place a Firecrawl response becomes either data or an error.
 *
 * A non-2xx names its status, because "Firecrawl failed" with no number sends
 * the reader looking in the wrong place — 402 is billing, 429 is rate limiting,
 * 502 is theirs.
 */
async function readResponse(response: Response, what: string): Promise<any> {
  const text = await response.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    // A gateway HTML page, not JSON. Keep a short excerpt: the status alone
    // does not distinguish "their edge is down" from "we sent nonsense".
    if (!response.ok) {
      throw new FirecrawlError(`Firecrawl ${what} failed (${response.status}): ${text.slice(0, 200)}`);
    }
    throw new FirecrawlError(`Firecrawl ${what} returned a response that was not JSON.`);
  }
  if (!response.ok) {
    const detail = String(body?.error ?? body?.message ?? "").slice(0, 300);
    throw new FirecrawlError(`Firecrawl ${what} failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  // A 200 that says it did not succeed. The status line is not the answer.
  if (body?.success === false) {
    const detail = String(body?.error ?? "unknown error").slice(0, 300);
    throw new FirecrawlError(`Firecrawl ${what} failed: ${detail}`);
  }
  return body;
}

function authHeaders(key: string) {
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

/**
 * A page's markdown, or an error.
 *
 * A title falls back to the URL rather than to "": the title becomes the first
 * line of the indexed chunk, and an empty one costs a retrieval signal.
 */
export async function firecrawlScrape(
  key: string,
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FirecrawlPage> {
  const response = await fetchImpl(`${API}/scrape`, {
    method: "POST",
    headers: authHeaders(key),
    body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
  });
  const body = await readResponse(response, "scrape");
  const markdown = String(body?.data?.markdown ?? "").trim();
  if (!markdown) {
    throw new FirecrawlError("Firecrawl returned no readable text for that page.");
  }
  const metadata = body?.data?.metadata ?? {};
  return {
    url: String(metadata.sourceURL || url),
    title: String(metadata.title || url),
    markdown,
  };
}

/** Starts a crawl and returns its job id. */
export async function firecrawlStartCrawl(
  key: string,
  url: string,
  limit: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(`${API}/crawl`, {
    method: "POST",
    headers: authHeaders(key),
    body: JSON.stringify({
      url,
      limit,
      scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
    }),
  });
  const body = await readResponse(response, "crawl");
  const id = body?.id;
  if (typeof id !== "string" || !id) {
    throw new FirecrawlError("Firecrawl accepted the crawl but returned no job id.");
  }
  return id;
}

function toPages(data: unknown): FirecrawlPage[] {
  if (!Array.isArray(data)) return [];
  const pages: FirecrawlPage[] = [];
  for (const entry of data) {
    const markdown = String((entry as any)?.markdown ?? "").trim();
    // A page with no text is dropped rather than embedded as an empty chunk.
    if (!markdown) continue;
    const metadata = (entry as any)?.metadata ?? {};
    const url = String(metadata.sourceURL || "");
    pages.push({ url, title: String(metadata.title || url), markdown });
  }
  return pages;
}

/**
 * Where a crawl has got to.
 *
 * An unrecognised status maps to `running`, never to `completed`. Guessing done
 * would mark the source ready with whatever partial pages happened to be
 * present, and the 30-minute timeout in the worker is what stops a genuinely
 * stuck job polling forever.
 */
export async function firecrawlCrawlStatus(
  key: string,
  jobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CrawlStatus> {
  const response = await fetchImpl(`${API}/crawl/${encodeURIComponent(jobId)}`, {
    headers: authHeaders(key),
  });
  const body = await readResponse(response, "crawl status");
  const status = String(body?.status ?? "");
  const completed = Number(body?.completed ?? 0) || 0;
  const total = Number(body?.total ?? 0) || 0;

  if (status === "failed" || status === "cancelled") {
    return {
      state: "failed",
      completed,
      total,
      pages: [],
      error: String(body?.error ?? `Crawl ${status}`).slice(0, 300),
    };
  }
  if (status === "completed") {
    return { state: "completed", completed, total, pages: toPages(body?.data) };
  }
  return { state: "running", completed, total, pages: [] };
}
