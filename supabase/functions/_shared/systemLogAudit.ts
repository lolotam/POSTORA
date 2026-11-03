import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { redactSensitive, type LogEntry } from "./logging.ts";

/** Anonymous refusals share a bounded time slot; authenticated events remain individual. */
export async function recordSystemAudit(input: {
  client: Pick<SupabaseClient, "from">; entry: LogEntry; signal: AbortSignal; refusalKey?: string;
}): Promise<boolean> {
  const row = { ...input.entry, metadata: redactSensitive(input.entry.metadata ?? {}) };
  if (input.refusalKey === undefined) {
    const receipt = await input.client.from("system_logs").insert(row).abortSignal(input.signal);
    return receipt.error === null;
  }
  const minute = Math.floor(Date.now() / 60_000);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`public-refusal:${input.refusalKey}:${minute}`));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  // Ignore duplicate slots atomically across isolates, rather than updating a
  // hot row or retaining one new row for every unauthenticated request.
  const receipt = await input.client.from("system_logs").upsert({ ...row, id,
    created_at: new Date(minute * 60_000).toISOString(),
    metadata: redactSensitive({ ...input.entry.metadata, coalesced: true }),
  }, { onConflict: "id", ignoreDuplicates: true }).abortSignal(input.signal);
  return receipt.error === null;
}
