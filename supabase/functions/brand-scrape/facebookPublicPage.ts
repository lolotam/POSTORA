import { configuredMetaBudgetFetch } from "../_shared/metaSharedBudget.ts";
// Public Facebook Page analysis with the app access token.
//
// Graph answers a heavy /posts page (summary edges plus nested attachments)
// with code 1 "Please reduce the amount of data you're asking for". Posts are
// therefore read in small pages, and a page that is still too heavy is retried
// with a smaller limit before the request fails. A page Graph is still
// working on when the request times out is retried the same way.

const GRAPH_BASE_URL = "https://graph.facebook.com/v22.0";
const PAGE_FIELDS = "id,name,username,about,fan_count,picture{url},cover,website,verification_status";
const POST_FIELDS = "id,message,story,full_picture,created_time,permalink_url," +
  "attachments{type,subattachments{type,media_type,media},media_type,media{source},description}," +
  "likes.summary(true),comments.summary(true),shares,reactions.summary(true)";
const REEL_FIELDS = "id,description,created_time,thumbnails,permalink_url,likes.summary(true),comments.summary(true),shares";
const POST_PAGE_SIZES = [25, 10, 5] as const;
const GRAPH_TIMEOUT_MS = 15_000;
// Kong closes a function request after 60 s, so every Graph read of one scrape
// shares this budget and the caller still gets an answer.
const GRAPH_BUDGET_MS = 45_000;
const MAX_DETAIL_LENGTH = 500;

// The Graph fields this module reads. Every field is optional because Graph
// omits what a Page does not expose to the app token.
type GraphCount = { summary?: { total_count?: number } };
type GraphError = { code?: number; error_subcode?: number; message?: string };
type GraphPaging = { next?: string; cursors?: { after?: string } };
type GraphPayload = { error?: GraphError; data?: unknown; paging?: GraphPaging; [field: string]: unknown };
type GraphAttachment = { type?: string; media_type?: string; description?: string; subattachments?: { data?: unknown[] } };
type GraphPost = {
  id: string; message?: string; story?: string; full_picture?: string; created_time?: string; permalink_url?: string;
  attachments?: { data?: GraphAttachment[] }; likes?: GraphCount; comments?: GraphCount; reactions?: GraphCount; shares?: { count?: number };
};
type GraphReel = {
  id: string; description?: string; created_time?: string; permalink_url?: string; thumbnails?: { data?: { uri?: string }[] };
  likes?: GraphCount; comments?: GraphCount; shares?: { count?: number };
};
type GraphPage = {
  id: string; name?: string; username?: string; about?: string; fan_count?: number; picture?: { data?: { url?: string } };
  website?: string; verification_status?: string;
};
type GraphReply = { status: number; payload: GraphPayload | null };
/** One scrape's Graph access: the transport, the app token, every form of the credential to redact and the budget's end. */
type GraphSession = { fetchFn: typeof fetch; accessToken: string; redactions: string[]; deadlineMs: number };

/** The message is shown to the user; the detail is the provider reply, for logs only. */
export class FacebookPublicPageError extends Error {
  constructor(message: string, readonly detail: string) {
    super(message);
    this.name = "FacebookPublicPageError";
  }
}

/** Graph did not answer before the request's share of the budget ran out. */
class GraphTimeoutError extends FacebookPublicPageError {}

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

function isGraphPayload(value: unknown): value is GraphPayload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A Graph node this module can map: an object with a string id. */
function isGraphNode(value: unknown): value is { id: string } {
  return isGraphPayload(value) && typeof value.id === "string" && value.id !== "";
}

// Deno's fetch failure message quotes the request URL, which carries the app
// access token, so a transport failure is rethrown with its error name only.
async function readGraph(session: GraphSession, edge: string, url: string): Promise<GraphReply> {
  const timeoutMs = Math.max(0, Math.min(GRAPH_TIMEOUT_MS, session.deadlineMs - Date.now()));
  let response: Response;
  let text: string;
  try {
    response = await session.fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    text = await response.text();
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new GraphTimeoutError("Facebook could not be reached. Try again later.",
        `Graph ${edge} request failed: TimeoutError after ${timeoutMs} ms`);
    }
    if (!(error instanceof TypeError)) throw error;
    throw new FacebookPublicPageError("Facebook could not be reached. Try again later.", `Graph ${edge} request failed: ${error.name}`);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return { status: response.status, payload: isGraphPayload(parsed) ? parsed : null };
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

/** `tier` is the configured page size Graph accepted, before the request was clamped to the posts still wanted. */
type PostPage = { data: GraphPost[]; paging: GraphPaging | undefined; tier: number };

/**
 * Tries each candidate tier, largest first, and reports the one Graph
 * accepted. Each request asks for the tier or the posts still wanted,
 * whichever is fewer. A tier that timed out gives way to the next. When no
 * tier is left, a timeout is rethrown only if the last tier tried timed out:
 * a smaller tier Graph refused as too much data is the definitive answer.
 */
async function fetchPostPage(
  session: GraphSession,
  pageId: string,
  request: { tiers: number[]; wanted: number; after: string | undefined },
): Promise<PostPage> {
  let timeout: GraphTimeoutError | null = null;
  const triedLimits = new Set<number>();
  for (const tier of request.tiers) {
    const pageSize = Math.min(tier, request.wanted);
    if (triedLimits.has(pageSize)) continue;
    triedLimits.add(pageSize);
    const params: Record<string, string> = { fields: POST_FIELDS, limit: String(pageSize) };
    if (request.after) params.after = request.after;
    let reply: GraphReply;
    try {
      reply = await readGraph(session, `posts limit=${pageSize}`, graphUrl(`${pageId}/posts`, params, session.accessToken));
    } catch (error) {
      if (!(error instanceof GraphTimeoutError)) throw error;
      timeout = error;
      continue;
    }
    if (!isFailedReply(reply)) {
      if (!Array.isArray(reply.payload!.data)) {
        throw new FacebookPublicPageError("Facebook returned an invalid response for this Page.", "posts page has no data array");
      }
      return { data: reply.payload!.data.filter(isGraphNode) as GraphPost[], paging: reply.payload!.paging, tier };
    }
    if (!isTooMuchData(reply)) {
      throw new FacebookPublicPageError("Facebook posts could not be loaded for this Page.", providerDetail(reply, session.redactions));
    }
    timeout = null;
  }
  if (timeout) throw timeout;
  throw new FacebookPublicPageError("Facebook returned too much data for this Page. Try again later.",
    `posts page still too large at limit ${POST_PAGE_SIZES.at(-1)}`);
}

// A tier Graph rejected as too much data, or did not answer in time, is not
// tried again on later pages.
function tiersFrom(largestAccepted: number): number[] {
  return POST_PAGE_SIZES.filter((size) => size <= largestAccepted);
}

/**
 * Pages follow Graph's own `after` cursor, never a provider-supplied URL.
 * Graph may answer a page with no usable posts and still a next cursor, so
 * only a missing cursor ends the feed; a cursor that does not advance and the
 * shared Graph budget bound the reading.
 * Once some posts are read, a later page that times out ends the reading:
 * the analysis keeps the posts it has instead of failing as a whole, and
 * `stoppedBy` carries the timeout detail so the caller can log why.
 */
async function fetchPosts(
  session: GraphSession,
  pageId: string,
  maxPosts: number,
): Promise<{ posts: GraphPost[]; stoppedBy: string | null }> {
  const posts: GraphPost[] = [];
  let after: string | undefined;
  let largestAccepted: number = POST_PAGE_SIZES[0];
  while (posts.length < maxPosts) {
    let page: PostPage;
    try {
      page = await fetchPostPage(session, pageId, { tiers: tiersFrom(largestAccepted), wanted: maxPosts - posts.length, after });
    } catch (error) {
      if (error instanceof GraphTimeoutError && posts.length > 0) {
        return { posts: posts.slice(0, maxPosts), stoppedBy: error.detail };
      }
      throw error;
    }
    largestAccepted = page.tier;
    const data = page.data;
    posts.push(...data);
    const previousAfter = after;
    after = page.paging?.cursors?.after;
    if (!page.paging?.next || !after) break;
    if (after === previousAfter) {
      throw new FacebookPublicPageError("Facebook returned an invalid response for this Page.",
        "posts pagination cursor did not advance");
    }
  }
  return { posts: posts.slice(0, maxPosts), stoppedBy: null };
}

function postMediaType(post: GraphPost): string {
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

function mapPost(post: GraphPost) {
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

function mapReel(reel: GraphReel) {
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
async function fetchReels(session: GraphSession, pageId: string): Promise<GraphReel[]> {
  let reply: GraphReply;
  try {
    reply = await readGraph(session, "video_reels", graphUrl(`${pageId}/video_reels`, { fields: REEL_FIELDS, limit: "25" }, session.accessToken));
  } catch (error) {
    if (error instanceof FacebookPublicPageError) return [];
    throw error;
  }
  return isFailedReply(reply) || !Array.isArray(reply.payload!.data) ? [] : reply.payload!.data.filter(isGraphNode) as GraphReel[];
}

function mapProfile(pageData: GraphPage, pageIdentifier: string, postsCount: number) {
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
  const session: GraphSession = {
    fetchFn: input.fetchFn ?? configuredMetaBudgetFetch(),
    accessToken,
    redactions: credentialForms(accessToken, input.appSecret),
    deadlineMs: Date.now() + GRAPH_BUDGET_MS,
  };
  const pageReply = await readGraph(session, "page", graphUrl(encodeURIComponent(input.pageIdentifier), { fields: PAGE_FIELDS }, accessToken));
  if (isFailedReply(pageReply)) {
    const message = isPageMissing(pageReply) ? "Facebook Page not found." : "Facebook Page could not be loaded. Try again later.";
    throw new FacebookPublicPageError(message, providerDetail(pageReply, session.redactions));
  }
  if (!isGraphNode(pageReply.payload)) {
    throw new FacebookPublicPageError("Facebook returned an invalid response for this Page.", "page reply has no id");
  }
  const pageData = pageReply.payload as GraphPage;

  const reading = await fetchPosts(session, pageData.id, input.maxPosts);
  const posts = reading.posts.map(mapPost);
  const existingIds = new Set(posts.map((post) => post.id));
  for (const reel of await fetchReels(session, pageData.id)) {
    if (!existingIds.has(reel.id)) posts.push(mapReel(reel));
  }

  return { profile: mapProfile(pageData, input.pageIdentifier, posts.length), posts, readingStoppedBy: reading.stoppedBy };
}
