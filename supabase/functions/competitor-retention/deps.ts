/**
 * The infrastructure of the competitor retention function.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The single database call and the audit write. It turns the raw RPC
 *   answer into a typed slice, or into a typed failure. It builds no
 *   business rule and it decides nothing.
 *
 * WHY THE PARSING IS STRICT
 *
 *   A failed read must never look like an empty one. Every field of the
 *   batch answer is checked before it is believed: an unknown switch state,
 *   a missing flag, a count that is not a non-negative integer, a missing
 *   `has_more` and a missing `child_counts` are all refused, and a refused
 *   answer is a failure rather than a slice with zeroes in it.
 *
 * WHY THE DRY-RUN FLAG IS CHECKED TWICE
 *
 *   The database echoes the flag it was given. If the answer says "live"
 *   to a request that asked for a dry run, the two sides disagree about
 *   what was done, and neither the caller nor the audit may be told the
 *   answer. It is refused instead.
 *
 * WHY THE REQUEST HAS THREE ARGUMENTS
 *
 *   The parent limit, the child limit and the dry-run flag. There is no
 *   owner, no cutoff, no time and no id, so a caller cannot move the
 *   90-day boundary or target one owner's rows: the clock and the
 *   eligibility rule are the database's, alone.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logToDatabase } from "../_shared/logging.ts";
import type {
  CompetitorRetentionPorts,
  RetentionAuditEvent,
  RetentionBatchOutcome,
  RetentionBatchRequest,
  RetentionSlice,
  RetentionSwitchState,
} from "./run.ts";

/**
 * The two calls this module makes of the database client.
 *
 * The SDK's own `rpc` signature is generic over the schema's function map,
 * and against an untyped schema it infers an empty argument list. This
 * adapter needs exactly two calls, so it declares them and bridges the
 * SDK's client onto this narrow shape ONCE, at the boundary. Nothing else
 * in the function can reach the client.
 */
export interface RetentionDatabase {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: unknown }>;
  from(table: string): {
    insert(row: Record<string, unknown>): PromiseLike<{ error: unknown }>;
  };
}

/**
 * The service client. The service role is backend-only: it is never sent
 * to a browser, never logged and never echoed into a response.
 */
export function createServiceClient(): RetentionDatabase {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("the retention backend is unavailable");
  }
  return createClient(supabaseUrl, serviceRoleKey) as unknown as RetentionDatabase;
}

const SWITCH_STATES: readonly RetentionSwitchState[] = ["enabled", "disabled", "missing", "malformed"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A count is a non-negative integer. Nothing else is a count. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * The batch answer, or nothing. It never invents a default: a missing or
 * implausible field is a refused answer, not a zero.
 */
export function parseRetentionSlice(payload: unknown): RetentionSlice | null {
  if (!isPlainObject(payload)) return null;

  const switchState = payload.switch_state;
  if (typeof switchState !== "string") return null;
  if (!SWITCH_STATES.includes(switchState as RetentionSwitchState)) return null;

  if (typeof payload.dry_run !== "boolean") return null;
  if (typeof payload.has_more !== "boolean") return null;

  if (!isCount(payload.parents_considered)) return null;
  if (!isCount(payload.parents_deleted)) return null;
  if (!isCount(payload.parents_projected)) return null;
  if (!isCount(payload.parents_skipped_live_lease)) return null;
  if (!isCount(payload.parents_skipped_ineligible)) return null;
  if (!isCount(payload.children_counted)) return null;
  if (!isCount(payload.children_deleted)) return null;

  if (!isPlainObject(payload.child_counts)) return null;
  for (const value of Object.values(payload.child_counts)) {
    if (!isCount(value)) return null;
  }

  return {
    switchState: switchState as RetentionSwitchState,
    dryRun: payload.dry_run,
    parentsConsidered: payload.parents_considered,
    parentsDeleted: payload.parents_deleted,
    parentsProjected: payload.parents_projected,
    parentsSkippedLiveLease: payload.parents_skipped_live_lease,
    parentsSkippedIneligible: payload.parents_skipped_ineligible,
    childrenCounted: payload.children_counted,
    childrenDeleted: payload.children_deleted,
    hasMore: payload.has_more,
  };
}

/**
 * The ports of the retention run, bound to the database.
 *
 * The audit row carries counts and reasons only. `logToDatabase` runs the
 * metadata through the shared sensitive-data redactor, so nothing that
 * looks like a credential can leave this module even if a future field
 * were added carelessly.
 */
export function createCompetitorRetentionPorts(supabase: RetentionDatabase): CompetitorRetentionPorts {
  return {
    async runBatch(request: RetentionBatchRequest): Promise<RetentionBatchOutcome> {
      try {
        const { data, error } = await supabase.rpc("run_competitor_retention_batch", {
          p_parent_limit: request.parentLimit,
          p_child_limit: request.childLimit,
          p_dry_run: request.dryRun,
        });

        if (error) return { ok: false, reason: "rpc_failed" };

        const slice = parseRetentionSlice(data);
        if (!slice) return { ok: false, reason: "malformed_response" };
        if (slice.dryRun !== request.dryRun) {
          return { ok: false, reason: "malformed_response" };
        }
        return { ok: true, slice };
      } catch {
        return { ok: false, reason: "rpc_failed" };
      }
    },

    async logAudit(event: RetentionAuditEvent): Promise<void> {
      await logToDatabase(supabase, {
        level: event.outcome === "failed" ? "error" : event.outcome === "stopped" ? "warn" : "info",
        category: "system",
        source: "competitor-retention",
        message: "Competitor retention run finished",
        metadata: { ...event },
      });
    },
  };
}
