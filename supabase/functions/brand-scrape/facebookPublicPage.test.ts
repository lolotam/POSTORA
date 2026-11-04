import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { FacebookPublicPageError, scrapeFacebookPublicPage } from "./facebookPublicPage.ts";

const APP = { appId: "synthetic-app", appSecret: "synthetic-app-secret" };
const PAGE = { id: "777", name: "Synthetic Page", username: "synthetic", fan_count: 1200 };
const TOO_MUCH_DATA = { error: { code: 1, message: "Please reduce the amount of data you're asking for, then retry your request" } };
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
  assertEquals(report.posts.length, 31);
  assertEquals(report.posts.at(-1)!.id, "reel_1");
  assertEquals(report.profile.postsCount, 31);
  assertEquals(report.profile.followersCount, 1200);
});

// Production 2026-11-04: Analyze @cocacola failed because one 100-post page
// carrying summary edges was rejected with Graph code 1.
Deno.test("a page Graph rejects as too much data is retried with a smaller limit", async () => {
  const { fetchFn, postRequests } = graph({
    posts: (url) => url.searchParams.get("limit") === "25" ? json(TOO_MUCH_DATA, 500) : json({ data: posts(0, 10) }),
  });
  const report = await scrapeFacebookPublicPage({ ...APP, pageIdentifier: "cocacola", maxPosts: 100, fetchFn });
  assertEquals(postRequests.map((url) => url.searchParams.get("limit")), ["25", "10"]);
  assertEquals(report.posts.length, 10);
});

Deno.test("provider failures reach the caller as a short message with the provider reply kept for logs", async () => {
  const cases: { name: string; routes: { page?: Route; posts: Route }; message: string; detail: string }[] = [
    { name: "unknown page", routes: { page: () => json({ error: { code: 803, message: "Some of the aliases you requested do not exist" } }, 404), posts: () => json({ data: [] }) },
      message: "Facebook Page not found.", detail: "803" },
    { name: "posts refused", routes: { posts: () => json({ error: { code: 10, message: "Permission denied" } }, 403) },
      message: "Facebook posts could not be loaded for this Page.", detail: "Permission denied" },
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
