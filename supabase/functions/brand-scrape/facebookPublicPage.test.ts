import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { FacebookPublicPageError, scrapeFacebookPublicPage } from "./facebookPublicPage.ts";

const APP = { appId: "synthetic-app", appSecret: "synthetic-app-secret" };
const PAGE = { id: "777", name: "Synthetic Page", username: "synthetic", fan_count: 1200 };
const TOO_MUCH_DATA = { error: { code: 1, message: "Please reduce the amount of data you're asking for, then retry your request" } };
const timedOut = (): Response => { throw new DOMException("Signal timed out.", "TimeoutError"); };
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const post = (id: number) => ({ id: `777_${id}`, message: `post ${id}`, created_time: "2026-11-01T00:00:00+0000",
  likes: { summary: { total_count: 1 } }, comments: { summary: { total_count: 1 } }, reactions: { summary: { total_count: 2 } } });
const posts = (from: number, count: number) => Array.from({ length: count }, (_, index) => post(from + index));

type Route = (url: URL) => Response;
function graph(routes: { page?: Route; posts: Route; reels?: Route }) {
  const postRequests: URL[] = [];
  const fetchFn = ((input: string | URL) => {
    const url = new URL(String(input));
    assertEquals(url.origin, "https://graph.facebook.com");
    if (url.pathname.endsWith("/posts")) { postRequests.push(url); return Promise.resolve(routes.posts(url)); }
    if (url.pathname.endsWith("/video_reels")) return Promise.resolve(routes.reels?.(url) ?? json({ data: [] }));
    return Promise.resolve(routes.page?.(url) ?? json(PAGE));
  }) as typeof fetch;
  return { fetchFn, postRequests };
}

Deno.test("posts are read in small pages through the after cursor up to the post limit", async () => {
  const { fetchFn, postRequests } = graph({
    posts: (url) => url.searchParams.has("after")
      ? json({ data: posts(25, 5) })
      : json({ data: posts(0, 25), paging: { cursors: { after: "page_2" }, next: "https://untrusted.invalid/next" } }),
    reels: () => json({ data: [{ id: "777_0" }, { id: "reel_1", description: "reel" }] }),
  });
  const report = await scrapeFacebookPublicPage({ ...APP, pageIdentifier: "synthetic", maxPosts: 30, fetchFn });
  assertEquals(postRequests.map((url) => [url.searchParams.get("limit"), url.searchParams.get("after")]), [["25", null], ["5", "page_2"]]);
  assertEquals(report.readingStoppedBy, null);
  assertEquals(report.posts.length, 31);
  assertEquals(report.posts.at(-1)!.id, "reel_1");
  assertEquals(report.profile.postsCount, 31);
  assertEquals(report.profile.followersCount, 1200);
});

// Production 2026-11-04: Analyze @cocacola failed twice. First one 100-post
// page carrying summary edges was rejected with Graph code 1; after the fix a
// 25-post page did not answer within the request timeout.
Deno.test("a page size Graph refuses or does not answer in time is not tried again on later pages", async () => {
  const refusals: { name: string; refuse: Route }[] = [
    { name: "too much data", refuse: () => json(TOO_MUCH_DATA, 500) },
    { name: "timed out", refuse: timedOut },
  ];
  for (const { name, refuse } of refusals) {
    const { fetchFn, postRequests } = graph({
      posts: (url) => {
        if (url.searchParams.get("limit") === "25") return refuse(url);
        return url.searchParams.has("after")
          ? json({ data: posts(10, 5) })
          : json({ data: posts(0, 10), paging: { cursors: { after: "page_2" }, next: "https://graph.facebook.com/next" } });
      },
    });
    const report = await scrapeFacebookPublicPage({ ...APP, pageIdentifier: "cocacola", maxPosts: 100, fetchFn });
    assertEquals(postRequests.map((url) => url.searchParams.get("limit")), ["25", "10", "10"], name);
    assertEquals(report.posts.length, 15, name);
  }
});

Deno.test("a later posts page that times out keeps the posts already read", async () => {
  const { fetchFn } = graph({
    posts: (url) => url.searchParams.has("after")
      ? timedOut()
      : json({ data: posts(0, 25), paging: { cursors: { after: "page_2" }, next: "https://graph.facebook.com/next" } }),
  });
  const report = await scrapeFacebookPublicPage({ ...APP, pageIdentifier: "cocacola", maxPosts: 100, fetchFn });
  assertEquals(report.posts.length, 25);
  assertEquals(report.readingStoppedBy?.includes("posts limit=5 request failed: TimeoutError"), true);
});

Deno.test("a reels reply that is not a JSON object leaves the posts analysis intact", async () => {
  const { fetchFn } = graph({ posts: () => json({ data: posts(0, 3) }), reels: () => json(1) });
  const report = await scrapeFacebookPublicPage({ ...APP, pageIdentifier: "synthetic", maxPosts: 10, fetchFn });
  assertEquals(report.posts.length, 3);
});

Deno.test("provider failures reach the caller as a short message with the provider reply kept for logs", async () => {
  const cases: { name: string; routes: { page?: Route; posts: Route }; message: string; detail: string }[] = [
    { name: "unknown page", routes: { page: () => json({ error: { code: 803, message: "Some of the aliases you requested do not exist" } }, 404), posts: () => json({ data: [] }) },
      message: "Facebook Page not found.", detail: "803" },
    { name: "page lookup unavailable", routes: { page: () => json({ error: { code: 2, message: "Service temporarily unavailable" } }, 503), posts: () => json({ data: [] }) },
      message: "Facebook Page could not be loaded. Try again later.", detail: "503" },
    { name: "page reply is not an object", routes: { page: () => json(1), posts: () => json({ data: [] }) },
      message: "Facebook Page could not be loaded. Try again later.", detail: "HTTP 200" },
    { name: "posts reply without a data array", routes: { posts: () => json({}) },
      message: "Facebook returned an invalid response for this Page.", detail: "no data array" },
    // Graph may echo the request URL, where the token is query-encoded.
    { name: "provider echoes the encoded request URL", routes: { posts: (url) => json({ error: { code: 190, message: `bad request ${url.search}` } }, 400) },
      message: "Facebook posts could not be loaded for this Page.", detail: "[redacted]" },
    { name: "posts refused", routes: { posts: () => json({ error: { code: 10, message: "Permission denied" } }, 403) },
      message: "Facebook posts could not be loaded for this Page.", detail: "Permission denied" },
    { name: "posts time out at every size", routes: { posts: timedOut },
      message: "Facebook could not be reached. Try again later.", detail: "posts limit=5" },
    { name: "still too large", routes: { posts: () => json(TOO_MUCH_DATA, 500) },
      message: "Facebook returned too much data for this Page. Try again later.", detail: "limit 5" },
    { name: "provider echoes the token", routes: { posts: (url) => json({ error: { code: 190, message: `bad token ${url.searchParams.get("access_token")}` } }, 400) },
      message: "Facebook posts could not be loaded for this Page.", detail: "[redacted]" },
    // Deno's fetch failure message quotes the request URL, token included.
    { name: "Graph unreachable", routes: { posts: (url) => { throw new TypeError(`error sending request for url (${url})`); } },
      message: "Facebook could not be reached. Try again later.", detail: "TypeError" },
    { name: "cursor does not advance", routes: { posts: () => json({ data: posts(0, 5), paging: { cursors: { after: "same" }, next: "https://graph.facebook.com/next" } }) },
      message: "Facebook returned an invalid response for this Page.", detail: "did not advance" },
  ];
  for (const scenario of cases) {
    const { fetchFn } = graph(scenario.routes);
    const error = await assertRejects(() => scrapeFacebookPublicPage({ ...APP, pageIdentifier: "synthetic", maxPosts: 50, fetchFn }), FacebookPublicPageError);
    assertEquals(error.message, scenario.message, scenario.name);
    assertEquals(error.detail.includes(scenario.detail), true, scenario.name);
    assertEquals(`${error.message}${error.detail}`.includes(APP.appSecret), false, scenario.name);
  }
});
