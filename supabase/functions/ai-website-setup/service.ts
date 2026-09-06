import {
  type ConfigSnapshot,
  mergeDraft,
  type WebsiteSetupDraft,
} from "./draft.ts";

export interface SetupJob {
  id: string;
  source_id: string;
  social_account_id: string;
  platform: string;
  status: "pending" | "processing" | "ready" | "failed" | "applied";
  result: WebsiteSetupDraft | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}
export interface SetupDb {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<
    { data: unknown; error: { code?: string; message?: string } | null }
  >;
}
export class SetupError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}
export async function setupRpc(
  db: SetupDb,
  name: string,
  args: Record<string, unknown>,
) {
  const { data, error } = await db.rpc(name, args);
  if (error) {
    if (error.code === "42501") {
      throw new SetupError("Setup target unavailable.", 403);
    }
    if (error.code === "40001" || error.code === "23505") {
      throw new SetupError(
        "Configuration changed. Reload before applying.",
        409,
      );
    }
    if (error.code === "P0001") {
      throw new SetupError(
        "Setup is not ready, cannot be retried, or its generation limit was reached.",
        409,
      );
    }
    throw new Error("Website setup database operation failed");
  }
  return data;
}
export async function readSetup(
  db: SetupDb,
  userId: string,
  target: { social_account_id?: string; platform?: string; job_id?: string },
) {
  return await setupRpc(db, "read_ai_website_setup", {
    p_user_id: userId,
    p_social_account_id: target.social_account_id ?? null,
    p_platform: target.platform ?? null,
    p_job_id: target.job_id ?? null,
  }) as { jobs: SetupJob[]; config: ConfigSnapshot | null };
}
export async function applySetup(
  db: SetupDb,
  userId: string,
  input: {
    job_id: string;
    fields: string[];
    expected_config_updated_at: string | null;
  },
) {
  const snapshot = await readSetup(db, userId, { job_id: input.job_id });
  const job = snapshot.jobs.find((entry) => entry.id === input.job_id);
  if (job?.status === "applied") return { config: snapshot.config, job };
  if (!job || job.status !== "ready" || !job.result) {
    throw new SetupError("Setup draft is not ready.", 409);
  }
  if (
    (snapshot.config?.updated_at ?? null) !== input.expected_config_updated_at
  ) {
    throw new SetupError("Configuration changed. Reload before applying.", 409);
  }
  let merged;
  try {
    merged = mergeDraft(snapshot.config, job.result, input.fields);
  } catch {
    throw new SetupError("The selected setup fields are invalid.", 400);
  }
  const config = await setupRpc(db, "apply_ai_website_setup", {
    p_user_id: userId,
    p_job_id: input.job_id,
    p_expected_updated_at: snapshot.config?.updated_at ?? null,
    p_business_profile: merged.business_profile,
    p_agent_behavior: merged.agent_behavior,
    p_business_profile_text: merged.business_profile_text,
  });
  return { config, job };
}
