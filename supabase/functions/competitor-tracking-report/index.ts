/**
 * The composition root of `competitor-tracking-report`.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The client, the environment and the wiring. It builds the caller-scoped
 *   client, hands the handler its narrow ports and registers the route. It
 *   holds no business rule and no validation.
 *
 * WHY THE READ RUNS AS THE CALLER
 *
 *   `read_own_competitor_tracking_report` is granted to `authenticated` and
 *   explicitly revoked from the service role: it derives the owner from
 *   `auth.uid()`, and a service-role call would have no user to scope to.
 *
 *   The client is therefore built PER REQUEST from the PUBLIC project key
 *   and the SAME bearer that was verified, so the token that was checked is
 *   the token that runs the statement. Nothing is cached between requests:
 *   there is no module-level client, no module-level token and no per-user
 *   state.
 *
 *   THERE IS NO SERVICE-ROLE CLIENT HERE. The service-role key is read for
 *   ONE purpose only: to recognise a service credential and REFUSE it. It
 *   never authenticates a database call, and it never reaches the reader.
 *
 * WHY THE BASELINE POLICY IS INJECTED
 *
 *   The approved maximum staleness of a follower baseline (spec §11: S = 3
 *   days) is a SERVER constant. It is injected here, from the module that
 *   owns it, and it never comes from the request.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { authenticateCaller, timingSafeTokenEqual } from "../_shared/auth-helper.ts";

import { assembleCompetitorReport } from "./assemble.ts";
import { createCompetitorTrackingReportHandler } from "./handler.ts";
import { COMPETITOR_REPORT_BASELINE_POLICY } from "./growth.ts";
import { CompetitorReportStore } from "./reportStore.ts";

interface ServerEnvironment {
  readonly url: string;
  readonly anonKey: string;
}

/**
 * Reads the server-controlled configuration.
 *
 * A missing value is a missing value: the deployment is not usable and the
 * endpoint refuses. The configuration is never printed, never logged and
 * never echoed into a response.
 */
function currentEnvironment(): ServerEnvironment | null {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

/**
 * The caller-scoped RPC caller.
 *
 * The public key is the apikey; the caller's own bearer is the Authorization
 * header. PostgREST takes the role from that bearer, so PostgreSQL derives
 * the owner from `auth.uid()`.
 */
function createUserRpcCaller(
  environment: ServerEnvironment,
): (
  functionName: string,
  args: Record<string, unknown>,
  verifiedBearer: string,
) => Promise<unknown> {
  return async (functionName, args, verifiedBearer) => {
    const client = createClient(environment.url, environment.anonKey, {
      global: {
        headers: { Authorization: `Bearer ${verifiedBearer}` },
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          fetch(input, { ...init, signal: init?.signal }),
      },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    // The raw driver envelope, returned whole. Destructuring it would turn a
    // missing error into an own null, which is the completed-call signal.
    return await client.rpc(functionName, args);
  };
}

export const handler = createCompetitorTrackingReportHandler({
  authenticate: async (req: Request) => {
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (serviceRoleKey) {
      const header = req.headers.get("Authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
      if (token && timingSafeTokenEqual(token, serviceRoleKey)) {
        // A service credential is recognised so it can be REFUSED with a
        // clear reason. It is never used to read anything.
        return { userId: "", isServiceRole: true };
      }
    }

    // The shared authentication helper. It resolves the identity from the
    // Authorization header and NEVER from the request body.
    const identity = await authenticateCaller(req);
    return { userId: identity.userId, isServiceRole: identity.isServiceRole };
  },

  readReport: async (request, verifiedBearer, now) => {
    const environment = currentEnvironment();
    if (!environment) {
      throw new Error("the competitor tracking report is not configured");
    }

    const store = new CompetitorReportStore(createUserRpcCaller(environment));
    const raw = await store.readReportInput(request, verifiedBearer);

    return assembleCompetitorReport(
      { action: request.action, request, raw },
      now,
      COMPETITOR_REPORT_BASELINE_POLICY,
    );
  },
});

Deno.serve((request: Request) => handler(request));
