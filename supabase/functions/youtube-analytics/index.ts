import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authenticateCaller } from "../_shared/auth-helper.ts";
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

const admin = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { global: { fetch: fetchWithDeadline } },
);
const rpc: YouTubeAnalyticsRpcRunner = (fn, args) => admin.rpc(fn, args);

const ports: YouTubeAnalyticsPorts = {
  auth: {
    authenticate: async (req) => ({ userId: (await authenticateCaller(req)).userId }),
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
