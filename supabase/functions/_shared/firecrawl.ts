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

/**
 * Wall-clock ceiling on every provider request.
 *
 * Without one, a connection Firecrawl accepts and then stalls holds the edge
 * isolate until the gateway kills it -- and the catch path that would record
 * the failure never runs. For a page scrape that leaves the row `processing`
 * with no `queued_at`, which the claim function refuses, so nothing can reclaim
 * it and the UI polls it forever. A scrape gets longer than a status poll
 * because it is rendering a page; both stay well inside the ~60s ceiling.
 */
const SCRAPE_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 15_000;

/**
 * How many result pages a completed crawl may span before we refuse it.
 *
 * The UI caps a crawl at 200 pages and Firecrawl batches results well below
 * that, so this is a runaway guard rather than a real ceiling -- but an
 * unbounded follow loop inside a 45-second worker budget is its own failure.
 */
const MAX_RESULT_PAGES = 20;

/** Below this much budget left, do not start another results page. */
const MIN_PAGE_MS = 3_000;

/** fetch with an abort signal, so a stalled provider becomes a catchable error. */
async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
  what: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch (error) {
    // AbortError is the timeout; anything else is a transport failure. Both
    // become a FirecrawlError so the caller's existing catch persists them.
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new FirecrawlError(
      aborted
        ? `Firecrawl ${what} timed out after ${Math.round(timeoutMs / 1000)}s`
        : `Firecrawl ${what} could not be reached: ${String((error as Error)?.message ?? error).slice(0, 200)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

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
  const { data, error } = await admin
    .from("provider_api_keys")
    .select("api_key")
    .eq("provider_code", "firecrawl")
    .maybeSingle();
  // A failed read is NOT an absent key. Collapsing the two would report a
  // database timeout as "not configured" and send the operator to a settings
  // page where the key is already sitting, correctly, in place.
  if (error) {
    throw new FirecrawlError(
      `Could not read the Firecrawl API key: ${String(error.message ?? error).slice(0, 200)}`,
    );
  }
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
  const response = await fetchWithTimeout(
    fetchImpl,
    `${API}/scrape`,
    {
      method: "POST",
      headers: authHeaders(key),
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
    },
    SCRAPE_TIMEOUT_MS,
    "scrape",
  );
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
  const response = await fetchWithTimeout(
    fetchImpl,
    `${API}/crawl`,
    {
      method: "POST",
      headers: authHeaders(key),
      body: JSON.stringify({
        url,
        limit,
        scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
      }),
    },
    STATUS_TIMEOUT_MS,
    "crawl",
  );
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
  /**
   * Absolute epoch-ms ceiling for the WHOLE call, pagination included.
   *
   * Without it, up to 20 follow-up pages each get their own 15s timeout while
   * the HTTP worker has 45s in total -- so a slow-paginating crawl burns the
   * edge lifetime before anything is embedded or checkpointed, the row stays
   * `processing`, and every stale reclaim starts pagination from the beginning
   * again. Each request now gets whatever time is actually left.
   */
  deadline?: number,
): Promise<CrawlStatus> {
  const remaining = () =>
    deadline === undefined ? STATUS_TIMEOUT_MS : Math.min(STATUS_TIMEOUT_MS, deadline - Date.now());
  const response = await fetchWithTimeout(
    fetchImpl,
    `${API}/crawl/${encodeURIComponent(jobId)}`,
    { headers: authHeaders(key) },
    remaining(),
    "crawl status",
  );
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
    // A large crawl paginates its results: the body carries this batch plus a
    // `next` URL. Ignoring it would embed only the first page and mark the
    // source ready -- a whole-site crawl reporting success having indexed a
    // fraction of the site, with nothing anywhere saying so.
    const pages = toPages(body?.data);
    let next = typeof body?.next === "string" ? body.next : null;
    let guard = 0;
    while (next && guard < MAX_RESULT_PAGES) {
      guard += 1;
      // Out of budget mid-pagination is NOT a completed crawl. Reporting
      // `running` sends the row back to the queue with its job intact, so the
      // next tick starts over with a full budget -- where returning what we had
      // would mark a partial site ready.
      if (deadline !== undefined && Date.now() >= deadline - MIN_PAGE_MS) {
        return { state: "running", completed, total, pages: [] };
      }
      const page = await fetchWithTimeout(
        fetchImpl,
        next,
        { headers: authHeaders(key) },
        remaining(),
        "crawl results page",
      );
      const pageBody = await readResponse(page, "crawl results page");
      pages.push(...toPages(pageBody?.data));
      next = typeof pageBody?.next === "string" ? pageBody.next : null;
    }
    if (next) {
      // Refusing beats silently truncating: a source marked ready with two
      // thirds of a site in it is a lie the UI cannot correct.
      throw new FirecrawlError(
        `That crawl returned more than ${MAX_RESULT_PAGES} result pages. Lower the page limit and try again.`,
      );
    }
    return { state: "completed", completed, total, pages };
  }
  return { state: "running", completed, total, pages: [] };
}

/**
 * Best-effort cancellation of a crawl whose source is being deleted.
 *
 * Never throws: the delete must succeed whether or not Firecrawl cooperates,
 * and a crawl left running is a billing annoyance, not a reason to strand a row
 * the user asked to remove. Returns whether the cancel was accepted so the
 * caller can log it.
 */
export async function firecrawlCancelCrawl(
  key: string,
  jobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      `${API}/crawl/${encodeURIComponent(jobId)}`,
      { method: "DELETE", headers: authHeaders(key) },
      STATUS_TIMEOUT_MS,
      "crawl cancel",
    );
    return response.ok;
  } catch (error) {
    console.error(`[firecrawl] cancel failed for ${jobId}: ${String((error as Error)?.message ?? error)}`);
    return false;
  }
}
