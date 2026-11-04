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
/** One scrape's Graph access: the transport, the app token and every form of the credential to redact. */
type GraphSession = { fetchFn: typeof fetch; accessToken: string; redactions: string[] };

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

function queryEncoded(value: string): string {
  return new URLSearchParams({ v: value }).toString().slice("v=".length);
}

// A provider error may echo the request URL, where the token is query-encoded
// ("|" becomes "%7C"). Longer forms come first so a shorter one cannot split them.
function credentialForms(accessToken: string, appSecret: string): string[] {
  const forms = [accessToken, queryEncoded(accessToken), encodeURIComponent(accessToken), appSecret, encodeURIComponent(appSecret)];
  return [...new Set(forms)].sort((left, right) => right.length - left.length);
}

function isGraphObject(value: unknown): value is GraphObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    const parsed: unknown = JSON.parse(text);
    return { status: response.status, payload: isGraphObject(parsed) ? parsed : null };
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

// Graph answers an unknown Page id with 803, or with 100/33 for an id it cannot read.
function isPageMissing(reply: GraphReply): boolean {
  const error = reply.payload?.error;
  return reply.status === 404 || error?.code === 803 || (error?.code === 100 && error?.error_subcode === 33);
}

function providerDetail(reply: GraphReply, redactions: string[]): string {
  const detail = `HTTP ${reply.status}: ${JSON.stringify(reply.payload?.error ?? reply.payload)}`;
  const redacted = redactions.reduce((text, secret) => text.split(secret).join("[redacted]"), detail);
  return redacted.slice(0, MAX_DETAIL_LENGTH);
}

type PostPage = { data: GraphObject[]; paging: GraphObject | undefined; pageSize: number };

/** Tries each candidate page size, largest first, and reports the one Graph accepted. */
async function fetchPostPage(session: GraphSession, pageId: string, sizes: number[], after: string | undefined): Promise<PostPage> {
  for (const pageSize of sizes) {
    const params: Record<string, string> = { fields: POST_FIELDS, limit: String(pageSize) };
    if (after) params.after = after;
    const reply = await readGraph(session.fetchFn, graphUrl(`${pageId}/posts`, params, session.accessToken));
    if (!isFailedReply(reply)) {
      if (!Array.isArray(reply.payload!.data)) {
        throw new FacebookPublicPageError("Facebook returned an invalid response for this Page.", "posts page has no data array");
      }
      return { data: reply.payload!.data, paging: reply.payload!.paging, pageSize };
    }
    if (!isTooMuchData(reply)) {
      throw new FacebookPublicPageError("Facebook posts could not be loaded for this Page.", providerDetail(reply, session.redactions));
    }
  }
  throw new FacebookPublicPageError("Facebook returned too much data for this Page. Try again later.",
    `posts page still too large at limit ${POST_PAGE_SIZES.at(-1)}`);
}

// A size Graph rejected as too much data is not tried again on later pages.
function pageSizesFor(wanted: number, largestAccepted: number): number[] {
  return [...new Set(POST_PAGE_SIZES.filter((size) => size <= largestAccepted).map((size) => Math.min(size, wanted)))];
}

/** Pages follow Graph's own `after` cursor, never a provider-supplied URL. */
async function fetchPosts(session: GraphSession, pageId: string, maxPosts: number): Promise<GraphObject[]> {
  const posts: GraphObject[] = [];
  let after: string | undefined;
  let largestAccepted: number = POST_PAGE_SIZES[0];
  while (posts.length < maxPosts) {
    const page = await fetchPostPage(session, pageId, pageSizesFor(maxPosts - posts.length, largestAccepted), after);
    largestAccepted = page.pageSize;
    const data = page.data;
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
async function fetchReels(session: GraphSession, pageId: string): Promise<GraphObject[]> {
  let reply: GraphReply;
  try {
    reply = await readGraph(session.fetchFn, graphUrl(`${pageId}/video_reels`, { fields: REEL_FIELDS, limit: "25" }, session.accessToken));
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
  const accessToken = `${input.appId}|${input.appSecret}`;
  const session: GraphSession = { fetchFn: input.fetchFn ?? fetch, accessToken, redactions: credentialForms(accessToken, input.appSecret) };
  const pageReply = await readGraph(session.fetchFn, graphUrl(encodeURIComponent(input.pageIdentifier), { fields: PAGE_FIELDS }, accessToken));
  if (isFailedReply(pageReply)) {
    const message = isPageMissing(pageReply) ? "Facebook Page not found." : "Facebook Page could not be loaded. Try again later.";
    throw new FacebookPublicPageError(message, providerDetail(pageReply, session.redactions));
  }
  const pageData = pageReply.payload!;

  const posts = (await fetchPosts(session, pageData.id, input.maxPosts)).map(mapPost);
  const existingIds = new Set(posts.map((post) => post.id));
  for (const reel of await fetchReels(session, pageData.id)) {
    if (!existingIds.has(reel.id)) posts.push(mapReel(reel));
  }

  return { profile: mapProfile(pageData, input.pageIdentifier, posts.length), posts };
}
