import { z } from "npm:zod@3.23.8";

export const INVALID_MODEL_OVERRIDE = "invalid_model_override" as const;

const ModelOverrideSchema = z.string().trim().min(1).max(200);

export interface AllowedAgentModel {
  provider: string;
  model_id: string;
}

export type SandboxModelOverrideResult =
  | { ok: true; modelRef: string | null }
  | { ok: false; error: typeof INVALID_MODEL_OVERRIDE };

/**
 * Only a platform admin's sandbox run may select a single allowed model. Live callers never
 * reach the allow-list read: their body cannot alter the configured chain or its credentials.
 * The override runs on platform credentials and skips the user's own-key requirement, so any
 * other signed-in user choosing it would spend the platform's quota (review, 2026-11-12).
 */
export async function resolveSandboxModelOverride(input: {
  dryRun: boolean;
  requestedOverride: unknown;
  isPlatformAdmin: () => Promise<boolean>;
  readAllowedModels: () => Promise<readonly AllowedAgentModel[]>;
}): Promise<SandboxModelOverrideResult> {
  if (!input.dryRun || input.requestedOverride === undefined) return { ok: true, modelRef: null };
  if (!(await input.isPlatformAdmin())) return { ok: false, error: INVALID_MODEL_OVERRIDE };

  const parsedOverride = ModelOverrideSchema.safeParse(input.requestedOverride);
  if (!parsedOverride.success) return { ok: false, error: INVALID_MODEL_OVERRIDE };

  const overrideText = parsedOverride.data;
  const allowedModels = await input.readAllowedModels();
  const matchedModel = allowedModels.find((row) =>
    overrideText === row.model_id || overrideText === `${row.provider}/${row.model_id}`
  );
  if (!matchedModel) return { ok: false, error: INVALID_MODEL_OVERRIDE };

  // Canonical refs keep bare legacy model ids tied to the provider that allow-listed them.
  return { ok: true, modelRef: `${matchedModel.provider}/${matchedModel.model_id}` };
}

export function invalidModelOverrideRefusalLog(input: {
  userId: string;
  platform: string;
  requestedOverride: unknown;
}) {
  return {
    source: "ai-agent-reply",
    category: "ai",
    level: "info",
    message: "AI agent sandbox refused: invalid model_override",
    user_id: input.userId,
    metadata: {
      platform: input.platform,
      error: INVALID_MODEL_OVERRIDE,
      ...(typeof input.requestedOverride === "string" ? { override_length: input.requestedOverride.length } : {}),
    },
  };
}
