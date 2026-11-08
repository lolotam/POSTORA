import { z } from "npm:zod@3.23.8";
import { sanitizeErrorMessage } from "../_shared/errorSanitizer.ts";

const BodySchema = z.discriminatedUnion("mode", [
  z.object({ post_id: z.string().uuid(), mode: z.literal("retry_story"), result_id: z.string().uuid() }).strict(),
  z.object({ post_id: z.string().uuid(), mode: z.literal("publish_now") }).strict(),
  z.object({
    post_id: z.string().uuid(), mode: z.literal("retry"),
    account_ids: z.array(z.string().uuid()).min(1).max(50).optional(),
  }).strict(),
]);

export type RetryResult =
  | { status: "accepted"; requested_at: string; account_ids: string[]; platforms: string[] }
  | { status: "refused"; reason: "not_found" | "not_retryable" | "no_targets" };

export interface KickPayload {
  post_id: string;
  expected_publish_requested_at: string;
}

export interface EnqueueDependencies {
  requestStoryRetry?(postId: string, resultId: string, userId: string): Promise<boolean>;
  requestImmediatePublish(postId: string, userId: string): Promise<string | null>;
  requestPostRetry(postId: string, userId: string, accountIds?: string[]): Promise<RetryResult>;
  readPostStatus(postId: string, userId: string): Promise<string | null>;
  /** Resolves after registering bounded background work, not after publishing. */
  kick(payload: KickPayload): Promise<void>;
  logRefusal(row: Record<string, unknown>): Promise<void>;
}

interface EnqueueResponse { status: number; body: Record<string, unknown> }

export function refusalRow(message: string, userId: string | null, metadata: Record<string, unknown> = {}) {
  return { level: "warn", category: "post", source: "enqueue-post-publish", message, user_id: userId, metadata };
}

async function refuse(deps: EnqueueDependencies, callerId: string, postId: string, reason: string): Promise<EnqueueResponse> {
  await deps.logRefusal(refusalRow(reason, callerId, { post_id: postId }));
  // Stable domain codes are the browser's contract; unexpected error text is sanitized below.
  return { status: reason === "not_found" ? 404 : 409, body: { error: reason } };
}

async function accept(deps: EnqueueDependencies, postId: string, requestedAt: string): Promise<EnqueueResponse> {
  try {
    await deps.kick({ post_id: postId, expected_publish_requested_at: requestedAt });
  } catch (error) {
    // The durable request is already committed. The scheduler recovers a failed kick.
    await deps.logRefusal(refusalRow("publish_kick_failed", null, {
      post_id: postId, status: null, error: sanitizeErrorMessage(error),
    }));
  }
  return { status: 202, body: { accepted: true, post_id: postId, status: "processing" } };
}

async function enqueue(deps: EnqueueDependencies, callerId: string, body: z.infer<typeof BodySchema>): Promise<EnqueueResponse> {
  if (body.mode === "retry_story") {
    if (!deps.requestStoryRetry || !await deps.requestStoryRetry(body.post_id, body.result_id, callerId)) {
      return await refuse(deps, callerId, body.post_id, "not_retryable");
    }
    // The periodic background worker owns delivery. Never kick the primary publisher.
    return { status: 202, body: { accepted: true, post_id: body.post_id, status: "processing" } };
  }
  if (body.mode === "retry") {
    const retry = await deps.requestPostRetry(body.post_id, callerId, body.account_ids);
    return retry.status === "accepted"
      ? await accept(deps, body.post_id, retry.requested_at)
      : await refuse(deps, callerId, body.post_id, retry.reason);
  }
  const requestedAt = await deps.requestImmediatePublish(body.post_id, callerId);
  if (requestedAt !== null) return await accept(deps, body.post_id, requestedAt);
  const postStatus = await deps.readPostStatus(body.post_id, callerId);
  if (postStatus === "processing") {
    await deps.logRefusal(refusalRow("already_processing", callerId, { post_id: body.post_id }));
    return { status: 202, body: { accepted: true, post_id: body.post_id, status: "processing", already: true } };
  }
  return await refuse(deps, callerId, body.post_id, postStatus === null ? "not_found" : "not_publishable");
}

export async function run(deps: EnqueueDependencies, input: { callerId: string; body: unknown }): Promise<EnqueueResponse> {
  const parsed = BodySchema.safeParse(input.body);
  if (!parsed.success) {
    await deps.logRefusal(refusalRow("invalid_request", input.callerId));
    return { status: 400, body: { error: sanitizeErrorMessage("Invalid request") } };
  }
  try {
    return await enqueue(deps, input.callerId, parsed.data);
  } catch (error) {
    const message = sanitizeErrorMessage(error);
    await deps.logRefusal(refusalRow("enqueue_failed", input.callerId, { post_id: parsed.data.post_id, error: message }));
    return { status: 500, body: { error: message } };
  }
}
