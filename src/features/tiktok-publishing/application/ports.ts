import { createContext, createElement, useContext, type ReactNode } from "react";
import type {
  CreatorInfo,
  MediaPreview,
  PublishStatus,
  ReviewDraft,
  ReviewState,
  SubmissionResult,
  SubmitReviewCommand,
  TikTokAccount,
  TikTokSettings,
} from "../domain/types";

export type ReviewSavePatch = {
  caption: string;
  mediaFileId: string | null;
  mediaDurationSec: number | null;
  settings: TikTokSettings;
};

export interface TikTokReviewGateway {
  listAccounts(): Promise<TikTokAccount[]>;
  creatorInfo(accountId: string): Promise<CreatorInfo>;
  list(accountId: string, state: ReviewState): Promise<ReviewDraft[]>;
  get(draftId: string): Promise<ReviewDraft>;
  create(accountId: string): Promise<ReviewDraft>;
  save(draftId: string, expectedRevision: number, patch: ReviewSavePatch): Promise<ReviewDraft>;
  reject(draftId: string, expectedRevision: number, reason: string): Promise<ReviewDraft>;
  archive(draftId: string, expectedRevision: number): Promise<ReviewDraft>;
  restore(draftId: string, expectedRevision: number): Promise<ReviewDraft>;
  reopen(draftId: string, expectedRevision: number): Promise<ReviewDraft>;
  submit(command: SubmitReviewCommand): Promise<SubmissionResult>;
  status(submissionId: string): Promise<PublishStatus>;
  resolveMediaPreview(mediaFileId: string): Promise<MediaPreview | null>;
}

/** Expected failure from tiktok-review or a Supabase read. UI branches on `code`, not on message text. */
export class ReviewGatewayError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ReviewGatewayError";
    this.code = code;
    this.status = status;
  }
}

const TikTokReviewGatewayContext = createContext<TikTokReviewGateway | null>(null);

export function TikTokReviewGatewayProvider({
  gateway,
  children,
}: {
  gateway: TikTokReviewGateway;
  children: ReactNode;
}) {
  return createElement(TikTokReviewGatewayContext.Provider, { value: gateway }, children);
}

export function useTikTokReviewGateway(): TikTokReviewGateway {
  const gateway = useContext(TikTokReviewGatewayContext);
  if (!gateway) {
    throw new Error("useTikTokReviewGateway must be used within TikTokReviewGatewayProvider");
  }
  return gateway;
}
