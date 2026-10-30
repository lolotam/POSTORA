import { z } from "npm:zod@3.23.8";
import { OpeninaryVideoError } from "../_shared/openinaryVideoTransform.ts";

export const TranscodeSchema = z.object({
  media_file_id: z.string().min(1).max(128),
  /** Untrusted. Accepted for compatibility and checked against the caller's identity. */
  user_id: z.string().max(128).nullish(),
  /** Validated against the preset list by the planner; a missing value means tiktok, as before. */
  target_platform: z.string().max(32).nullish(),
});

export type TranscodeInput = z.infer<typeof TranscodeSchema>;

export function parseTranscodeRequest(body: unknown): TranscodeInput {
  const parsed = TranscodeSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  throw new OpeninaryVideoError("INVALID_REQUEST", `Invalid request: ${where}${issue?.message ?? "malformed body"}`);
}
