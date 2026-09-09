/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Nightly rebuild of every user's knowledge-graph export.
 *
 * An export is a snapshot written only when someone asks for it, so it goes
 * stale the moment anything is indexed and it never repairs itself. This runs
 * after the 03:15 orphan-entity prune so the published graph reflects the
 * post-prune entity set rather than being invalidated half an hour later.
 *
 * Which users are due is decided by dueUsers.ts from the data alone. Nothing is
 * queued and nothing is marked, so a run that is cut short by the worker
 * timeout loses no work: tomorrow's run re-derives the same answer.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { verifyCronAuth } from "../_shared/cron-auth.ts";
import { createGraphExports } from "../ai-knowledge-ingest/graphExports.ts";
import {
  refreshReasonFor,
  type GraphActivity,
  type PublishedExport,
  type RefreshReason,
} from "./dueUsers.ts";

/**
 * The edge worker is killed at 60 seconds with no chance to report. Stop
 * *starting* users well before that: one user costs two reads, a zip build and
 * two uploads, and the upload has its own 120s timeout, so a user started at 45s
 * can still overrun. Anything not reached is due again tomorrow.
 */
const START_NO_USER_AFTER_MS = 45_000;

/** A second bound, on work rather than time, so one slow night cannot queue up
 *  an unbounded run when the corpus grows. */
const MAX_USERS_PER_RUN = 25;

interface ActivityRow {
  user_id: string;
  email: string | null;
  entity_count: number;
  relation_count: number;
  newest_activity: string | null;
}

interface ExportRow {
  user_id: string;
  html_url: string | null;
  vault_url: string | null;
  generated_at: string | null;
  entity_count: number | null;
  relation_count: number | null;
}

interface RefreshOutcome {
  userId: string;
  reason: RefreshReason;
  ok: boolean;
  error?: string;
}

function toActivity(row: ActivityRow): GraphActivity {
  return {
    userId: row.user_id,
    entityCount: Number(row.entity_count) || 0,
    relationCount: Number(row.relation_count) || 0,
    newestActivity: row.newest_activity,
  };
}

function toPublished(row: ExportRow): PublishedExport {
  return {
    htmlUrl: row.html_url,
    vaultUrl: row.vault_url,
    generatedAt: row.generated_at,
    entityCount: row.entity_count,
    relationCount: row.relation_count,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The email for a user the rollup did not cover. Returns null rather than
 * throwing: a rebuild under the id-named folder is a worse outcome than one
 * skipped user, and the caller decides.
 */
async function lookUpEmail(admin: any, userId: string): Promise<string | null> {
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error) {
    console.warn(`[graph-refresh] email lookup failed for ${userId}:`, error.message);
    return null;
  }
  return data?.user?.email ?? null;
}

async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const auth = verifyCronAuth(req);
  if (!auth.ok) return auth.response;

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // One rollup read rather than a pair of counts per user. The function also
  // carries the email, which names the storage folder, so nothing here has to
  // walk auth.users per user.
  const { data: activityRows, error: activityError } = await (admin as any)
    .rpc("ai_knowledge_graph_activity");
  if (activityError) {
    console.error("[graph-refresh] activity rollup failed:", activityError.message);
    return jsonResponse({ ok: false, error: "activity rollup failed" }, 503);
  }

  const { data: exportRows, error: exportError } = await (admin as any)
    .from("ai_knowledge_graph_exports")
    .select("user_id, html_url, vault_url, generated_at, entity_count, relation_count");
  if (exportError) {
    console.error("[graph-refresh] export read failed:", exportError.message);
    return jsonResponse({ ok: false, error: "export read failed" }, 503);
  }

  const published = new Map<string, PublishedExport>(
    ((exportRows ?? []) as ExportRow[]).map((row) => [row.user_id, toPublished(row)]),
  );

  // The rollup only returns users who still have an entity or a relation. A user
  // who has since deleted everything -- or whose entities the 03:15 prune
  // removed, which is what happens when extraction produced no relations between
  // them -- would never be looked at, and their graph of deleted data would stay
  // on a public URL forever. So the due list is the union of both sides, and an
  // absent activity row means a graph that is now empty.
  const activity = new Map<string, ActivityRow>(
    ((activityRows ?? []) as ActivityRow[]).map((row) => [row.user_id, row]),
  );
  const emptied: ActivityRow = {
    user_id: "",
    email: null,
    entity_count: 0,
    relation_count: 0,
    newest_activity: null,
  };

  const due: Array<{ row: ActivityRow; reason: RefreshReason }> = [];
  for (const userId of new Set([...activity.keys(), ...published.keys()])) {
    const row = activity.get(userId) ?? { ...emptied, user_id: userId };
    const reason = refreshReasonFor(toActivity(row), published.get(userId) ?? null);
    if (reason) due.push({ row, reason });
  }

  const startedAt = Date.now();
  const outcomes: RefreshOutcome[] = [];
  let deferred = 0;

  for (const { row, reason } of due) {
    if (outcomes.length >= MAX_USERS_PER_RUN || Date.now() - startedAt > START_NO_USER_AFTER_MS) {
      deferred = due.length - outcomes.length;
      break;
    }
    try {
      // The email names the per-account folder, so getting it wrong writes the
      // rebuilt graph beside the old one instead of over it. The rollup omits it
      // for a user with nothing left, which is exactly the case that most needs
      // to overwrite, so look it up rather than falling back to the id.
      const email = row.email || await lookUpEmail(admin, row.user_id);
      await createGraphExports(admin, row.user_id, email || row.user_id);
      outcomes.push({ userId: row.user_id, reason, ok: true });
    } catch (error) {
      // One user's failure must not end the run: the rest are independent, and
      // a failed user is simply still due tomorrow.
      console.error(`[graph-refresh] ${row.user_id} (${reason}) failed:`, message(error));
      outcomes.push({ userId: row.user_id, reason, ok: false, error: message(error).slice(0, 200) });
    }
  }

  const refreshed = outcomes.filter((outcome) => outcome.ok).length;
  const failed = outcomes.length - refreshed;
  console.log(
    `[graph-refresh] due ${due.length}, refreshed ${refreshed}, failed ${failed}, deferred ${deferred}`,
  );
  return jsonResponse({ ok: true, due: due.length, refreshed, failed, deferred, outcomes });
}

Deno.serve(handleRequest);
