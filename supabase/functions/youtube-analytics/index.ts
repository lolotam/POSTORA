import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { timingSafeTokenEqual } from "../_shared/auth-helper.ts";
import { refreshYouTubeAccountToken } from "../_shared/youtubeTokenRefresh.ts";
import { createYouTubeAnalyticsReadClient } from "./analyticsReadClient.ts";
import { createYouTubeAnalyticsAudit } from "./audit.ts";
import { recordYouTubeAnalyticsConsent } from "./consent.ts";
import { createBoundYouTubeAnalyticsRefreshStore } from "./credentials.ts";
import { decideYouTubeAnalytics, type YouTubeAnalyticsRpcRunner } from "./decision.ts";
import { createYouTubeAnalyticsHandler, type YouTubeAnalyticsPorts } from "./handler.ts";
import { checkAdmissionLimit, checkDataLimit, debitSharedBudget } from "./limits.ts";

const DB_REQUEST_TIMEOUT_MS = 8_000;

function fetchWithDeadline(input: Request | URL | string, init?: RequestInit): Promise<Response> {
  const deadline = AbortSignal.timeout(DB_REQUEST_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  return fetch(input, { ...init, signal });
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const admin = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  { global: { fetch: fetchWithDeadline } },
);
const rpc: YouTubeAnalyticsRpcRunner = (fn, args) => admin.rpc(fn, args);

async function authenticateWithDeadline(req: Request): Promise<{ userId: string }> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Missing or invalid Authorization header");
  }
  const token = authHeader.replace("Bearer ", "");
  if (SUPABASE_SERVICE_ROLE_KEY && timingSafeTokenEqual(token, SUPABASE_SERVICE_ROLE_KEY)) {
    throw new Error("Service-role bearer is not permitted on youtube-analytics");
  }
  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader }, fetch: fetchWithDeadline },
  });
  const { data: claimsData, error } = await authClient.auth.getClaims(token);
  const sub = claimsData?.claims?.sub;
  if (error || typeof sub !== "string" || sub.length === 0) {
    throw new Error("Unauthorized: invalid or expired token");
  }
  return { userId: sub };
}

const ports: YouTubeAnalyticsPorts = {
  auth: {
    authenticate: authenticateWithDeadline,
  },
  clock: { now: () => new Date() },
  ids: { requestId: () => crypto.randomUUID() },
  decide: (input) => decideYouTubeAnalytics(rpc, input),
  limits: {
    admission: (userId) => checkAdmissionLimit(rpc, userId),
    data: (userId) => checkDataLimit(rpc, userId),
    debit: (kind, now) => debitSharedBudget(rpc, kind, now),
  },
  tokens: {
    bind(binding) {
      const store = createBoundYouTubeAnalyticsRefreshStore({ rpc, binding });
      return {
        get lastDenial() {
          return store.lastDenial;
        },
        get: (snapshot, force) => refreshYouTubeAccountToken({
          accountId: binding.accountId,
          snapshot,
          force,
          healthNeutral: true,
          recordTransientFailure: false,
          store,
          fetchImpl: fetch,
        }),
      };
    },
  },
  reader: createYouTubeAnalyticsReadClient({ fetchImpl: fetch }),
  consent: {
    record: (input) => recordYouTubeAnalyticsConsent(rpc, input),
  },
  audit: createYouTubeAnalyticsAudit({
    rpc,
    insert: (row) => admin.from("system_logs").insert(row),
  }),
};

Deno.serve(createYouTubeAnalyticsHandler(ports));
