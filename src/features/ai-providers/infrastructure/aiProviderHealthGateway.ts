import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";

/**
 * The provider health gateway. It talks to the `ai-provider-health` edge function,
 * which is the only thing that tests a provider and syncs its catalogue.
 *
 * The responses are validated at this boundary, so a contract drift fails here with
 * one stable code instead of deep inside a component.
 */
export type ProviderHealthStatus = "connected" | "failed" | "needs_relogin";

const healthRowSchema = z.object({
  provider_code: z.string(),
  auth_method: z.enum(["api_key", "oauth"]),
  display_name: z.string().default(""),
  status: z.enum(["connected", "failed", "needs_relogin"]),
  reason: z.string().nullable().default(null),
  models_added: z.number().nullable().default(null),
  models_updated: z.number().nullable().default(null),
  models_deactivated: z.number().nullable().default(null),
  latency_ms: z.number().nullable().default(null),
  checked_at: z.string().default(""),
});

const summarySchema = z.object({
  total: z.number().default(0),
  connected: z.number().default(0),
  failed: z.number().default(0),
  needs_relogin: z.number().default(0),
});

const resultsSchema = z.object({ results: z.array(healthRowSchema).default([]) });

const chunkSchema = z.object({
  run_id: z.string().default(""),
  chunk: z.number().default(1),
  done: z.boolean().default(true),
  next_chunk: z.number().nullable().default(null),
  results: z.array(healthRowSchema).default([]),
  summary: summarySchema.default({ total: 0, connected: 0, failed: 0, needs_relogin: 0 }),
});

export type ProviderHealthRow = z.infer<typeof healthRowSchema>;
export type ProviderHealthChunk = z.infer<typeof chunkSchema>;

export const INVALID_RESPONSE = "AI_PROVIDER_HEALTH_INVALID_RESPONSE";

/**
 * The function answers a refusal with `{ error: "<stable code>" }` — "busy" when the
 * daily check already holds the lease. supabase-js hands a non-2xx status back as a
 * generic FunctionsHttpError, so the code is read out of the envelope.
 */
function envelopeError(data: unknown): string | null {
  const envelope = (data ?? {}) as { error?: unknown };
  return typeof envelope.error === "string" && envelope.error.length > 0 ? envelope.error : null;
}

/** The stored results of the last run, one row per provider and credential kind. */
export async function fetchProviderHealth(): Promise<ProviderHealthRow[]> {
  const { data, error } = await supabase.functions.invoke("ai-provider-health", { body: { action: "status" } });
  if (error) throw error;
  const code = envelopeError(data);
  if (code) throw new Error(code);
  const parsed = resultsSchema.safeParse(data);
  if (!parsed.success) throw new Error(INVALID_RESPONSE);
  return parsed.data.results;
}

/**
 * Runs one chunk of the check. The caller walks the chunks until the answer says it
 * is done; the run token is the same for every chunk of one run, so the server keeps
 * one run id and one lease for the whole click.
 */
export async function runProviderHealthChunk(chunk: number, runToken: string): Promise<ProviderHealthChunk> {
  const { data, error } = await supabase.functions.invoke("ai-provider-health", {
    body: { action: "run", scope: "manual", chunk, run_token: runToken },
  });
  if (error) throw error;
  const code = envelopeError(data);
  if (code) throw new Error(code);
  const parsed = chunkSchema.safeParse(data);
  if (!parsed.success) throw new Error(INVALID_RESPONSE);
  return parsed.data;
}
