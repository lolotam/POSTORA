/* eslint-disable @typescript-eslint/no-explicit-any */
import type { CommentAutomationAccount } from "./commentAutomation.ts";
import {
  ingestPolledComment,
  type PolledCommentInput,
  type PolledCommentOutcome,
  type PolledIngestOptions,
} from "./polledCommentIngest.ts";

export type ThreadsCommentOutcome = PolledCommentOutcome;
export type ThreadsCommentInput = PolledCommentInput;
export type ThreadsIngestOptions = PolledIngestOptions;

/** The Threads door. The invariants in polledCommentIngest are per platform, not per source. */
export function ingestThreadsComment(
  admin: any,
  account: CommentAutomationAccount,
  comment: ThreadsCommentInput,
  options: ThreadsIngestOptions,
): Promise<ThreadsCommentOutcome> {
  return ingestPolledComment(admin, account, "threads", comment, options);
}
