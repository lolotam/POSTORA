// Public Facebook Page analysis with the app access token.
//
// Graph answers a heavy /posts page (summary edges plus nested attachments)
// with code 1 "Please reduce the amount of data you're asking for". Posts are
// therefore read in small pages, and a page that is still too heavy is retried
// with a smaller limit before the request fails.

const GRAPH_BASE_URL = "https://graph.facebook.com/v22.0";
const PAGE_FIELDS = "id,name,username,about,fan_count,picture{url},cover,website,verification_status";
const POST_FIELDS = "id,message,story,full_picture,created_time,permalink_url," +
  "attachments{type,subattachments{type,media_type,media},media_type,media{source},description}," +
  "likes.summary(true),comments.summary(true),shares,reactions.summary(true)";
const REEL_FIELDS = "id,description,created_time,thumbnails,permalink_url,likes.summary(true),comments.summary(true),shares";
const POST_PAGE_SIZES = [25, 10, 5] as const;
const GRAPH_TIMEOUT_MS = 15_000;
const MAX_DETAIL_LENGTH = 500;

// deno-lint-ignore no-explicit-any
type GraphObject = Record<string, any>;
type GraphReply = { status: number; payload: GraphObject | null };

/** The message is shown to the user; the detail is the provider reply, for logs only. */
export class FacebookPublicPageError extends Error {
  constructor(message: string, readonly detail: string) {
    super(message);
    this.name = "FacebookPublicPageError";
  }
}

export function calculateEngagementScore(likes = 0, comments = 0, shares = 0, views = 0): number {
  return Math.round((likes * 1) + (comments * 2) + (shares * 1.5) + (views * 0.1));
}

function graphUrl(path: string, params: Record<string, string>, accessToken: string): string {
  const url = new URL(`${GRAPH_BASE_URL}/${path}`);
  url.search = new URLSearchParams({ ...params, access_token: accessToken }).toString();
  return url.toString();
}

// Deno's fetch failure message quotes the request URL, which carries the app
// access token, so a transport failure is rethrown with its error name only.
async function readGraph(fetchFn: typeof fetch, url: string): Promise<GraphReply> {
  let response: Response;
  let text: string;
  try {
    response = await fetchFn(url, { signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS) });
    text = await response.text();
  } catch (error) {
    if (!(error instanceof TypeError || (error instanceof DOMException && error.name === "TimeoutError"))) throw error;
    throw new FacebookPublicPageError("Facebook could not be reached. Try again later.", `Graph request failed: ${error.name}`);
  }
  try {
    return { status: response.status, payload: JSON.parse(text) };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { status: response.status, payload: null };
  }
}

function isFailedReply(reply: GraphReply): boolean {
  return reply.status < 200 || reply.status >= 300 || !reply.payload || "error" in reply.payload;
}

function isTooMuchData(reply: GraphReply): boolean {
  const error = reply.payload?.error;
  return error?.code === 1 && String(error.message ?? "").includes("reduce the amount of data");
}

function providerDetail(reply: GraphReply, accessToken: string): string {
  const detail = `HTTP ${reply.status}: ${JSON.stringify(reply.payload?.error ?? reply.payload)}`;
  return detail.split(accessToken).join("[redacted]").slice(0, MAX_DETAIL_LENGTH);
}

async function fetchPostPage(fetchFn: typeof fetch, pageId: string, accessToken: string,
  wanted: number, after: string | undefined): Promise<GraphObject> {
  const limits = new Set(POST_PAGE_SIZES.map((pageSize) => Math.min(pageSize, wanted)));
  for (const limit of limits) {
    const params: Record<string, string> = { fields: POST_FIELDS, limit: String(limit) };
    if (after) params.after = after;
    const reply = await readGraph(fetchFn, graphUrl(`${pageId}/posts`, params, accessToken));
    if (!isFailedReply(reply)) return reply.payload!;
    if (!isTooMuchData(reply)) {
      throw new FacebookPublicPageError("Facebook posts could not be loaded for this Page.", providerDetail(reply, accessToken));
    }
  }
  throw new FacebookPublicPageError("Facebook returned too much data for this Page. Try again later.",
    `posts page still too large at limit ${POST_PAGE_SIZES.at(-1)}`);
}

/** Pages follow Graph's own `after` cursor, never a provider-supplied URL. */
async function fetchPosts(fetchFn: typeof fetch, pageId: string, accessToken: string, maxPosts: number): Promise<GraphObject[]> {
  const posts: GraphObject[] = [];
  let after: string | undefined;
  while (posts.length < maxPosts) {
    const page = await fetchPostPage(fetchFn, pageId, accessToken, maxPosts - posts.length, after);
    const data: GraphObject[] = Array.isArray(page.data) ? page.data : [];
    posts.push(...data);
    const previousAfter = after;
    after = page.paging?.cursors?.after;
    if (data.length === 0 || !page.paging?.next || !after) break;
    if (after === previousAfter) {
      throw new FacebookPublicPageError("Facebook returned an invalid response for this Page.",
        "posts pagination cursor did not advance");
    }
  }
  return posts.slice(0, maxPosts);
}

function postMediaType(post: GraphObject): string {
  const attachment = post.attachments?.data?.[0];
  const attachmentType = attachment?.type || "";
  const attachmentMediaType = attachment?.media_type || "";
  const subattachments = attachment?.subattachments?.data;
  const description = attachment?.description || "";
  const storyText = post.story || "";
  if (subattachments && subattachments.length > 1) return "CAROUSEL";
  if (attachmentType.includes("video") || attachmentMediaType === "video") {
    return storyText.toLowerCase().includes("reel") || description.toLowerCase().includes("reel") ? "REEL" : "VIDEO";
  }
  if (attachmentType.includes("album")) return "CAROUSEL";
  if (!post.full_picture && !attachmentType) return "TEXT";
  return "IMAGE";
}

function mapPost(post: GraphObject) {
  const likes = post.likes?.summary?.total_count || 0;
  const comments = post.comments?.summary?.total_count || 0;
  const shares = post.shares?.count || 0;
  const reactions = post.reactions?.summary?.total_count || 0;
  return {
    id: post.id,
    mediaType: postMediaType(post),
    thumbnailUrl: post.full_picture || "",
    mediaUrl: post.full_picture || "",
    caption: post.message || post.story || "",
    likesCount: reactions || likes,
    commentsCount: comments,
    videoViewCount: 0,
    sharesCount: shares,
    savesCount: 0,
    engagementScore: calculateEngagementScore(reactions || likes, comments, shares, 0),
    timestamp: post.created_time,
    permalink: post.permalink_url || `https://www.facebook.com/${post.id}`,
  };
}

function mapReel(reel: GraphObject) {
  const likes = reel.likes?.summary?.total_count || 0;
  const comments = reel.comments?.summary?.total_count || 0;
  const shares = reel.shares?.count || 0;
  const thumbnail = reel.thumbnails?.data?.[0]?.uri || "";
  return {
    id: reel.id,
    mediaType: "REEL",
    thumbnailUrl: thumbnail,
    mediaUrl: thumbnail,
    caption: reel.description || "",
    likesCount: likes,
    commentsCount: comments,
    videoViewCount: 0,
    sharesCount: shares,
    savesCount: 0,
    engagementScore: calculateEngagementScore(likes, comments, shares, 0),
    timestamp: reel.created_time,
    permalink: reel.permalink_url || `https://www.facebook.com/${reel.id}`,
  };
}

/** Reels are optional enrichment: the app token may not reach that edge. */
async function fetchReels(fetchFn: typeof fetch, pageId: string, accessToken: string): Promise<GraphObject[]> {
  let reply: GraphReply;
  try {
    reply = await readGraph(fetchFn, graphUrl(`${pageId}/video_reels`, { fields: REEL_FIELDS, limit: "25" }, accessToken));
  } catch (error) {
    if (error instanceof FacebookPublicPageError) return [];
    throw error;
  }
  return isFailedReply(reply) || !Array.isArray(reply.payload!.data) ? [] : reply.payload!.data;
}

function mapProfile(pageData: GraphObject, pageIdentifier: string, postsCount: number) {
  return {
    id: pageData.id,
    username: pageData.username || pageIdentifier,
    fullName: pageData.name,
    bio: pageData.about || "",
    avatarUrl: pageData.picture?.data?.url || "",
    followersCount: pageData.fan_count || 0,
    followingCount: 0,
    postsCount,
    isVerified: pageData.verification_status === "blue_verified" || pageData.verification_status === "gray_verified",
    website: pageData.website || null,
    platform: "facebook",
  };
}

export async function scrapeFacebookPublicPage(input: {
  pageIdentifier: string; appId: string; appSecret: string; maxPosts: number; fetchFn?: typeof fetch;
}) {
  const fetchFn = input.fetchFn ?? fetch;
  const accessToken = `${input.appId}|${input.appSecret}`;
  const pageReply = await readGraph(fetchFn, graphUrl(encodeURIComponent(input.pageIdentifier), { fields: PAGE_FIELDS }, accessToken));
  if (isFailedReply(pageReply)) throw new FacebookPublicPageError("Facebook Page not found.", providerDetail(pageReply, accessToken));
  const pageData = pageReply.payload!;

  const posts = (await fetchPosts(fetchFn, pageData.id, accessToken, input.maxPosts)).map(mapPost);
  const existingIds = new Set(posts.map((post) => post.id));
  for (const reel of await fetchReels(fetchFn, pageData.id, accessToken)) {
    if (!existingIds.has(reel.id)) posts.push(mapReel(reel));
  }

  return { profile: mapProfile(pageData, input.pageIdentifier, posts.length), posts };
}
