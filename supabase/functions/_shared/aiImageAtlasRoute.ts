/**
 * The AtlasCloud half of upscale-image and remove-background as HTTP behaviour: the hourly cap
 * on paid jobs, starting a job, answering 202 while it still runs, redeeming the follow-up
 * `prediction_id`, and writing a `system_logs` row for every refusal. The two functions differ
 * only in the model request and in the body they report, which they pass in as `AtlasRoute`.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonResponse } from "./cors.ts";
import { failTool, type ToolFailure } from "./aiImageFailure.ts";
import {
  abandonAtlasImageJob,
  resumeAtlasImageJob,
  startAtlasImageJob,
  TOKEN_MAX_AGE_MS,
  type AtlasJobBase,
  type AtlasJobDeps,
  type AtlasJobOutcome,
  type StartSpec,
} from "./aiImageJob.ts";
import { PROVIDER_UNAVAILABLE_CODE } from "./aiImageProviders.ts";
import { signJobToken, verifyJobToken, type JobTokenPayload } from "./aiImageToken.ts";
import { getOpeninaryConfig } from "./openinary.ts";
import { checkUserRateLimit } from "./rate-limiter.ts";

/** AtlasCloud jobs one caller may start per hour; each one is billed to the platform. */
export const ATLAS_JOBS_PER_HOUR = 30;

export type CompletedJob = Extract<AtlasJobOutcome, { ok: true; status: "completed" }>;
type ProcessingJob = Extract<AtlasJobOutcome, { ok: true; status: "processing" }>;

export interface AtlasRoute {
  /** The edge function name; also the `system_logs` source and the rate-limit key prefix. */
  source: string;
  operation: "upscale" | "background_removal";
  area: "upscaled" | "processed";
  failureCode: string;
  messages: AtlasJobBase["messages"];
  wantOutputDetails?: boolean;
  /** The 200 body for a finished job (`job.meta` carries what the start request put in the token). */
  completedBody: (job: CompletedJob) => Record<string, unknown>;
}

export interface RouteCaller {
  db: SupabaseClient;
  userId: string;
  /** Epoch ms when the request began; the time budget is measured from it. */
  startedAt: number;
}

export interface RouteEnv {
  atlasApiKey: string;
  /** Signs and verifies follow-up tokens. */
  secret: string;
}

export function readRouteEnv(): RouteEnv {
  return {
    atlasApiKey: Deno.env.get("ATLASCLOUD_API_KEY") ?? "",
    secret: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  };
}

function baseSpec(route: AtlasRoute, caller: RouteCaller, env: RouteEnv, meta: JobTokenPayload["meta"], area = route.area): AtlasJobBase {
  return {
    operation: route.operation,
    userId: caller.userId,
    openinary: getOpeninaryConfig(),
    atlasApiKey: env.atlasApiKey,
    area,
    startedAt: caller.startedAt,
    sign: (payload) => signJobToken(env.secret, caller.userId, payload),
    wantOutputDetails: route.wantOutputDetails,
    messages: route.messages,
    failureCode: route.failureCode,
    meta,
  };
}

function refuse(route: AtlasRoute, caller: RouteCaller, failure: ToolFailure): Promise<Response> {
  return failTool({ db: caller.db, source: route.source, operation: route.operation, userId: caller.userId }, failure);
}

function respond(route: AtlasRoute, caller: RouteCaller, outcome: AtlasJobOutcome): Promise<Response> | Response {
  if (!outcome.ok) return refuse(route, caller, outcome);
  if (outcome.status === "processing") return processingResponse(outcome);
  return jsonResponse({ status: "completed", ...route.completedBody(outcome) });
}

function processingResponse(job: ProcessingJob): Response {
  return jsonResponse({
    success: true,
    status: "processing",
    prediction_id: job.token,
    retry_after_seconds: job.retryAfterSeconds,
    platform: "atlascloud",
    ...job.meta,
  }, 202);
}

function notConfigured(route: AtlasRoute, caller: RouteCaller, reason: string): Promise<Response> {
  return refuse(route, caller, { status: 503, code: PROVIDER_UNAVAILABLE_CODE, message: route.messages.unavailable, reason, level: "error" });
}

/** Start a job: cap, submit, poll briefly, then a result (200) or a token to come back with (202). */
export async function startAtlasRoute(
  route: AtlasRoute,
  caller: RouteCaller,
  env: RouteEnv,
  request: { input: StartSpec["input"]; buildBody: StartSpec["buildBody"]; meta: JobTokenPayload["meta"] },
  deps?: AtlasJobDeps,
): Promise<Response> {
  if (!env.atlasApiKey) return notConfigured(route, caller, "atlascloud_not_configured");
  if (!env.secret) return notConfigured(route, caller, "token_secret_missing");

  // Each AtlasCloud job is paid by the platform account, so a caller is capped per hour.
  const rate = await checkUserRateLimit(caller.db, `${route.source}:atlascloud`, caller.userId, ATLAS_JOBS_PER_HOUR, 3600);
  if (!rate.allowed) {
    return refuse(route, caller, { status: 429, code: "RATE_LIMITED", message: "Too many image jobs this hour. Please try again later.", reason: "rate_limited", level: "warn" });
  }

  const outcome = await startAtlasImageJob({ ...baseSpec(route, caller, env, request.meta), input: request.input, buildBody: request.buildBody }, deps);
  return respond(route, caller, outcome);
}

/** Redeem a `prediction_id`: check once, and finish or fail the job, or say it is still running. */
export async function resumeAtlasRoute(
  route: AtlasRoute,
  caller: RouteCaller,
  env: RouteEnv,
  token: string,
  deps?: AtlasJobDeps,
): Promise<Response> {
  if (!env.atlasApiKey) return notConfigured(route, caller, "atlascloud_not_configured");
  if (!env.secret) return notConfigured(route, caller, "token_secret_missing");

  // A token for someone else's job, for the other tool, or a mangled one all look the same.
  const invalid = (reason: string) =>
    refuse(route, caller, { status: 400, code: "INVALID_PREDICTION", message: "Unknown or invalid prediction_id", reason, level: "warn" });

  const verified = await verifyJobToken({ secret: env.secret, userId: caller.userId, token, maxAgeMs: TOKEN_MAX_AGE_MS });
  if (!verified.ok && verified.reason !== "expired") return invalid(`token_${verified.reason}`);
  const payload = verified.payload;
  if (payload.operation !== route.operation) return invalid("token_wrong_operation");

  const spec = baseSpec(route, caller, env, payload.meta, payload.area);
  if (!verified.ok) {
    await abandonAtlasImageJob(spec, payload, deps);
    return refuse(route, caller, { status: 410, code: "PREDICTION_EXPIRED", message: "This job has expired. Start it again.", reason: "token_expired", level: "warn" });
  }
  return respond(route, caller, await resumeAtlasImageJob({ ...spec, token, payload }, deps));
}

export function invalidInput(route: AtlasRoute, caller: RouteCaller, status: number, message: string): Promise<Response> {
  return refuse(route, caller, { status, code: "INVALID_INPUT", message, reason: "invalid_input", level: "warn" });
}

export function providerUnavailable(route: AtlasRoute, caller: RouteCaller, message: string, reason: string): Promise<Response> {
  return refuse(route, caller, { status: 503, code: PROVIDER_UNAVAILABLE_CODE, message, reason, level: "error" });
}
