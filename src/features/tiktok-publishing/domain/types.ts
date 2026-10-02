/** Types copied from the tiktok-review HTTP contract. Do not add fields the server does not return. */

export interface TikTokSettings {
  privacy: string | null;
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  disclose: boolean;
  yourBrand: boolean;
  brandedContent: boolean;
  aiGenerated: boolean;
}

export type ReviewState = "pending_review" | "rejected" | "archived" | "submitted";

export interface ReviewDraft {
  id: string;
  accountId: string;
  revision: number;
  state: ReviewState;
  caption: string;
  mediaFileId: string | null;
  mediaDurationSec: number | null;
  settings: TikTokSettings;
  rejectionReason: string | null;
  updatedAt: string;
  submission: {
    id: string;
    postId: string;
    mode: "now" | "scheduled";
    scheduledAt: string | null;
  } | null;
}

export interface CreatorInfo {
  nickname: string;
  username: string;
  avatarUrl: string | null;
  privacyLevelOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec: number;
  postingBlocked: boolean;
  postingBlockedReason: string | null;
}

export type PublishState = "scheduled" | "queued" | "processing" | "published" | "failed" | "needs_attention";

export interface PublishStatus {
  state: PublishState;
  updatedAt: string;
  reason: string | null;
  postUrl: string | null;
  /** The database's reopen rule, answered for this draft; never inferred from `state`. */
  reopenable: boolean;
}

export interface SubmitReviewCommand {
  draftId: string;
  expectedRevision: number;
  requestId: string;
  mode: "now" | "scheduled";
  scheduledAt: string | null;
  timeZone: string;
  consent: true;
}

export interface SubmissionResult {
  submissionId: string;
  postId: string;
  state: "queued" | "scheduled";
}

export interface TikTokAccount {
  id: string;
  username: string;
  avatarUrl: string | null;
}

export interface MediaPreview {
  previewUrl: string;
  fileType: "image" | "video" | "gif";
  durationSec: number | null;
}
