import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { processWebsiteSource, type WorkerDependencies } from "./index.ts";
import { resolveDualEmbeddingConfigFromDb } from "../_shared/knowledgeEmbeddings.ts";

/**
 * Records every `.update()` payload so a test can assert on the row the worker
 * left behind, which is the only thing the next tick and the UI can see.
 */
function fakeAdmin(updates: Record<string, unknown>[], chunkRows: unknown[] = []) {
  const table = (name: string) => ({
    update: (payload: Record<string, unknown>) => {
      updates.push({ table: name, ...payload });
      return { eq: () => Promise.resolve({ error: null }) };
    },
    insert: () => Promise.resolve({ error: null }),
    // claimEmbeddingColumnOwnership writes through upsert once per run.
    upsert: () => Promise.resolve({ error: null }),
    delete: () => ({
      eq: () => Promise.resolve({ error: null }),
      in: () => Promise.resolve({ error: null }),
    }),
    select: () => ({
      eq: () => Promise.resolve({ data: chunkRows, error: null }),
    }),
  });
  return { from: table };
}

const deps = (overrides: Partial<WorkerDependencies> = {}): WorkerDependencies => ({
  // 1024 dimensions, because the resolved config validates the width -- a
  // one-element vector fails inside the embed loop and the outcome then looks
  // like a website bug rather than a fixture one.
  embed: (texts: string[]) =>
    Promise.resolve({ primary: texts.map(() => new Array(1024).fill(0.1)), fallback: null }),
  // The real resolver against a stubbed env, exactly as index.test.ts does --
  // an empty config object would make dualEmbeddingRecord write no column and
  // the failure would look like a website bug.
  resolveConfig: (admin: unknown) => resolveDualEmbeddingConfigFromDb(admin as never, () => undefined),
  now: () => Date.now(),
  firecrawlKey: () => Promise.resolve("k"),
  crawlStatus: () =>
    Promise.resolve({ state: "running" as const, completed: 0, total: 0, pages: [] }),
  scrapePage: () =>
    Promise.resolve({ url: "https://x.com", title: "X", markdown: "hello world" }),
  ...overrides,
});

const websiteSource = (metadata: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: "s1",
  user_id: "u1",
  source_type: "website",
  file_name: "x.com",
  file_path: "https://x.com",
  chunk_count: 0,
  created_at: new Date().toISOString(),
  metadata,
  ...extra,
});

Deno.test("a crawl still running is released back to pending, not failed", async () => {
  // The claim marked it 'processing'. Returning it to 'pending' is what lets the
  // next tick pick it up; leaving it 'processing' means only the 10-minute stale
  // reclaim ever touches it again, so a 20-page crawl would crawl in 10-minute
  // steps.
  const updates: Record<string, unknown>[] = [];
  const outcome = await processWebsiteSource(
    fakeAdmin(updates),
    websiteSource({ crawl_job_id: "j", mode: "site", url: "https://x.com" }),
    deps({
      crawlStatus: () =>
        Promise.resolve({ state: "running", completed: 2, total: 9, pages: [] }),
    }),
  );
  assertEquals(outcome.status, "processing");
  const last = updates.at(-1)!;
  assertEquals(last.status, "pending");
  assertEquals((last.metadata as Record<string, unknown>).pages_done, 2);
  assertEquals((last.metadata as Record<string, unknown>).pages_total, 9);
});

Deno.test("a completed crawl embeds every page and goes ready", async () => {
  const updates: Record<string, unknown>[] = [];
  const outcome = await processWebsiteSource(
    fakeAdmin(updates),
    websiteSource({ crawl_job_id: "j", mode: "site", url: "https://x.com" }),
    deps({
      crawlStatus: () =>
        Promise.resolve({
          state: "completed",
          completed: 2,
          total: 2,
          pages: [
            { url: "https://x.com/a", title: "A", markdown: "alpha" },
            { url: "https://x.com/b", title: "B", markdown: "beta" },
          ],
        }),
    }),
  );
  assertEquals(outcome.status, "ready");
  assertEquals(updates.at(-1)!.status, "ready");
});

Deno.test("a completed crawl that returned no pages fails rather than going ready", async () => {
  // "Ready, 0 chunks" tells the user their site was read and the agent knows
  // nothing. Naming it a failure is the honest outcome.
  const updates: Record<string, unknown>[] = [];
  const outcome = await processWebsiteSource(
    fakeAdmin(updates),
    websiteSource({ crawl_job_id: "j", mode: "site" }),
    deps({
      crawlStatus: () =>
        Promise.resolve({ state: "completed", completed: 0, total: 0, pages: [] }),
    }),
  );
  assertEquals(outcome.status, "failed");
});

Deno.test("a failed crawl records the provider's own reason", async () => {
  const updates: Record<string, unknown>[] = [];
  const outcome = await processWebsiteSource(
    fakeAdmin(updates),
    websiteSource({ crawl_job_id: "j", mode: "site" }),
    deps({
      crawlStatus: () =>
        Promise.resolve({
          state: "failed",
          completed: 0,
          total: 0,
          pages: [],
          error: "blocked by robots",
        }),
    }),
  );
  assertEquals(outcome.status, "failed");
  assertEquals(updates.at(-1)!.error, "blocked by robots");
});

Deno.test("a crawl older than thirty minutes fails rather than polling forever", async () => {
  const updates: Record<string, unknown>[] = [];
  const outcome = await processWebsiteSource(
    fakeAdmin(updates),
    websiteSource({
      crawl_job_id: "j",
      mode: "site",
      crawl_started_at: new Date(Date.now() - 31 * 60_000).toISOString(),
    }),
    deps({
      crawlStatus: () =>
        Promise.resolve({ state: "running", completed: 1, total: 9, pages: [] }),
    }),
  );
  assertEquals(outcome.status, "failed");
  assertEquals(String(updates.at(-1)!.error).includes("timed out"), true);
});

Deno.test("a site source with no crawl job id fails immediately", async () => {
  const updates: Record<string, unknown>[] = [];
  const outcome = await processWebsiteSource(
    fakeAdmin(updates),
    websiteSource({ mode: "site" }),
    deps(),
  );
  assertEquals(outcome.status, "failed");
});

Deno.test("a page source with no crawl job re-scrapes its URL", async () => {
  // The page path queues without a job id when one page produced more chunks
  // than fit inline. Re-scraping is one cheap call; storing the markdown in the
  // row would put a whole page into a jsonb column read on every list query.
  const updates: Record<string, unknown>[] = [];
  let scraped = "";
  const outcome = await processWebsiteSource(
    fakeAdmin(updates),
    websiteSource({ mode: "page", url: "https://x.com/deep" }),
    deps({
      scrapePage: (_key: string, url: string) => {
        scraped = url;
        return Promise.resolve({ url, title: "Deep", markdown: "lots of text" });
      },
    }),
  );
  assertEquals(scraped, "https://x.com/deep");
  assertEquals(outcome.status, "ready");
});

Deno.test("a page source with no usable URL fails rather than scraping nothing", async () => {
  const updates: Record<string, unknown>[] = [];
  const outcome = await processWebsiteSource(
    fakeAdmin(updates),
    websiteSource({ mode: "page" }, { file_path: null }),
    deps(),
  );
  assertEquals(outcome.status, "failed");
});

Deno.test("the timeout runs from the crawl, not from when the row was created", async () => {
  // A source queued behind other work can sit for a long time before its job is
  // polled once. Timing from created_at would spend the whole 30-minute budget
  // waiting in the queue and fail a crawl that had barely started.
  const updates: Record<string, unknown>[] = [];
  const outcome = await processWebsiteSource(
    fakeAdmin(updates),
    websiteSource(
      {
        crawl_job_id: "j",
        mode: "site",
        crawl_started_at: new Date(Date.now() - 60_000).toISOString(),
      },
      { created_at: new Date(Date.now() - 90 * 60_000).toISOString() },
    ),
    deps({
      crawlStatus: () =>
        Promise.resolve({ state: "running", completed: 1, total: 9, pages: [] }),
    }),
  );
  assertEquals(outcome.status, "processing");
});

Deno.test("a source predating crawl_started_at still times out on created_at", async () => {
  const updates: Record<string, unknown>[] = [];
  const outcome = await processWebsiteSource(
    fakeAdmin(updates),
    websiteSource(
      { crawl_job_id: "j", mode: "site" },
      { created_at: new Date(Date.now() - 31 * 60_000).toISOString() },
    ),
    deps({
      crawlStatus: () =>
        Promise.resolve({ state: "running", completed: 1, total: 9, pages: [] }),
    }),
  );
  assertEquals(outcome.status, "failed");
});
