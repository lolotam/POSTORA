/**
 * The composition root of `competitor-snapshot-sync`.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The clients, the environment and the wiring. It builds the server
 *   controlled clients, hands the handler its narrow ports and registers the
 *   route. It holds no business rule and no validation.
 *
 * WHY THE OWNER REQUEST RUNS AS THE CALLER
 *
 *   The two owner RPCs are granted to `authenticated` and explicitly
 *   revoked from `service_role`, and they derive the owner from
 *   `auth.uid()`. The request therefore has to reach PostgreSQL as the
 *   CALLER.
 *
 *   The user-context client is built per request, from the PUBLIC project
 *   key and the SAME bearer that was verified, so the token that was
 *   checked is the token that runs the statement. Nothing is cached
 *   between requests: there is no module-level client, no module-level
 *   token and no per-user state.
 *
 * WHY THE SERVICE CLIENT IS SO NARROW
 *
 *   The service client runs the service RPCs, reads the service-owned
 *   tables, reads the two server-controlled settings, checks the
 *   administrator role and writes one sanitized audit row. It never runs
 *   an owner RPC and it never carries a user id that was not derived from
 *   the database.
 *
 * WHY THE PAID FALLBACK IS OFF HERE
 *
 *   Plan decision P5 defers the scheduled paid fallback, and the paid
 *   provider needs an explicit cost policy that has not been approved. The
 *   composition therefore injects a DISABLED policy with a stable refusal
 *   reason. There is no setting in this repository that turns it on, and
 *   no code path here that reaches the paid adapter.
 *
 * WHY THE URL COMES FROM `SUPABASE_URL`
 *
 *   This stack is self-hosted. The runtime URL is `SUPABASE_URL`; the
 *   historical project reference is not a URL and is never used as one.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { redactSensitive } from "../_shared/logging.ts";

import { ApifyCompetitorProvider } from "./apifyProvider.ts";
import { isPlainRecord, readOwnData } from "./receipts.ts";
import {
  createCompetitorSyncHandler,
  type CompetitorSyncAuditEvent,
  type CompetitorSyncDeps,
} from "./handler.ts";
import { GraphCompetitorProvider } from "./graphProvider.ts";
import {
  createCompetitorOwnerStore,
  createCompetitorServiceStore,
  type CompetitorRpcCaller,
  type ServiceOwnedTable,
  type ServiceReadPort,
} from "./store.ts";
import type { CompetitorWorkerPorts } from "./syncWorker.ts";
import type { PaidFallbackPolicy } from "./types.ts";

interface ServerEnvironment {
  readonly url: string;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
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
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!url || !anonKey || !serviceRoleKey) return null;
  return { url, anonKey, serviceRoleKey };
}

/**
 * The user-context RPC caller.
 *
 * It runs the statement as the verified caller, so PostgreSQL derives the
 * owner from `auth.uid()` and the accepted structural ownership check is
 * the authority. The public key is the apikey; the caller's own bearer is
 * the Authorization header. PostgREST takes the role from that bearer.
 */
function createUserRpcCaller(
  environment: ServerEnvironment,
  verifiedToken: string,
): CompetitorRpcCaller {
  return async (functionName, args) => {
    const client = createClient(environment.url, environment.anonKey, {
      global: {
        headers: { Authorization: `Bearer ${verifiedToken}` },
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          fetch(input, { ...init, signal: init?.signal }),
      },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    // The raw driver envelope. Destructuring it would run accessors and
    // would turn a missing or falsy error into an own null, which is the
    // completed-call signal.
    return await client.rpc(functionName, args);
  };
}

/**
 * The service RPC caller.
 *
 * It uses the service role and it is used only by the service RPCs, whose
 * ownership checks live in SQL.
 */
function createServiceRpcCaller(environment: ServerEnvironment): CompetitorRpcCaller {
  const client = createClient(environment.url, environment.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  return async (functionName, args) => await client.rpc(functionName, args);
}

/**
 * The service read port.
 *
 * The table name is a closed union in the store, so no dynamic table can
 * be smuggled in, and every read is owner-scoped by its filters.
 */
function createServiceReadPort(environment: ServerEnvironment): ServiceReadPort {
  const client = createClient(environment.url, environment.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const applyFilters = (
    table: ServiceOwnedTable,
    columns: string,
    filters: Record<string, unknown>,
  ) => {
    let builder = client.from(table).select(columns);
    for (const [column, value] of Object.entries(filters)) {
      builder = builder.eq(column, value);
    }
    return builder;
  };

  return {
    async readOne(table, columns, filters) {
      return await applyFilters(table, columns, filters).maybeSingle();
    },
    async readMany(table, columns, filters, limit) {
      return await applyFilters(table, columns, filters).limit(limit);
    },
  };
}

/**
 * The server-controlled settings reader.
 *
 * The envelope is returned whole: a missing error is not an explicit
 * null, and no error field is read here. The handler's descriptor check is
 * what decides unavailable versus absent.
 */
function createSettingReader(environment: ServerEnvironment) {
  const client = createClient(environment.url, environment.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  return async (key: string): Promise<unknown> => {
    return await client
      .from("app_settings")
      .select("value")
      .eq("key", key)
      .maybeSingle();
  };
}

/**
 * The administrator check.
 *
 * A failed read is NOT an administrator. The check fails closed, so an
 * unreachable database locks the service path rather than opening it.
 */
function createAdminChecker(environment: ServerEnvironment) {
  const client = createClient(environment.url, environment.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  return async (userId: string): Promise<boolean> => {
    try {
      const envelope: unknown = await client
        .from("user_roles")
        .select("role")
        .eq("user_id", userId)
        .eq("role", "admin")
        .maybeSingle();

      // The envelope is read by its own data descriptors and accessors are
      // never run. Only an explicit null error with an own `admin` row is an
      // administrator; a missing error, a missing row, another role or any
      // malformed shape fails closed.
      if (!isPlainRecord(envelope)) return false;
      const error = readOwnData(envelope, "error");
      const data = readOwnData(envelope, "data");
      if (!error.present || error.value !== null || !data.present) return false;
      if (!isPlainRecord(data.value)) return false;
      return readOwnData(data.value, "role").value === "admin";
    } catch {
      return false;
    }
  };
}

/**
 * The bounded, sanitized audit sink.
 *
 * It records the action, the stable outcome, the verified caller and the
 * validated watchlist entry. It never records the bearer, the request
 * body, the driver text or a credential-bearing URL.
 */
function createAuditSink(environment: ServerEnvironment) {
  const client = createClient(environment.url, environment.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  return async (event: CompetitorSyncAuditEvent): Promise<void> => {
    try {
      const { error } = await client.from("system_logs").insert({
        level: event.status >= 500 ? "error" : event.status >= 400 ? "warn" : "info",
        category: "edge",
        source: "competitor-snapshot-sync",
        message: `competitor snapshot sync ${event.action} ${event.outcome}`,
        user_id: event.userId ?? null,
        metadata: redactSensitive({
          action: event.action,
          outcome: event.outcome,
          status: event.status,
          watchlist_id: event.watchlistId ?? null,
        }) as Record<string, unknown>,
      });

      if (error) {
        // The row was not stored. It is never reported as stored, and the
        // work that produced this outcome is never repeated because of it.
        console.warn("[competitor-snapshot-sync] the audit write did not succeed");
      }
    } catch {
      console.warn("[competitor-snapshot-sync] the audit write did not succeed");
    }
  };
}

/**
 * The Graph provider.
 *
 * The version is server configuration and it is validated. The app id is
 * only used to build the shared throttle bucket key, which is a digest of
 * two non-secret values.
 */
function createGraphProvider(): GraphCompetitorProvider {
  return new GraphCompetitorProvider({
    apiVersion: Deno.env.get("FACEBOOK_GRAPH_API_VERSION") ?? undefined,
    appId: Deno.env.get("FACEBOOK_APP_ID") ?? null,
  });
}

/**
 * The paid fallback policy.
 *
 * Scheduled paid work is DEFERRED (plan decision P5): the fallback needs an
 * explicit cost policy that has not been approved. The bounded adapter is
 * still BUILT here, so the module has a real production owner rather than
 * being a tested artifact nobody can reach, and the policy the worker
 * receives is DISABLED, so no request can ever reach the adapter.
 *
 * There is no setting in this repository that flips `enabled`, and no code
 * path that reads one. Turning the paid path on is a deliberate change to
 * this function, not a configuration.
 */
function createPaidFallbackPolicy(): PaidFallbackPolicy {
  try {
    const adapter = new ApifyCompetitorProvider({
      actorId: Deno.env.get("APIFY_ACTOR_ID") ?? undefined,
      apiToken: Deno.env.get("APIFY_TOKEN") ?? "",
    });

    return {
      enabled: false,
      provider: adapter,
      refusalReason: "apify_disabled",
    };
  } catch {
    // A malformed actor id is a configuration problem in a path that is
    // not reachable anyway. It must never break the collection.
    return { enabled: false, refusalReason: "apify_disabled" };
  }
}

const deps: CompetitorSyncDeps = {
  configuration: () => (currentEnvironment() ? "ready" : "unavailable"),

  verifyClaims: async (token, signal) => {
    const environment = currentEnvironment();
    if (!environment) throw new Error("the server configuration is not usable");

    const client = createClient(environment.url, environment.anonKey, {
      global: {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          fetch(input, { ...init, signal }),
      },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    // The server-verified envelope, returned whole. The token is verified
    // by the project's own signing keys, never decoded on its own.
    return await client.auth.getClaims(token);
  },

  readSetting: async (key) => {
    const environment = currentEnvironment();
    if (!environment) throw new Error("the server configuration is not usable");
    return await createSettingReader(environment)(key);
  },

  createOwnerStore: (verifiedToken) => {
    const environment = currentEnvironment();
    if (!environment) throw new Error("the server configuration is not usable");
    return createCompetitorOwnerStore(createUserRpcCaller(environment, verifiedToken));
  },

  createServiceWorker: () => {
    const environment = currentEnvironment();
    if (!environment) throw new Error("the server configuration is not usable");

    const provider = createGraphProvider();
    const store = createCompetitorServiceStore({
      rpc: createServiceRpcCaller(environment),
      reads: createServiceReadPort(environment),
    });

    const worker: CompetitorWorkerPorts = {
      store,
      officialProvider: provider,
      // The scheduled paid fallback is DEFERRED (plan decision P5). The
      // policy is injected and it is disabled. There is no setting here
      // that could enable paid work, and no code path that reaches the
      // paid adapter.
      paidFallback: { enabled: false, refusalReason: "apify_disabled" },
      bucketKeyFor: async (credentialId) => await provider.bucketKey(credentialId),
      now: () => Date.now(),
      log: (event) => {
        console.log("[competitor-snapshot-sync]", JSON.stringify(event));
      },
    };

    return worker;
  },

  cronSecret: () => Deno.env.get("CRON_SECRET") ?? null,
  serviceRoleKey: () => Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? null,

  isAdmin: async (userId) => {
    const environment = currentEnvironment();
    if (!environment) return false;
    return await createAdminChecker(environment)(userId);
  },

  audit: async (event) => {
    const environment = currentEnvironment();
    if (!environment) return;
    await createAuditSink(environment)(event);
  },
};

const handler = createCompetitorSyncHandler(deps);

Deno.serve((request: Request) => handler(request));
