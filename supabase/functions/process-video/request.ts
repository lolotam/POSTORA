import { z } from "npm:zod@3.23.8";
import { MAX_TARGET_DIMENSION, OpeninaryVideoError } from "../_shared/openinaryVideoTransform.ts";

/** `maxSizeMB` is NaN in the browser when the size field is empty, which JSON turns into null. */
const optionalPositive = z.number().finite().nullish().transform((value) => value ?? undefined);

/** Same bound as the planner (MAX_TARGET_DIMENSION): reject here so the error names the field. */
const optionalTarget = z.number().int().min(1).max(MAX_TARGET_DIMENSION).nullish().transform((value) => value ?? undefined);

const CropSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
  targetWidth: optionalTarget,
  targetHeight: optionalTarget,
});

const CompressSchema = z.object({
  quality: z.number().finite(),
  maxSizeMB: optionalPositive,
});

export const ProcessVideoSchema = z.object({
  media_file_id: z.string().min(1).max(128),
  /** Untrusted. Accepted for compatibility and checked against the caller's identity. */
  user_id: z.string().max(128).nullish(),
  operation: z.enum(["crop", "compress", "get_metadata"]),
  debug_mode: z.boolean().nullish(),
  /** What the player reports; used only when the library row records no size. */
  source_dimensions: z.object({ width: z.number().finite(), height: z.number().finite() }).nullish(),
  crop: CropSchema.nullish(),
  compress: CompressSchema.nullish(),
}).superRefine((value, ctx) => {
  if (value.operation === "crop" && !value.crop) ctx.addIssue({ code: "custom", path: ["crop"], message: "crop settings are required" });
  if (value.operation === "compress" && !value.compress) ctx.addIssue({ code: "custom", path: ["compress"], message: "compress settings are required" });
});

export type ProcessVideoInput = z.infer<typeof ProcessVideoSchema>;

export function parseProcessVideoRequest(body: unknown): ProcessVideoInput {
  const parsed = ProcessVideoSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  throw new OpeninaryVideoError("INVALID_REQUEST", `Invalid request: ${where}${issue?.message ?? "malformed body"}`);
}
