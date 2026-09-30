import { z } from "npm:zod@3.23.8";
import { TIKTOK_CAPTION_MAX_UTF16 } from "../_shared/tiktokPublishPolicy.ts";

const REVIEW_STATES = ["pending_review", "rejected", "archived", "submitted"] as const;

const SettingsSchema = z.object({
  privacy: z.string().nullable(),
  allowComment: z.boolean(),
  allowDuet: z.boolean(),
  allowStitch: z.boolean(),
  disclose: z.boolean(),
  yourBrand: z.boolean(),
  brandedContent: z.boolean(),
  aiGenerated: z.boolean(),
}).strict();

const uuid = z.string().uuid();
const revision = z.number().int().positive();

const ReviewRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("creator_info"), accountId: uuid }),
  z.object({
    action: z.literal("list"),
    accountId: uuid,
    state: z.enum(REVIEW_STATES),
  }),
  z.object({ action: z.literal("get"), draftId: uuid }),
  z.object({ action: z.literal("create"), accountId: uuid }),
  z.object({
    action: z.literal("save"),
    draftId: uuid,
    expectedRevision: revision,
    caption: z.string().max(TIKTOK_CAPTION_MAX_UTF16),
    mediaFileId: uuid.nullable(),
    mediaDurationSec: z.number().finite().positive().nullable(),
    settings: SettingsSchema,
  }),
  z.object({
    action: z.literal("reject"),
    draftId: uuid,
    expectedRevision: revision,
    reason: z.string(),
  }),
  z.object({
    action: z.literal("archive"),
    draftId: uuid,
    expectedRevision: revision,
  }),
  z.object({
    action: z.literal("restore"),
    draftId: uuid,
    expectedRevision: revision,
  }),
  z.object({
    action: z.literal("submit"),
    draftId: uuid,
    expectedRevision: revision,
    requestId: uuid,
    mode: z.enum(["now", "scheduled"]),
    scheduledAt: z.string().datetime({ offset: true }).nullable(),
    timeZone: z.string(),
    consent: z.literal(true),
  }),
  z.object({ action: z.literal("status"), submissionId: uuid }),
]);

export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

export class InvalidReviewRequest extends Error {
  constructor() {
    super("INVALID_REQUEST");
    this.name = "InvalidReviewRequest";
  }
}

/** IANA zone check. An invalid zone throws inside `Intl.DateTimeFormat`. */
function isIanaTimeZone(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

function assertSubmit(request: Extract<ReviewRequest, { action: "submit" }>): void {
  if (!isIanaTimeZone(request.timeZone)) throw new InvalidReviewRequest();
  if (request.mode === "now" && request.scheduledAt !== null) throw new InvalidReviewRequest();
  if (request.mode === "scheduled" && request.scheduledAt === null) {
    throw new InvalidReviewRequest();
  }
}

export function parseReviewRequest(body: unknown): ReviewRequest {
  const parsed = ReviewRequestSchema.safeParse(body);
  if (!parsed.success) throw new InvalidReviewRequest();
  if (parsed.data.action === "submit") assertSubmit(parsed.data);
  return parsed.data;
}
