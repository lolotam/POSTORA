import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import { applyPendingWebhookEvents, applyTikTokPublishOutcome } from "../_shared/tiktokPublishOutcome.ts";
import { fetchPublishStatus, type PublishFetch } from "../_shared/tiktokContentPostingApi.ts";
import {
  type AdminClient,
  type Dependencies,
  type OwnedAccount,
  type Result,
  type Row,
  assertRead,
  findAccount,
  isRow,
  readFailed,
  readNullableString,
  readString,
  safeLog,
  success,
} from "./context.ts";
import { ReviewError } from "./errors.ts";
import { mapPublishStatus, type PlatformPostSnapshot, type PostSnapshot, type SubmissionSnapshot } from "./status.ts";

const STATUS_REFRESH_MS = 15_000;
const ORPHAN_STALE_MS = 3 * 60 * 1000;

type StoredSubmission = SubmissionSnapshot & {
  id: string;
  postId: string;
  socialAccountId: string;
  providerPublishId: string | null;
  lastStatusCheckAt: string | null;
};

/**
 * The runtime supplies the SDK client through the narrow review database port.
 * Only the shared outcome functions require its full SupabaseClient type.
 */
function asServiceRole(admin: AdminClient): SupabaseClient {
  return admin as unknown as SupabaseClient;
}

function mapPost(row: Row): PostSnapshot {
  const status = row.status;
  if (status !== null && status !== undefined && typeof status !== "string") {
    throw readFailed(new Error("Expected a post status."));
  }
  return {
    status: typeof status === "string" ? status : null,
    createdAt: readNullableString(row.created_at),
    postedAt: readNullableString(row.posted_at),
    scheduledAt: readNullableString(row.scheduled_at),
  };
}

type PlatformRow = PlatformPostSnapshot & { responseData: unknown };

function mapPlatform(row: Row): PlatformPostSnapshot {
  const status = row.status;
  if (status !== null && status !== undefined && typeof status !== "string") {
    throw readFailed(new Error("Expected a platform status."));
  }
  return {
    status: typeof status === "string" ? status : null,
    platformPostUrl: readNullableString(row.platform_post_url),
    errorMessage: readNullableString(row.error_message),
    createdAt: readNullableString(row.created_at),
    postedAt: readNullableString(row.posted_at),
  };
}

async function loadSubmission(admin: AdminClient, userId: string, submissionId: string): Promise<StoredSubmission> {
  const result = await admin.from("tiktok_review_submissions")
    .select(
      "id, post_id, social_account_id, dispatch_state, provider_publish_id, last_status_check_at, updated_at",
    )
    .eq("id", submissionId)
    .eq("user_id", userId)
    .maybeSingle();
  await assertRead(result);
  if (!isRow(result.data)) {
    throw new ReviewError(404, "NOT_FOUND", "That submission could not be found.");
  }
  const row = result.data;
  const id = readString(row.id);
  const postId = readString(row.post_id);
  const socialAccountId = readString(row.social_account_id);
  const dispatchState = readString(row.dispatch_state);
  const updatedAt = readString(row.updated_at);
  if (!id || !postId || !socialAccountId || !dispatchState || !updatedAt) {
    throw readFailed(new Error("Submission row is incomplete."));
  }
  return {
    id,
    postId,
    socialAccountId,
    dispatchState,
    updatedAt,
    providerPublishId: readNullableString(row.provider_publish_id),
    lastStatusCheckAt: readNullableString(row.last_status_check_at),
  };
}

async function loadOwnedPost(admin: AdminClient, userId: string, postId: string): Promise<PostSnapshot> {
  const result = await admin.from("posts")
    .select("status, created_at, posted_at, scheduled_at")
    .eq("id", postId)
    .eq("user_id", userId)
    .maybeSingle();
  await assertRead(result);
  if (!isRow(result.data)) throw readFailed(new Error("Post row is missing."));
  return mapPost(result.data);
}

async function loadPlatformPost(admin: AdminClient, postId: string): Promise<PlatformRow | null> {
  const result = await admin.from("platform_posts")
    .select("status, platform_post_url, error_message, response_data, created_at, posted_at")
    .eq("post_id", postId)
    .eq("platform", "tiktok")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  await assertRead(result);
  if (!isRow(result.data)) return null;
  return { ...mapPlatform(result.data), responseData: result.data.response_data };
}

function publishIdOf(platform: PlatformRow | null, submission: StoredSubmission): string | null {
  if (platform && isRow(platform.responseData)) {
    const fromRow = platform.responseData.tiktok_publish_id;
    if (typeof fromRow === "string" && fromRow.length > 0) return fromRow;
  }
  if (submission.providerPublishId && submission.providerPublishId.length > 0) {
    return submission.providerPublishId;
  }
  return null;
}

function checkIsStale(lastStatusCheckAt: string | null, nowMs: number): boolean {
  if (lastStatusCheckAt === null) return true;
  const checkedMs = Date.parse(lastStatusCheckAt);
  if (!Number.isFinite(checkedMs)) return true;
  return nowMs - checkedMs > STATUS_REFRESH_MS;
}

async function claimStatusCheck(
  admin: AdminClient,
  userId: string,
  submission: StoredSubmission,
  nowIso: string,
): Promise<boolean> {
  let query = admin.from("tiktok_review_submissions")
    .update({ last_status_check_at: nowIso })
    .eq("id", submission.id)
    .eq("user_id", userId);
  query = submission.lastStatusCheckAt === null
    ? query.is("last_status_check_at", null)
    : query.eq("last_status_check_at", submission.lastStatusCheckAt);
  const result = await query.select("id");
  await assertRead(result);
  if (Array.isArray(result.data)) return result.data.length > 0;
  return isRow(result.data);
}

async function refreshStatus(
  deps: Dependencies,
  userId: string,
  submission: StoredSubmission,
  platform: PlatformRow | null,
): Promise<boolean> {
  const orphaned = !platform && submission.providerPublishId !== null &&
    ["publishing", "dispatched", "unknown", "needs_attention"].includes(submission.dispatchState) &&
    deps.now() - Date.parse(submission.updatedAt) > ORPHAN_STALE_MS;
  if (platform ? platform.status !== "pending" : !orphaned) return false;
  const publishId = publishIdOf(platform, submission);
  if (!publishId || !checkIsStale(submission.lastStatusCheckAt, deps.now())) return false;
  const claimed = await claimStatusCheck(
    deps.admin,
    userId,
    submission,
    new Date(deps.now()).toISOString(),
  );
  if (!claimed) return false;

  const logProvider = (code: string) =>
    safeLog(deps, {
      event: "tiktok_review_provider_failed",
      action: "status",
      code,
      user_id: userId,
      draft_id: null,
      submission_id: submission.id,
      level: "error",
    });

  if (platform) {
    try {
      await applyPendingWebhookEvents(asServiceRole(deps.admin), publishId);
    } catch {
      await logProvider("PROVIDER_UNAVAILABLE");
    }
  }

  const current = await loadPlatformPost(deps.admin, submission.postId);
  if (current ? current.status !== "pending" : !orphaned) return true;

  const account = await findAccount(deps.admin, userId, submission.socialAccountId);
  if (!account?.accessToken) {
    await logProvider(account ? "TOKEN_INVALID" : "ACCOUNT_NOT_FOUND");
    return true;
  }
  const fetched = await fetchPublishStatus(deps.fetch, account.accessToken, publishId);
  if (fetched.kind === "unavailable") {
    await logProvider(fetched.code);
    return true;
  }
  if (fetched.kind === "pending") return true;
  if (!current) {
    await settleOrphan(deps.admin, { submission, publishId, account, fetched });
    try {
      await applyPendingWebhookEvents(asServiceRole(deps.admin), publishId);
    } catch {
      await logProvider("WEBHOOK_REPLAY_FAILED");
    }
    return true;
  }
  try {
    const outcome = fetched.kind === "complete"
      ? { kind: "published" as const, providerPostId: fetched.providerPostId }
      : { kind: "failed" as const, reason: fetched.reason };
    await applyTikTokPublishOutcome(asServiceRole(deps.admin), {
      publishId,
      userOpenId: account.platformUserId,
      outcome,
    });
  } catch {
    await logProvider("PROVIDER_UNAVAILABLE");
  }
  return true;
}

async function settleOrphan(
  admin: AdminClient,
  input: {
    submission: StoredSubmission;
    publishId: string;
    account: OwnedAccount;
    fetched: Extract<PublishFetch, { kind: "complete" | "failed" }>;
  },
): Promise<void> {
  const { submission, publishId, account, fetched } = input;
  const providerPostId = fetched.providerPostId;
  const handle = (account.platformUsername ?? "").replace(/^@/, "");
  const { error } = await admin.rpc("partner_settle_platform_post", {
    p_platform_post_id: null,
    p_post_id: submission.postId,
    p_social_account_id: submission.socialAccountId,
    p_platform: "tiktok",
    p_status: fetched.kind === "complete" ? "success" : "failed",
    p_provider_post_id: providerPostId,
    p_provider_post_url: providerPostId ? `https://www.tiktok.com/@${handle}/video/${providerPostId}` : null,
    p_error_message: fetched.kind === "failed" ? `TikTok publish failed: ${fetched.reason}` : null,
    p_response_data: { tiktok_publish_id: publishId, reconciled_by: "tiktok-review" },
  });
  if (error) throw readFailed(error);
}

export async function readStatus(deps: Dependencies, userId: string, submissionId: string): Promise<Result> {
  const submission = await loadSubmission(deps.admin, userId, submissionId);
  const post = await loadOwnedPost(deps.admin, userId, submission.postId);
  const platform = await loadPlatformPost(deps.admin, submission.postId);
  const refreshed = await refreshStatus(deps, userId, submission, platform);
  const currentSubmission = refreshed ? await loadSubmission(deps.admin, userId, submissionId) : submission;
  const currentPost = refreshed ? await loadOwnedPost(deps.admin, userId, submission.postId) : post;
  const currentPlatform = refreshed ? await loadPlatformPost(deps.admin, submission.postId) : platform;
  return success(mapPublishStatus({
    platformPost: currentPlatform,
    post: currentPost,
    submission: {
      dispatchState: currentSubmission.dispatchState,
      updatedAt: currentSubmission.updatedAt,
      providerPublishId: currentSubmission.providerPublishId,
    },
    nowMs: deps.now(),
  }));
}
