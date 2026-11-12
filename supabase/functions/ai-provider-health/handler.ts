// The request handler: one door for the admin button and the daily cron job.
//
// WHY one door
// The browser and pg_cron must reach the same runner, with the same rules and the same
// lease. Two endpoints would be two places to keep in step.
//
// WHY a lease
// The four daily cron entries and a manual click must never overlap: two runs would
// probe the same providers twice and could both sync the same catalogue. The lease
// is shared, so a click during the daily window is told the check is running.

import { restrictedJsonResponse } from "../_shared/cors.ts";
import { deriveRunId, type HealthResult } from "../_shared/aiProviderHealth.ts";
import type { HealthChunkResponse } from "./run.ts";

const LEASE_JOB = "ai-provider-health";
const LEASE_TTL_SECONDS = 15 * 60;

export interface HealthHandlerPorts {
  runChunk(chunk: number, runId: string, scope: "daily" | "manual"): Promise<HealthChunkResponse>;
  readResults(): Promise<HealthResult[]>;
  acquireLease(job: string, holder: string, ttlSeconds: number): Promise<boolean>;
  releaseLease(job: string, holder: string): Promise<boolean>;
  isAuthorized(req: Request): Promise<{ ok: true } | { ok: false; response: Response }>;
}

export function parseHealthRequest(body: unknown): {
  action: "run" | "status";
  chunk: number;
  scope: "daily" | "manual";
  runToken: string | null;
} {
  const raw = (body ?? {}) as { action?: unknown; chunk?: unknown; scope?: unknown; run_token?: unknown };
  const action = raw.action === "run" ? "run" : "status";
  const chunk = Number.isFinite(raw.chunk) ? Math.max(1, Math.floor(Number(raw.chunk))) : 1;
  const scope = raw.scope === "daily" ? "daily" : "manual";
  const runToken = typeof raw.run_token === "string" && raw.run_token ? raw.run_token : null;
  return { action, chunk, scope, runToken };
}

/** A body that is not JSON is an empty body, not a crash. */
async function safeJson(req: Request): Promise<unknown> {
  try {
    const text = await req.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export async function handleHealthRequest(req: Request, ports: HealthHandlerPorts): Promise<Response> {
  const auth = await ports.isAuthorized(req);
  if (!auth.ok) return auth.response;

  const body = req.method === "POST" ? await safeJson(req) : null;
  const parsed = parseHealthRequest(body ?? (req.method === "GET" ? { action: "status" } : {}));

  if (parsed.action === "status") {
    const results = await ports.readResults();
    return restrictedJsonResponse(req, { results }, 200);
  }

  // A manual run needs the browser's token: it is the run id, and without it two clicks
  // would share one lease and one run id.
  if (parsed.scope === "manual" && !parsed.runToken) {
    return restrictedJsonResponse(req, { error: "run_token is required" }, 400);
  }

  const runId = deriveRunId(parsed.scope, parsed.runToken ?? "cron", new Date());
  // WHY the holder is the run id: the four daily cron entries of one day share the daily
  // run id, so each of them extends the same lease instead of failing to take it. A
  // manual click has its own run id, so it either takes the lease (when free) or is
  // told the check is running.
  const holder = runId;
  const acquired = await ports.acquireLease(LEASE_JOB, holder, LEASE_TTL_SECONDS);
  if (!acquired) {
    return restrictedJsonResponse(req, { error: "busy" }, 409);
  }
  try {
    const result = await ports.runChunk(parsed.chunk, runId, parsed.scope);
    return restrictedJsonResponse(req, result, 200);
  } finally {
    await ports.releaseLease(LEASE_JOB, holder);
  }
}
