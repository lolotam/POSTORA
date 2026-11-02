import {
  createFacebookUserCredentialStore, createInstagramAccountCapabilityStore,
  CredentialStoreError, type FacebookUserAccountCredential, type ServiceRpcCaller,
} from "../_shared/facebookUserCredentialStore.ts";
import { isBusinessDiscoveryViewerCandidate, pickBusinessDiscoveryViewer, type ViewerCandidate } from "../_shared/instagramDiscoveryViewer.ts";
import {
  buildBusinessDiscoveryUrl, normalizeCompetitorHandle, parseBusinessDiscoveryMedia,
  parseUsagePercent, readBoundedBody, readBusinessDiscoveryTarget, readGraphErrorEnvelope,
  readMediaCursor, resolveGraphApiVersion,
} from "../competitor-snapshot-sync/graphProvider.ts";

export class InstagramDiscoveryError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
    this.name = "InstagramDiscoveryError";
  }
}

export type DiscoveryAuthority = {
  account: ViewerCandidate; token: string; source: "official" | "graph_own";
};

/** Resolve only service-recorded authority before cache access; no metadata or Page-token fallback. */
export async function resolveDiscoveryAuthority(input: {
  rpc: ServiceRpcCaller; accounts: ViewerCandidate[]; userId: string; username: string;
}): Promise<{ authority: DiscoveryAuthority | null; cacheIdentity: string; refusalCode: string | null }> {
  const capabilities = createInstagramAccountCapabilityStore(input.rpc);
  const accounts: ViewerCandidate[] = [];
  for (const account of input.accounts) {
    if (account.user_id !== input.userId) throw new InstagramDiscoveryError("DISCOVERY_UNAVAILABLE", "Instagram discovery is unavailable.", 503);
    const capability = await capabilities.readCapability({ userId: input.userId, socialAccountId: account.id });
    accounts.push({ ...account, capability });
  }
  const cacheIdentity = JSON.stringify(accounts.map((account) => [account.id, account.is_active,
    account.needs_reauth, account.capability]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  const own = accounts.find((account) => account.is_active && !account.needs_reauth &&
    account.capability?.loginKind === "direct" && account.access_token &&
    (!account.ig_auth_type || account.ig_auth_type === "business_login") &&
    normalizeCompetitorHandle(String(account.platform_username ?? "")) === input.username);
  if (own) return { authority: { account: own, token: own.access_token, source: "graph_own" }, cacheIdentity, refusalCode: null };
  let remaining = accounts.filter((account) => account.capability?.loginKind === "page_linked" && isBusinessDiscoveryViewerCandidate(account));
  while (remaining.length) {
    const viewer = pickBusinessDiscoveryViewer(remaining);
    if (!viewer || viewer.capability?.loginKind !== "page_linked") break;
    remaining = remaining.filter((account) => account.id !== viewer.id);
    let binding: FacebookUserAccountCredential;
    try {
      binding = await createFacebookUserCredentialStore(input.rpc).readAccountCredential({ userId: input.userId, socialAccountId: viewer.id });
    } catch (error) {
      if (error instanceof CredentialStoreError && error.code === "not_found") continue;
      throw error;
    }
    if (!binding.found || (binding.tokenExpiresAt !== null && Date.parse(binding.tokenExpiresAt) <= Date.now())) continue;
    if (binding.platform !== "instagram" || binding.credentialKind !== "facebook_user" || !binding.token ||
      !binding.credentialId || binding.revision === null || binding.capabilityGeneration !== viewer.capability.credentialGeneration) {
      throw new InstagramDiscoveryError("DISCOVERY_UNAVAILABLE", "Instagram discovery is unavailable.", 503);
    }
    const identity = `${cacheIdentity}:${binding.credentialId}:${binding.revision}:${binding.connectionVersion}`;
    return { authority: { account: viewer, token: binding.token, source: "official" }, cacheIdentity: identity, refusalCode: null };
  }
  const denied = accounts.some((account) => isBusinessDiscoveryViewerCandidate(account) && account.capability?.loginKind === "page_linked" &&
    account.capability.permissionReadState === "ok" && account.capability.scopesAuthoritative &&
    !account.capability.grantedScopes.includes("instagram_manage_insights"));
  return { authority: null, cacheIdentity, refusalCode: denied ? "IG_INSIGHTS_SCOPE_MISSING" : "IG_RECONNECT_REQUIRED" };
}

export async function discoveryCacheKey(owner: string, username: string, identity: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `instagram:v2:${owner}:${username}:${fingerprint}`;
}

function nullableScore(likes: number | null, comments: number | null, views: number | null): number | null {
  return likes === null || comments === null || views === null ? null : Math.round(likes + comments * 2 + views * 0.1);
}

function discoveryText(raw: unknown, maxLength = 2_000): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.length > maxLength || raw.includes("\u0000")) {
    throw new InstagramDiscoveryError("DISCOVERY_PROVIDER_UNAVAILABLE", "Instagram discovery returned unusable text.", 502);
  }
  return raw;
}

/** Keep untrusted provider fields out of the profile contract on every Instagram transport. */
export function discoveryProfile(profile: Record<string, unknown>, fallbackUsername: string, source: "official" | "graph_own" | "apify") {
  const id = discoveryText(profile.id, 255);
  const rawUsername = discoveryText(profile.username, 30);
  const username = rawUsername === null ? fallbackUsername : normalizeCompetitorHandle(rawUsername);
  if (!id?.trim() || !username) throw new InstagramDiscoveryError("DISCOVERY_PROVIDER_UNAVAILABLE", "Instagram profile could not be read.", 502);
  return { id, username, fullName: discoveryText(profile.name, 255) ?? username,
    bio: discoveryText(profile.biography) ?? "", avatarUrl: discoveryText(profile.profile_picture_url) ?? "",
    followersCount: discoveryCount(profile.followers_count), followingCount: discoveryCount(profile.follows_count),
    postsCount: discoveryCount(profile.media_count), isVerified: profile.is_verified === true,
    website: discoveryText(profile.website), platform: "instagram", source };
}

/** One format/count contract shared with the scheduled Graph adapter. */
export function discoveryMedia(raw: unknown) {
  const media = parseBusinessDiscoveryMedia(raw);
  const record = raw as Record<string, unknown>;
  const mediaType = media.media_product_type === "REELS" ? "REEL" :
    media.media_type === "VIDEO" ? "VIDEO" : media.media_type === "CAROUSEL_ALBUM" ? "CAROUSEL" : "IMAGE";
  const mediaUrl = discoveryText(record.media_url) ?? "";
  return { id: media.ig_media_id, mediaType, thumbnailUrl: media.thumbnail_url ?? mediaUrl,
    mediaUrl, caption: media.caption ?? "",
    likesCount: media.like_count, commentsCount: media.comments_count, videoViewCount: media.view_count,
    sharesCount: null, savesCount: null, engagementScore: nullableScore(media.like_count, media.comments_count, media.view_count),
    timestamp: media.published_at, permalink: media.permalink ?? "" };
}

async function discoveryJson(url: string, fetchFn: typeof fetch): Promise<unknown> {
  const signal = AbortSignal.timeout(8_000);
  try {
    const response = await fetchFn(url, { signal, redirect: "error" });
    const payload: unknown = JSON.parse(await readBoundedBody(response, 1_048_576, signal));
    const providerError = readGraphErrorEnvelope(payload);
    if (!response.ok || providerError) {
      if (providerError?.code === 190) throw new InstagramDiscoveryError("IG_RECONNECT_REQUIRED", "Reconnect Instagram to enable official competitor data.");
      // A provider permission-shaped code also covers target/data restrictions.
      // Only the trusted permission read above establishes a missing scope.
      throw new InstagramDiscoveryError("DISCOVERY_PROVIDER_UNAVAILABLE", "Instagram discovery could not be completed.", 502);
    }
    if (parseUsagePercent(response.headers) > 80) throw new InstagramDiscoveryError("DISCOVERY_RATE_LIMITED", "Instagram discovery is temporarily unavailable.", 429);
    return payload;
  } catch (error) {
    if (error instanceof InstagramDiscoveryError) throw error;
    throw new InstagramDiscoveryError("DISCOVERY_PROVIDER_UNAVAILABLE", "Instagram discovery could not be completed.", 502);
  }
}

export async function scrapeInstagramOfficial(input: {
  username: string; viewerIgUserId: string; accessToken: string; maxPosts: number; apiVersion?: string; fetchFn?: typeof fetch;
}) {
  const handle = normalizeCompetitorHandle(input.username);
  if (!handle || !Number.isInteger(input.maxPosts) || input.maxPosts < 1 || input.maxPosts > 100) {
    throw new InstagramDiscoveryError("INVALID_DISCOVERY_REQUEST", "Invalid Instagram discovery request.", 400);
  }
  const posts: ReturnType<typeof discoveryMedia>[] = [];
  const seenIds = new Set<string>();
  const cursors = new Set<string>();
  let target: Record<string, unknown> = {};
  let cursor: string | null = null;
  for (let page = 0; page < Math.ceil(input.maxPosts / 25); page++) {
    target = readBusinessDiscoveryTarget(await discoveryJson(buildBusinessDiscoveryUrl({ apiVersion: resolveGraphApiVersion(input.apiVersion),
      viewerIgUserId: input.viewerIgUserId, handle, token: input.accessToken, cursor }), input.fetchFn ?? fetch));
    const connection = target.media as Record<string, unknown> | undefined;
    const rows = connection?.data ?? (target.media_count === 0 ? [] : null);
    if (!Array.isArray(rows) || rows.length > 25) throw new InstagramDiscoveryError("DISCOVERY_PROVIDER_UNAVAILABLE", "Instagram discovery returned unusable data.", 502);
    for (const row of rows) {
      const post = discoveryMedia(row);
      if (seenIds.has(post.id)) continue;
      seenIds.add(post.id);
      if (posts.length < input.maxPosts) posts.push(post);
    }
    if (posts.length >= input.maxPosts) break;
    const next = readMediaCursor(target);
    if (!next.present) break;
    if (!next.usable || !next.cursor || cursors.has(next.cursor)) throw new InstagramDiscoveryError("DISCOVERY_PROVIDER_UNAVAILABLE", "Instagram discovery pagination could not be completed.", 502);
    cursor = next.cursor;
    cursors.add(cursor);
  }
  return { source: "official", profile: discoveryProfile(target, handle, "official"), posts };
}

export async function scrapeInstagramOwn(input: {
  username: string; igUserId: string; accessToken: string; maxPosts: number; fetchFn?: typeof fetch;
}) {
  const transport = input.fetchFn ?? fetch;
  const endpoint = `https://graph.instagram.com/v22.0/${encodeURIComponent(input.igUserId)}`;
  const profileUrl = new URL(endpoint);
  profileUrl.search = new URLSearchParams({ fields: "id,username,name,biography,followers_count,follows_count,media_count,profile_picture_url,website", access_token: input.accessToken }).toString();
  const profile = await discoveryJson(profileUrl.href, transport);
  if (!profile || typeof profile !== "object" || Array.isArray(profile) || typeof (profile as Record<string, unknown>).id !== "string") {
    throw new InstagramDiscoveryError("DISCOVERY_PROVIDER_UNAVAILABLE", "Instagram profile could not be read.", 502);
  }
  const account = profile as Record<string, unknown>;
  const posts: ReturnType<typeof discoveryMedia>[] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < Math.ceil(input.maxPosts / 25); page++) {
    const url = new URL(`${endpoint}/media`);
    url.search = new URLSearchParams({ fields: "id,media_type,media_product_type,media_url,thumbnail_url,timestamp,like_count,comments_count,permalink,caption", limit: "25", access_token: input.accessToken, ...(cursor ? { after: cursor } : {}) }).toString();
    const payload = await discoveryJson(url.href, transport) as Record<string, unknown>;
    if (!payload || !Array.isArray(payload.data) || payload.data.length > 25) throw new InstagramDiscoveryError("DISCOVERY_PROVIDER_UNAVAILABLE", "Instagram media could not be read.", 502);
    for (const raw of payload.data) {
      const post = discoveryMedia(raw);
      if (!seen.has(post.id) && posts.length < input.maxPosts) posts.push(post);
      seen.add(post.id);
    }
    if (posts.length >= input.maxPosts) break;
    const next = readMediaCursor({ media: payload });
    if (!next.present) break;
    if (!next.usable || !next.cursor || cursors.has(next.cursor)) throw new InstagramDiscoveryError("DISCOVERY_PROVIDER_UNAVAILABLE", "Instagram media pagination could not be completed.", 502);
    cursor = next.cursor;
    cursors.add(cursor);
  }
  return { source: "graph_own", profile: discoveryProfile(account, input.username, "graph_own"), posts };
}

export function discoveryCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
