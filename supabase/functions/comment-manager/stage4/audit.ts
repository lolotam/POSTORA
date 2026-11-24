// Refusal audit for Stage 4.
//
// Every refusal writes ONE redacted row to `public.system_logs`. The level is
// `warn`, the category is `edge`, the source is `comment-manager`, and the
// metadata carries ONLY `action` (or `unknown` when it is not one of the known
// action names), `reason`, `provider_class` and `request_id`.
//
// Unauthenticated refusals are rate-bounded: at most 30 rows per minute for the
// whole function. Beyond that, a single counter row per minute records how many
// were suppressed, and each suppressed refusal still emits a sanitised console
// event. An anonymous caller cannot grow the table without bound, and silence
// never occurs.
//
// Never logged: comment text, author names, headers, IP-derived identifiers,
// credentials, cursors, handles, confirmation tokens, digest keys, provider
// bodies, or any identifier supplied by a caller that has not been verified.
// `user_id` is set only once the caller is identified. `account_id` and
// `operation_id` are added only after they are verified against that owner.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { STAGE4_ACTIONS, type Stage4Reason } from "./contracts.ts";

export interface Stage4AuditRow {
  action: string;
  reason: Stage4Reason | string;
  providerClass?: string | null;
  requestId: string;
  userId?: string | null;
  accountId?: string | null;
  operationId?: string | null;
}

// Built from the canonical action list, so a new action is audited by name
// the moment it is routed.
const KNOWN_ACTIONS = new Set<string>(STAGE4_ACTIONS);

/** In-memory tally of suppressed anonymous refusals since the last counter row. */
let anonAuditSuppressedCount = 0;

export function sanitiseAction(action: unknown): string {
  return typeof action === "string" && KNOWN_ACTIONS.has(action) ? action : "unknown";
}

export async function writeRefusalAudit(
  admin: SupabaseClient,
  row: Stage4AuditRow,
  opts: {
    rateLimitBucket: () => Promise<boolean>;
    /**
     * Called at most once a minute with the suppression count since the last
     * counter row. Resolves true only when that count was durably recorded, so
     * a throttled or failed write keeps the tally for the next attempt.
     */
    counterSink?: (suppressed: number) => Promise<boolean>;
  },
): Promise<void> {
  const action = sanitiseAction(row.action);
  const metadata: Record<string, unknown> = {
    action,
    reason: String(row.reason ?? "unknown"),
    provider_class: row.providerClass ?? null,
    request_id: String(row.requestId ?? ""),
  };
  if (row.accountId) metadata.account_id = row.accountId;
  if (row.operationId) metadata.operation_id = row.operationId;

  const userId = row.userId ?? null;

  // Anonymous bucket. A single counter row per minute records how many were
  // suppressed; each suppressed refusal still emits a sanitised console event.
  if (!userId) {
    let admitted = false;
    try {
      admitted = await opts.rateLimitBucket();
    } catch {
      admitted = false;
    }
    if (!admitted) {
      anonAuditSuppressedCount += 1;
      console.warn(
        `comment-manager stage4 refusal suppressed: action=${action} reason=${row.reason} request_id=${row.requestId}`,
      );
      // The counter row is the durable trace of the suppression volume; the
      // in-memory count carries the tally between counter rows.
      if (opts.counterSink) {
        // Only the snapshot that was recorded is subtracted: refusals that
        // arrive while the write is pending stay in the tally.
        const snapshot = anonAuditSuppressedCount;
        try {
          if (await opts.counterSink(snapshot)) {
            anonAuditSuppressedCount = Math.max(0, anonAuditSuppressedCount - snapshot);
          }
        } catch {
          // Never let the counter change anything about the refusal.
        }
      }
      return;
    }
  }

  try {
    // supabase-js returns `{ error }` rather than throwing; read it.
    const result = await admin.from("system_logs").insert({
      level: "warn",
      category: "edge",
      source: "comment-manager",
      message: "Stage 4 refusal",
      user_id: userId,
      metadata,
    });
    if (result && result.error) {
      console.warn(
        `comment-manager stage4 audit insert failed: action=${action} reason=${row.reason} request_id=${row.requestId} cause=insert_error`,
      );
    }
  } catch {
    // A failed insert must not change the response, and the exception text
    // (which can carry request or database details) is never logged.
    console.warn(
      `comment-manager stage4 audit insert failed: action=${action} reason=${row.reason} request_id=${row.requestId} cause=exception`,
    );
  }
}
