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

import { z } from "npm:zod@3.23.8";
import { restrictedJsonResponse } from "../_shared/cors.ts";
import { deriveRunId, type HealthResult } from "../_shared/aiProviderHealth.ts";
import type { HealthChunkResponse } from "./run.ts";

const LEASE_JOB = "ai-provider-health";
/**
 * The lease is released when the chunk ends, so the TTL only has to outlive a
 * chunk. It is short on purpose: a platform kill skips the release, and a lease
 * that then lasts fifteen minutes would lock the daily run out of its own window.
 * Two minutes is well above the 40 second budget of a chunk.
 */
const LEASE_TTL_SECONDS = 120;

export interface HealthHandlerPorts {
  runChunk(chunk: number, runId: string): Promise<HealthChunkResponse>;
  readResults(): Promise<HealthResult[]>;
  acquireLease(job: string, holder: string, ttlSeconds: number): Promise<boolean>;
  releaseLease(job: string, holder: string): Promise<boolean>;
  isAuthorized(req: Request): Promise<{ ok: true } | { ok: false; response: Response }>;
}

/**
 * The request body. Every field is optional: an empty body is a status request.
 * The shape is parsed, not cast, so a body that says something else is ignored
 * instead of reaching the runner. A field with the wrong type falls back to its
 * default instead of failing the whole body.
 */
const healthRequestSchema = z.object({
  action: z.enum(["run", "status"]).catch("status").optional(),
  chunk: z.union([z.number(), z.string()]).catch(1).optional(),
  scope: z.enum(["daily", "manual"]).catch("manual").optional(),
  run_token: z.string().catch("").optional(),
});

export function parseHealthRequest(body: unknown): {
  action: "run" | "status";
  chunk: number;
  scope: "daily" | "manual";
  runToken: string | null;
} {
  const parsed = healthRequestSchema.safeParse(body ?? {});
  const raw = parsed.success ? parsed.data : {};
  const action = raw.action === "run" ? "run" : "status";
  const chunkValue = typeof raw.chunk === "string" ? Number(raw.chunk) : raw.chunk;
  const chunk = Number.isFinite(chunkValue) ? Math.max(1, Math.floor(Number(chunkValue))) : 1;
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
  try {
    return await routeHealthRequest(req, ports);
  } catch (error) {
    // The edge function must answer with a status, not with a stack trace. The
    // reason never leaves the server: only the name of the failure is logged.
    console.error("event: 'ai_provider_health_request_failed'", error instanceof Error ? error.name : "error");
    return restrictedJsonResponse(req, { error: "The provider health check failed" }, 500);
  }
}

async function routeHealthRequest(req: Request, ports: HealthHandlerPorts): Promise<Response> {
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
  // A lease permits its holder to renew it. Each request needs a distinct holder,
  // otherwise two concurrent retries of the same run could both acquire it.
  const holder = crypto.randomUUID();
  const acquired = await ports.acquireLease(LEASE_JOB, holder, LEASE_TTL_SECONDS);
  if (!acquired) {
    return restrictedJsonResponse(req, { error: "busy" }, 409);
  }
  try {
    const result = await ports.runChunk(parsed.chunk, runId);
    return restrictedJsonResponse(req, result, 200);
  } finally {
    try {
      await ports.releaseLease(LEASE_JOB, holder);
    } catch (error) {
      // The lease has a short TTL, so a release that fails is not worth losing the
      // response over: the chunk's answer is the answer.
      console.error("event: 'ai_provider_health_lease_release_failed'", error instanceof Error ? error.name : "error");
    }
  }
}
