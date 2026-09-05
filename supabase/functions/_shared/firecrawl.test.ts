import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  FirecrawlError,
  firecrawlCrawlStatus,
  firecrawlScrape,
  firecrawlStartCrawl,
  resolveFirecrawlKey,
} from "./firecrawl.ts";

const stub = (body: unknown, status = 200): typeof fetch =>
  (() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch;

Deno.test("scrape returns the markdown, title and resolved URL", async () => {
  const page = await firecrawlScrape(
    "k",
    "https://x.com",
    stub({
      success: true,
      data: { markdown: "# Hi", metadata: { title: "Hi", sourceURL: "https://x.com/" } },
    }),
  );
  assertEquals(page, { url: "https://x.com/", title: "Hi", markdown: "# Hi" });
});

Deno.test("a 200 carrying success:false is a failure, not a page", async () => {
  // The provider answers 200 with the error in the body. Six other Postora
  // functions read that shape as success; this one must not.
  await assertRejects(
    () => firecrawlScrape("k", "https://x.com", stub({ success: false, error: "credit limit reached" })),
    FirecrawlError,
    "credit limit reached",
  );
});

Deno.test("a 200 with no markdown at all is a failure", async () => {
  // An empty page indexed as a source is worse than none: it claims the site
  // was read and contributes nothing to retrieval.
  await assertRejects(
    () => firecrawlScrape("k", "https://x.com", stub({ success: true, data: {} })),
    FirecrawlError,
  );
});

Deno.test("a non-2xx names its status", async () => {
  await assertRejects(
    () => firecrawlScrape("k", "https://x.com", stub({ error: "nope" }, 402)),
    FirecrawlError,
    "402",
  );
});

Deno.test("a body that is not JSON is still a readable failure", async () => {
  const html = (() =>
    Promise.resolve(new Response("<html>gateway</html>", { status: 502 }))) as unknown as typeof fetch;
  await assertRejects(() => firecrawlScrape("k", "https://x.com", html), FirecrawlError, "502");
});

Deno.test("a page with no title falls back to its URL", async () => {
  const page = await firecrawlScrape(
    "k",
    "https://x.com/a",
    stub({ success: true, data: { markdown: "body", metadata: { sourceURL: "https://x.com/a" } } }),
  );
  assertEquals(page.title, "https://x.com/a");
});

Deno.test("startCrawl returns the job id", async () => {
  assertEquals(
    await firecrawlStartCrawl("k", "https://x.com", 50, stub({ success: true, id: "job-1" })),
    "job-1",
  );
});

Deno.test("startCrawl without an id is a failure, not an empty job", async () => {
  await assertRejects(
    () => firecrawlStartCrawl("k", "https://x.com", 50, stub({ success: true })),
    FirecrawlError,
  );
});

Deno.test("crawl status maps scraping to running and carries progress", async () => {
  const running = await firecrawlCrawlStatus(
    "k",
    "j",
    stub({ status: "scraping", completed: 3, total: 10, data: [] }),
  );
  assertEquals(running.state, "running");
  assertEquals(running.completed, 3);
  assertEquals(running.total, 10);
});

Deno.test("crawl status maps completed and returns every page", async () => {
  const done = await firecrawlCrawlStatus(
    "k",
    "j",
    stub({
      status: "completed",
      completed: 2,
      total: 2,
      data: [
        { markdown: "a", metadata: { title: "A", sourceURL: "https://x.com/a" } },
        { markdown: "b", metadata: { title: "B", sourceURL: "https://x.com/b" } },
      ],
    }),
  );
  assertEquals(done.state, "completed");
  assertEquals(done.pages.length, 2);
  assertEquals(done.pages[0].url, "https://x.com/a");
  assertEquals(done.pages[1].markdown, "b");
});

Deno.test("crawl status maps failed and carries the provider reason", async () => {
  const failed = await firecrawlCrawlStatus(
    "k",
    "j",
    stub({ status: "failed", error: "blocked by robots" }),
  );
  assertEquals(failed.state, "failed");
  assertEquals(failed.error, "blocked by robots");
});

Deno.test("an unknown status is treated as running, never as done", async () => {
  // Guessing "completed" on a status we do not recognise would mark a source
  // ready with whatever partial pages happened to be present.
  const unknown = await firecrawlCrawlStatus("k", "j", stub({ status: "queued", data: [] }));
  assertEquals(unknown.state, "running");
});

Deno.test("a page with no markdown is dropped, not passed on as empty", async () => {
  const done = await firecrawlCrawlStatus(
    "k",
    "j",
    stub({
      status: "completed",
      completed: 2,
      total: 2,
      data: [{ markdown: "a", metadata: {} }, { metadata: {} }],
    }),
  );
  assertEquals(done.pages.length, 1);
});

Deno.test("the key comes from the environment first", async () => {
  Deno.env.set("FIRECRAWL_API_KEY", "env-key");
  try {
    assertEquals(await resolveFirecrawlKey({}), "env-key");
  } finally {
    Deno.env.delete("FIRECRAWL_API_KEY");
  }
});

Deno.test("with no environment key it falls back to provider_api_keys", async () => {
  Deno.env.delete("FIRECRAWL_API_KEY");
  const admin = {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: { api_key: "db-key" } }) }),
      }),
    }),
  };
  assertEquals(await resolveFirecrawlKey(admin), "db-key");
});

Deno.test("no key anywhere names the admin setting rather than failing vaguely", async () => {
  Deno.env.delete("FIRECRAWL_API_KEY");
  const admin = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }),
    }),
  };
  await assertRejects(() => resolveFirecrawlKey(admin), FirecrawlError, "Admin");
});

Deno.test("a paginated completed crawl follows every results page", async () => {
  // Codex P1. A large crawl returns this batch plus a `next` URL. Stopping at
  // the first batch would mark the source ready having indexed a fraction of
  // the site, with nothing anywhere saying so.
  const bodies = [
    {
      status: "completed",
      completed: 3,
      total: 3,
      data: [{ markdown: "a", metadata: { sourceURL: "https://x.com/a" } }],
      next: "https://api.firecrawl.dev/v2/crawl/j?skip=1",
    },
    {
      status: "completed",
      data: [{ markdown: "b", metadata: { sourceURL: "https://x.com/b" } }],
      next: "https://api.firecrawl.dev/v2/crawl/j?skip=2",
    },
    {
      status: "completed",
      data: [{ markdown: "c", metadata: { sourceURL: "https://x.com/c" } }],
    },
  ];
  let call = 0;
  const paging = (() =>
    Promise.resolve(
      new Response(JSON.stringify(bodies[call++]), { status: 200 }),
    )) as unknown as typeof fetch;

  const done = await firecrawlCrawlStatus("k", "j", paging);
  assertEquals(done.state, "completed");
  assertEquals(done.pages.map((page) => page.url), [
    "https://x.com/a",
    "https://x.com/b",
    "https://x.com/c",
  ]);
});

Deno.test("an endlessly paginating crawl is refused, not silently truncated", async () => {
  // A source marked ready with two thirds of a site in it is a lie the UI
  // cannot correct, so the runaway case fails loudly.
  const endless = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          status: "completed",
          data: [{ markdown: "x", metadata: { sourceURL: "https://x.com/x" } }],
          next: "https://api.firecrawl.dev/v2/crawl/j?skip=1",
        }),
        { status: 200 },
      ),
    )) as unknown as typeof fetch;

  await assertRejects(() => firecrawlCrawlStatus("k", "j", endless), FirecrawlError, "result pages");
});
