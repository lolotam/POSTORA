// Deletes ONE already-published post on the platform that published it, through a
// registry of per-provider adapters. Instagram and TikTok expose no delete endpoint
// for published posts in their public APIs, so those posts stay on the platform and
// the caller is told to remove them in the app.
import {
  FACEBOOK_GRAPH,
  THREADS_GRAPH,
} from "../_shared/commentActions.ts";
import {
  deleteYouTubeVideo,
  type YouTubeCommentAccount,
  type YouTubeCommentsDeps,
} from "../_shared/youtubeComments.ts";
import { fetchWithTimeout } from "../_shared/request-timeout.ts";

export type PlatformDeleteOutcome =
  | { outcome: "deleted"; note?: string }
  | { outcome: "not_supported"; reason: string }
  | { outcome: "failed"; reason: string };

export interface PublishedPlatformPost {
  /** platform_posts.id -- the row this delete is about, used for the audit log only. */
  id: string;
  platform: string;
  platform_post_id: string | null;
  social_account_id: string | null;
  response_data: unknown;
  /**
   * The posts.metadata of the post this row belongs to. It says what the post
   * went out as -- a Facebook feed post and a story, two LinkedIn
   * destinations -- and platform_posts keeps one id for the lot of them.
   */
  post_metadata: Record<string, unknown> | null;
}

export interface DeleteAccount {
  id: string;
  user_id: string;
  platform: string;
  access_token: string | null;
  refresh_token?: string | null;
  token_expires_at?: string | null;
  auth_provider?: string | null;
  connection_id?: string | null;
  workspace_id?: string | null;
  platform_user_id?: string | null;
  account_metadata?: Record<string, unknown> | null;
}

export interface PlatformDeleteDeps {
  fetcher: typeof fetch;
  /** Lazy so tests and non-YouTube deletes never build a real Supabase client. */
  youtubeDeps: () => YouTubeCommentsDeps;
}

export const PROVIDER_TIMEOUT_MS = 15_000;

type Deleter = (
  platformPostId: string,
  row: PublishedPlatformPost,
  account: DeleteAccount,
  deps: PlatformDeleteDeps,
) => Promise<PlatformDeleteOutcome>;

function missingToken(): PlatformDeleteOutcome {
  return {
    outcome: "failed",
    reason: "The account has no access token. Reconnect it in Profiles and retry.",
  };
}

const NO_PLATFORM_POST_ID =
  "Postora has no platform post id for this result, so it cannot be deleted on the platform.";

// Instagram deletes a published media only through the Graph API of a
// Facebook-Login connection that carries the instagram_manage_contents
// permission. Postora does not request that permission yet, so the post stays
// on the platform and the caller is told where to remove it.
const INSTAGRAM_NOT_SUPPORTED =
  "Instagram deletes published media only for Facebook-Login connections with the instagram_manage_contents permission, which Postora does not request yet; remove it in the Instagram app.";

// TikTok's public API has no endpoint that deletes a published post.
const TIKTOK_NOT_SUPPORTED =
  "TikTok has no API to delete a published post; remove it in the TikTok app.";

// The Threads delete needs a permission the connection may not carry. The post
// is not refused by the platform: the connection has to be redone.
const THREADS_PERMISSION_MISSING =
  "Reconnect Threads to allow deleting posts.";

// A platform copy that is already gone is not a failure: the caller asked for it to
// be gone, and it is.
const ALREADY_GONE: PlatformDeleteOutcome = {
  outcome: "deleted",
  note: "Already removed on the platform.",
};

// A provider message can carry the request URL, and the Graph URL carries the access
// token. Nothing that reaches the log or the caller may contain one.
export function redactTokens(text: string): string {
  return text
    .replace(/access_token=[^\s&]*/gi, "access_token=[redacted]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]");
}

// The Graph answer of a delete, and everything a caller has to know about it.
//
// The Graph error code is kept because the Threads adapter tells a missing
// permission (code 10 or 200) from a plain refusal by it. The shared
// callGraph helper of ../commentActions.ts answers with the message only, so
// the delete reads the body itself.
interface GraphDeleteAnswer {
  ok: boolean;
  data: Record<string, unknown> | null;
  /** Meta's own message, when Meta sent one. */
  error: string | null;
  /** The Graph error code, when Meta sent one. */
  errorCode: number | null;
  /** The platform could not be reached: there is no provider message. */
  upstreamUnavailable: boolean;
  /** The object is not there any more. */
  notFound: boolean;
}

// Facebook and Threads are the same Graph call against a different host, so the
// shape lives here once and each platform keeps its own name in the message it
// reports.
async function graphDelete(
  graph: string,
  platformPostId: string,
  token: string,
  deps: PlatformDeleteDeps,
): Promise<GraphDeleteAnswer> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${graph}/${encodeURIComponent(platformPostId)}?access_token=${encodeURIComponent(token)}`,
      { method: "DELETE" },
      PROVIDER_TIMEOUT_MS,
      deps.fetcher,
    );
  } catch {
    // No provider message: a transport error can carry the request URL, and
    // the Graph URL carries the token.
    return {
      ok: false,
      data: null,
      error: null,
      errorCode: null,
      upstreamUnavailable: true,
      notFound: false,
    };
  }

  let data: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed === "object" && parsed !== null) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // A body that is not JSON is a failed read, not an empty answer.
    data = null;
  }

  const rawError = data?.error;
  const errorObject = typeof rawError === "object" && rawError !== null
    ? (rawError as { message?: unknown; code?: unknown })
    : null;
  const errorText = errorObject
    ? (typeof errorObject.message === "string" && errorObject.message.length > 0
      ? errorObject.message
      : null)
    : (typeof rawError === "string" && rawError.length > 0 ? rawError : null);
  const errorCode = errorObject && typeof errorObject.code === "number"
    ? errorObject.code
    : null;

  if (!response.ok || (rawError !== undefined && rawError !== null)) {
    return {
      ok: false,
      data,
      error: errorText,
      errorCode,
      upstreamUnavailable: false,
      notFound: response.status === 404,
    };
  }

  return {
    ok: true,
    data,
    error: null,
    errorCode: null,
    upstreamUnavailable: false,
    notFound: response.status === 404,
  };
}

// The Facebook items a post went out as.
//
// The metadata carries one type for a post that is one thing, and a list for a
// post that is more than one thing: a feed post, a story and a reel are three
// objects on Facebook, and Postora keeps one id for the lot of them.
function facebookPostTypes(postMetadata: Record<string, unknown> | null): string[] {
  const raw = postMetadata?.facebook_post_type;
  if (!Array.isArray(raw)) return [];
  const types: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    // The same type twice is one item, not two.
    if (!types.includes(trimmed)) types.push(trimmed);
  }
  return types;
}

// The Facebook items Postora never recorded, when the post went out as more
// than one thing. Null when there is nothing left over, because then the
// delete of the recorded id is the whole delete.
//
// A delete that says "deleted" for a post that is a feed post AND a story
// would hide the story: the caller would believe the post is gone from
// Facebook while one of its copies is still there.
function facebookLeftover(
  row: PublishedPlatformPost,
  deletedNote: string,
): PlatformDeleteOutcome | null {
  const types = facebookPostTypes(row.post_metadata);
  if (types.length <= 1) return null;
  return {
    outcome: "not_supported",
    reason:
      `This post created ${types.length} Facebook items (${types.join(", ")}); Postora recorded only one of them${deletedNote}. Delete the others in Facebook.`,
  };
}

async function deleteFacebook(
  platformPostId: string,
  row: PublishedPlatformPost,
  account: DeleteAccount,
  deps: PlatformDeleteDeps,
): Promise<PlatformDeleteOutcome> {
  if (!account.access_token) return missingToken();
  const answer = await graphDelete(FACEBOOK_GRAPH, platformPostId, account.access_token, deps);
  // A post that is not there any more is already what the caller wanted.
  if (answer.notFound) {
    return facebookLeftover(row, " and it was already gone") ?? ALREADY_GONE;
  }
  if (!answer.ok) {
    if (answer.upstreamUnavailable) {
      return { outcome: "failed", reason: "Could not reach Facebook. Try again." };
    }
    return {
      outcome: "failed",
      reason: answer.error ?? "Facebook rejected the delete request.",
    };
  }
  // Graph answers a delete with {"success": true}; an explicit false is a refusal.
  if (answer.data?.success === false) {
    return { outcome: "failed", reason: "Facebook did not confirm the delete." };
  }
  // The recorded id is gone. A post that went out as more than one Facebook
  // item is not: the other items are still on Facebook, and the caller is told
  // about them instead of being told that the post is deleted.
  return facebookLeftover(row, " and deleted it") ?? { outcome: "deleted" };
}

// Threads answers a connection that may not delete with an OAuthException:
// code 10 (the token may not delete) and code 200 (the token may not do this at
// all). Both are a missing permission and not a refusal of this post.
const THREADS_PERMISSION_CODES = new Set([10, 200]);

function isThreadsPermissionError(answer: GraphDeleteAnswer): boolean {
  if (answer.errorCode !== null && THREADS_PERMISSION_CODES.has(answer.errorCode)) {
    return true;
  }
  return /permission/i.test(answer.error ?? "");
}

async function deleteThreads(
  platformPostId: string,
  _row: PublishedPlatformPost,
  account: DeleteAccount,
  deps: PlatformDeleteDeps,
): Promise<PlatformDeleteOutcome> {
  if (!account.access_token) return missingToken();
  const answer = await graphDelete(THREADS_GRAPH, platformPostId, account.access_token, deps);
  // A post that is not there any more is already what the caller wanted.
  if (answer.notFound) return ALREADY_GONE;
  if (!answer.ok) {
    if (isThreadsPermissionError(answer)) {
      return { outcome: "not_supported", reason: THREADS_PERMISSION_MISSING };
    }
    if (answer.upstreamUnavailable) {
      return { outcome: "failed", reason: "Could not reach Threads. Try again." };
    }
    return {
      outcome: "failed",
      reason: answer.error ?? "Threads rejected the delete request.",
    };
  }
  if (answer.data?.success === false) {
    return { outcome: "failed", reason: "Threads did not confirm the delete." };
  }
  return { outcome: "deleted" };
}

async function deleteYoutube(
  platformPostId: string,
  _row: PublishedPlatformPost,
  account: DeleteAccount,
  deps: PlatformDeleteDeps,
): Promise<PlatformDeleteOutcome> {
  // A Composio connection has no Google credential of ours to call the Data API with.
  if (account.auth_provider === "composio") {
    return {
      outcome: "not_supported",
      reason: "This YouTube channel is connected through Composio, which cannot delete videos through Postora. Delete it in YouTube Studio.",
    };
  }
  const result = await deleteYouTubeVideo(
    account as unknown as YouTubeCommentAccount,
    { ...deps.youtubeDeps(), fetcher: deps.fetcher },
    platformPostId,
  );
  // A video that is not there any more is already what the caller wanted.
  if (!result.ok && result.kind === "not_found") return ALREADY_GONE;
  if (!result.ok) return { outcome: "failed", reason: result.message };
  return { outcome: "deleted" };
}

// A Pinterest post with several images becomes one pin per image, and the publish
// keeps every pin id in platform_post_id joined by commas. Each of them is its own
// pin on Pinterest, so each one is deleted on its own: sending the whole string as
// one id makes Pinterest answer 404, and that 404 says nothing about the pins that
// are really there.
function pinterestPinIds(platformPostId: string): string[] {
  return platformPostId
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

async function deletePinterest(
  platformPostId: string,
  _row: PublishedPlatformPost,
  account: DeleteAccount,
  deps: PlatformDeleteDeps,
): Promise<PlatformDeleteOutcome> {
  if (!account.access_token) return missingToken();
  const pinIds = pinterestPinIds(platformPostId);
  if (pinIds.length === 0) {
    return { outcome: "not_supported", reason: NO_PLATFORM_POST_ID };
  }
  const failures: string[] = [];
  let deleted = 0;
  let alreadyGone = 0;
  for (const pinId of pinIds) {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        `https://api.pinterest.com/v5/pins/${encodeURIComponent(pinId)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${account.access_token}` },
        },
        PROVIDER_TIMEOUT_MS,
        deps.fetcher,
      );
    } catch {
      // No provider message: a transport error can carry the request URL, and the
      // Pinterest URL carries the token in its header.
      failures.push(`${pinId}: could not reach Pinterest`);
      continue;
    }
    if (response.status >= 200 && response.status < 300) {
      deleted += 1;
      continue;
    }
    // A pin that is not there any more is already what the caller wanted.
    if (response.status === 404) {
      alreadyGone += 1;
      continue;
    }
    failures.push(`${pinId}: Pinterest returned ${response.status}`);
  }
  if (failures.length === 0) {
    return alreadyGone === pinIds.length ? ALREADY_GONE : { outcome: "deleted" };
  }
  return {
    outcome: "failed",
    reason:
      `Deleted ${deleted + alreadyGone} of ${pinIds.length} Pinterest pins. ${failures.join("; ")}`,
  };
}

// One LinkedIn publish can land on several destinations (a personal feed and one or more
// organization pages), and every destination is its own ugcPost. The publish result
// keeps them all, so the delete has to walk them too.
//
// A publish result does not always keep them: the stored answer of a publish
// carries the primary URN and nothing else. The flag says which of the two
// this row is, because only the first case knows every copy it deleted.
function linkedinDestinationUrns(
  row: PublishedPlatformPost,
  platformPostId: string,
): { urns: string[]; destinationsRecorded: boolean } {
  const data = row.response_data as { destinations?: unknown } | null | undefined;
  const destinations = Array.isArray(data?.destinations) ? data.destinations : null;
  const urns: string[] = [];
  for (const entry of destinations ?? []) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { status?: unknown; post_id?: unknown };
    if (candidate.status !== "success") continue;
    const postId = typeof candidate.post_id === "string" ? candidate.post_id.trim() : "";
    if (!postId) continue;
    urns.push(postId);
  }
  if (urns.length > 0) return { urns, destinationsRecorded: true };
  return { urns: [platformPostId], destinationsRecorded: destinations !== null };
}

// How many LinkedIn destinations this account was asked to publish to.
//
// The stored answer of a publish does not always keep the list of
// destinations, so the post's metadata is what says how many copies of the
// post are on LinkedIn. The metadata holds the destinations of every account
// of the post, so only the ones of this account are counted.
function linkedinDestinationCount(row: PublishedPlatformPost): number {
  const metadata = row.post_metadata;
  if (!metadata) return 0;
  const selections = metadata.linkedin_destinations;
  if (Array.isArray(selections)) {
    if (typeof row.social_account_id !== "string") return 0;
    const selectedIds = new Set<string>();
    for (const selection of selections) {
      if (!selection || typeof selection !== "object") continue;
      const candidate = selection as { account_id?: unknown; destination_id?: unknown };
      if (candidate.account_id !== row.social_account_id) continue;
      if (typeof candidate.destination_id !== "string") continue;
      const destinationId = candidate.destination_id.trim();
      if (destinationId.length === 0) continue;
      // The same destination twice is one copy, not two.
      selectedIds.add(destinationId);
    }
    return selectedIds.size;
  }
  const ids = metadata.linkedin_destination_ids;
  if (!Array.isArray(ids)) return 0;
  const askedIds = new Set<string>();
  for (const value of ids) {
    if (typeof value !== "string") continue;
    const destinationId = value.trim();
    if (destinationId.length === 0) continue;
    askedIds.add(destinationId);
  }
  return askedIds.size;
}

async function deleteLinkedin(
  platformPostId: string,
  row: PublishedPlatformPost,
  account: DeleteAccount,
  deps: PlatformDeleteDeps,
): Promise<PlatformDeleteOutcome> {
  if (!account.access_token) return missingToken();
  const { urns, destinationsRecorded } = linkedinDestinationUrns(row, platformPostId);
  const failures: string[] = [];
  let deleted = 0;
  let alreadyGone = 0;
  for (const urn of urns) {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        `https://api.linkedin.com/v2/ugcPosts/${encodeURIComponent(urn)}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${account.access_token}`,
            "X-Restli-Protocol-Version": "2.0.0",
          },
        },
        PROVIDER_TIMEOUT_MS,
        deps.fetcher,
      );
    } catch {
      failures.push(`${urn}: could not reach LinkedIn`);
      continue;
    }
    if (response.status >= 200 && response.status < 300) {
      deleted += 1;
      continue;
    }
    // A destination that is not there any more is already what the caller wanted.
    if (response.status === 404) {
      alreadyGone += 1;
      continue;
    }
    failures.push(`${urn}: LinkedIn returned ${response.status}`);
  }
  if (failures.length > 0) {
    return {
      outcome: "failed",
      reason: `Deleted ${deleted + alreadyGone} of ${urns.length} LinkedIn destinations. ${failures.join("; ")}`,
    };
  }
  // The stored answer kept the list of destinations, so every copy Postora
  // knows about is gone.
  if (destinationsRecorded) {
    return alreadyGone === urns.length ? ALREADY_GONE : { outcome: "deleted" };
  }
  // The stored answer does not say how many copies are out there, so the
  // metadata does. A post that went to several destinations has copies Postora
  // never recorded, and a delete that says "deleted" would hide them.
  const count = linkedinDestinationCount(row);
  if (count > 1) {
    const deletedNote = deleted > 0 ? " and deleted it" : " and it was already gone";
    return {
      outcome: "not_supported",
      reason: `This post went to ${count} LinkedIn destinations but Postora recorded only one${deletedNote}. Delete the others on LinkedIn.`,
    };
  }
  return alreadyGone === urns.length ? ALREADY_GONE : { outcome: "deleted" };
}

const DELETERS: Record<string, Deleter> = {
  facebook: deleteFacebook,
  threads: deleteThreads,
  youtube: deleteYoutube,
  pinterest: deletePinterest,
  linkedin: deleteLinkedin,
};

export async function deletePublishedPost(
  row: PublishedPlatformPost,
  account: DeleteAccount | null,
  deps: PlatformDeleteDeps,
): Promise<PlatformDeleteOutcome> {
  // Object.hasOwn, not a plain lookup: an inherited key ("constructor",
  // "toString") is not a deleter, and calling one would run the wrong code.
  const deleter = Object.hasOwn(DELETERS, row.platform) ? DELETERS[row.platform] : undefined;
  if (!deleter) {
    if (row.platform === "instagram") {
      return { outcome: "not_supported", reason: INSTAGRAM_NOT_SUPPORTED };
    }
    if (row.platform === "tiktok") {
      return { outcome: "not_supported", reason: TIKTOK_NOT_SUPPORTED };
    }
    return {
      outcome: "not_supported",
      reason: `Postora cannot delete posts on ${row.platform} yet; remove it in the ${row.platform} app.`,
    };
  }

  if (!row.platform_post_id) {
    return {
      outcome: "not_supported",
      reason: NO_PLATFORM_POST_ID,
    };
  }

  if (!account) {
    return {
      outcome: "not_supported",
      reason: `The ${row.platform} account that published this post is no longer connected to Postora, so it cannot be deleted on the platform.`,
    };
  }

  try {
    const outcome = await deleter(row.platform_post_id, row, account, deps);
    if (outcome.outcome === "failed") {
      // The reason is the one text a provider controls, so it is redacted once here:
      // everything that leaves this function goes through this block.
      const reason = redactTokens(outcome.reason);
      // Ids and the reason only: a token must never reach the log.
      console.warn(
        `[n8n-api] posts/delete: ${row.platform} delete failed for platform_posts ${row.id}: ${reason}`,
      );
      return { outcome: "failed", reason };
    }
    return outcome;
  } catch (thrown) {
    // The name only: a provider message can carry a URL with a token in it.
    console.error(
      `[n8n-api] posts/delete: unexpected ${row.platform} delete error for platform_posts ${row.id}: ${thrown instanceof Error ? thrown.name : "unknown"}`,
    );
    return {
      outcome: "failed",
      reason: `Unexpected error while deleting on ${row.platform}.`,
    };
  }
}
