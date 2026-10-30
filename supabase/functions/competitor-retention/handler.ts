/**
 * The HTTP boundary of the competitor retention function.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The method contract, the body contract, the authorization call and the
 *   mapping of the run's outcome onto a response. It holds no business
 *   rule: the eligibility, the caps and the switch belong to the run and
 *   to the database.
 *
 * WHY THE CONTRACT IS STRICT
 *
 *   The only method that runs anything is POST, and the only body it
 *   accepts is `{ "dry_run": <boolean> }`. There is no owner, no cutoff, no
 *   time and no id: a client that supplies one of those is refused with a
 *   400 instead of being silently ignored, because a silently ignored
 *   argument is an argument the caller believes is in force.
 *
 * WHY THE METHOD IS CHECKED BEFORE THE AUTHORIZATION
 *
 *   A wrong method can never run the cleanup, so there is nothing to
 *   authorize. Refusing it first keeps the answer deterministic and keeps
 *   an authorization lookup off a request that could not have succeeded.
 *   The refusal is audited like every other exit.
 *
 * WHY THE CORS POLICY IS THE RESTRICTED ONE
 *
 *   This is a credentialed maintenance endpoint: it is reachable from the
 *   cron scheduler and from an administrator's browser, never from a public
 *   page. The restricted policy reflects the request's origin only when
 *   that origin is on the allow-list.
 *
 * WHY THE REFUSAL COMES FROM THE SHARED HELPER
 *
 *   The authority is the shared cron/service/admin policy, not a local
 *   convention: an anonymous caller and an ordinary user are refused by
 *   the same code every other maintenance endpoint uses.
 */
import { z } from "npm:zod@3.23.8";
import { verifyCronOrAdmin } from "../_shared/cron-auth.ts";
import { restrictedCorsHeaders } from "../_shared/cors.ts";
import { sanitizeErrorMessage } from "../_shared/errorSanitizer.ts";
import { logToDatabase } from "../_shared/logging.ts";
import { createCompetitorRetentionPorts, createServiceClient } from "./deps.ts";
import { runCompetitorRetention, type CompetitorRetentionPorts, type CompetitorRetentionReport } from "./run.ts";

/**
 * The body ceiling. The only accepted body is eighteen bytes long; a
 * larger one is refused before it is parsed, so an oversized request
 * cannot make this function allocate.
 */
export const RETENTION_MAX_BODY_BYTES = 1024;

/**
 * The request body. `strict` refuses an unknown key, and the flag is
 * required: an absent body is not a decision to run a live cleanup.
 */
const RequestBodySchema = z.object({
  dry_run: z.boolean(),
}).strict();

export interface CompetitorRetentionHandlerDeps {
  ports?: CompetitorRetentionPorts;
  /**
   * The client the refusal and rejection audits are written with. It is
   * `unknown` on purpose: this module only hands it to the shared logger,
   * which takes whatever the platform's client is, and a test double must
   * not have to impersonate the whole SDK.
   */
  adminClient?: unknown;
}

/**
 * The preflight.
 *
 * The shared restricted policy advertises GET as well, because other
 * endpoints on it accept GET. This one does not: it runs a cleanup, so the
 * advertised methods are narrowed to the two that are real. The origin
 * policy is the shared one and is not touched.
 */
function preflight(req: Request): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...restrictedCorsHeaders(req),
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
  });
}

type BodyRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "body_too_large" };

function json(
  req: Request,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...restrictedCorsHeaders(req),
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

/**
 * Reads the body under a hard ceiling. The declared length is checked
 * first because it is free, and the read itself is bounded because the
 * declared length is a claim, not a fact.
 */
async function readBody(req: Request): Promise<BodyRead> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > RETENTION_MAX_BODY_BYTES) {
      return { ok: false, reason: "body_too_large" };
    }
  }

  if (!req.body) return { ok: true, text: "" };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > RETENTION_MAX_BODY_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // The stream is already gone; the refusal stands either way.
      }
      return { ok: false, reason: "body_too_large" };
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
}

/**
 * The audit of a refusal or a rejection. Best effort and bounded: a log
 * table that is unavailable must never change what the caller is told.
 */
async function writeAuditRow(
  deps: CompetitorRetentionHandlerDeps | undefined,
  entry: {
    level: "warn";
    category: "auth" | "system";
    message: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const admin = deps?.adminClient ?? createServiceClient();
    await logToDatabase(admin, {
      level: entry.level,
      category: entry.category,
      source: "competitor-retention",
      message: entry.message,
      metadata: entry.metadata,
    });
  } catch {
    console.error("[competitor-retention] the audit write failed");
  }
}

/**
 * The wire shape of the run. Counts and reasons only.
 *
 * The skipped counters are reported because they answer the only question
 * an operator really has when the backlog does not drain: how many parents
 * were held back by a live lease, and how many had become ineligible.
 */
function toWire(report: CompetitorRetentionReport): Record<string, unknown> {
  return {
    dry_run: report.dryRun,
    slices: report.slices,
    parents_processed: report.parentsProcessed,
    parents_deleted: report.parentsDeleted,
    parents_projected: report.parentsProjected,
    parents_skipped_live_lease: report.parentsSkippedLiveLease,
    parents_skipped_ineligible: report.parentsSkippedIneligible,
    children_counted: report.childrenCounted,
    children_deleted: report.childrenDeleted,
    has_more: report.hasMore,
    switch_state: report.switchState,
    stop_reason: report.stopReason,
    failed: report.failed,
  };
}

export async function handleCompetitorRetentionRequest(
  req: Request,
  deps?: CompetitorRetentionHandlerDeps,
): Promise<Response> {
  if (req.method === "OPTIONS") return preflight(req);

  if (req.method !== "POST") {
    await writeAuditRow(deps, {
      level: "warn",
      category: "system",
      message: "Competitor retention request rejected",
      metadata: { reason: "method_not_allowed" },
    });
    return json(req, 405, { error: "Method not allowed" }, { Allow: "POST, OPTIONS" });
  }

  const auth = await verifyCronOrAdmin(req);
  if (!auth.ok) {
    await writeAuditRow(deps, {
      level: "warn",
      category: "auth",
      message: "Competitor retention request refused",
      metadata: { reason: "unauthorized" },
    });
    return auth.response;
  }

  const body = await readBody(req);
  if (!body.ok) {
    await writeAuditRow(deps, {
      level: "warn",
      category: "system",
      message: "Competitor retention request rejected",
      metadata: { reason: body.reason },
    });
    return json(req, 400, { error: "Invalid request" });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    await writeAuditRow(deps, {
      level: "warn",
      category: "system",
      message: "Competitor retention request rejected",
      metadata: { reason: "invalid_json" },
    });
    return json(req, 400, { error: "Invalid request" });
  }

  const validated = RequestBodySchema.safeParse(parsed);
  if (!validated.success) {
    await writeAuditRow(deps, {
      level: "warn",
      category: "system",
      message: "Competitor retention request rejected",
      metadata: { reason: "invalid_body" },
    });
    return json(req, 400, { error: "Invalid request" });
  }

  try {
    const ports = deps?.ports ?? createCompetitorRetentionPorts(createServiceClient());
    const report = await runCompetitorRetention({ dryRun: validated.data.dry_run, ports });

    if (report.failed) {
      // The truthful counts of the slices that did finish travel with the
      // failure: a partial run is progress, and hiding it would be a lie.
      return json(req, 500, { error: "The retention run failed", ...toWire(report) });
    }
    return json(req, 200, toWire(report));
  } catch (error) {
    console.error("[competitor-retention] the run failed");
    return json(req, 500, { error: sanitizeErrorMessage(error) });
  }
}
