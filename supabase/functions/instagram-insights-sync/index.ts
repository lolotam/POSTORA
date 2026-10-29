/**
 * The composition root of `instagram-insights-sync`.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The clients, the environment and the wiring. It builds the server
 *   controlled clients, hands the handler its narrow ports and registers the
 *   route. It holds no business rule and no validation.
 *
 * WHY THERE IS NO GLOBAL CLIENT OR USER CONTEXT
 *
 *   The two owner RPCs are granted to `authenticated` and explicitly revoked
 *   from `service_role`, and they derive the owner from `auth.uid()`. The
 *   request therefore has to reach PostgreSQL as the CALLER.
 *
 *   The user-context client is built per request, from the PUBLIC project key
 *   and the SAME bearer that was verified, so the token that was checked is
 *   the token that runs the statement. Nothing is cached between requests:
 *   there is no module-level client, no module-level token and no per-user
 *   state, so one request can never run as another request's identity.
 *
 * WHY THE SERVICE CLIENT IS SO NARROW
 *
 *   The service client is used for exactly two things: reading the two
 *   server-controlled settings and writing one sanitized audit row. It never
 *   runs an owner RPC, and it never carries a user id: the accepted SQL has
 *   no `service_role` EXECUTE on the two owner functions, and asking for it
 *   would be asking for the impersonation the SQL refuses.
 *
 * WHY THE URL COMES FROM `SUPABASE_URL`
 *
 *   This stack is self-hosted. The runtime URL is `SUPABASE_URL`; the
 *   historical project reference is not a URL and is never used as one.
 *
 * WHY THE AUDIT WRITE IS ITS OWN BOUNDED SINK
 *
 *   The shared logger enriches every record with the caller's profile,
 *   subscription and plan, which is three unbounded reads that this endpoint
 *   neither needs nor can afford inside its budget. The shared redactor is
 *   still used for the metadata. The write is bounded by the handler's
 *   reserve, it never throws, and a failed write is never reported as a
 *   stored row.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { redactSensitive } from "../_shared/logging.ts";

import {
  createInstagramInsightsSyncHandler,
  type InstagramInsightsSyncDeps,
  type OwnerIntakeAuditEvent,
} from "./handler.ts";
import { isPlainRecord, readOwnData } from "./receipts.ts";
import { createOwnerCollectionStore, type UserRpcCaller } from "./store.ts";
import { InstagramGraphProvider } from "./graphProvider.ts";
import {
  createOwnerCollectionServiceStore,
  type OwnerServiceReadPort,
  type OwnerServiceRpcCaller,
} from "./workerStore.ts";
import type { OwnerWorkerPorts } from "./worker.ts";

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
 * owner from `auth.uid()` and the accepted structural ownership check is the
 * authority. The public key is the apikey; the caller's own bearer is the
 * Authorization header. PostgREST takes the role from that bearer.
 */
function createUserRpcCaller(
  environment: ServerEnvironment,
  verifiedToken: string,
): UserRpcCaller {
  return async (functionName, args, signal) => {
    const client = createClient(environment.url, environment.anonKey, {
      global: {
        headers: { Authorization: `Bearer ${verifiedToken}` },
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          fetch(input, { ...init, signal }),
      },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    // The raw driver envelope. Destructuring it would run accessors and
    // would turn a missing or falsy error into an own null, which is the
    // completed-call signal. The store reads own descriptors before a
    // SQLSTATE is allowed to mean anything, and it never reads the message.
    return await client.rpc(functionName, args);
  };
}

/**
 * The server-controlled settings reader.
 *
 * It uses the service client because the two switch keys are deliberately
 * not readable by a browser session. The envelope is returned whole: a
 * missing error is not an explicit null, and no error field is read here.
 * The handler's descriptor check is what decides unavailable versus absent.
 */
function createSettingReader(environment: ServerEnvironment) {
  return async (key: string): Promise<unknown> => {
    const client = createClient(environment.url, environment.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    return await client
      .from("app_settings")
      .select("value")
      .eq("key", key)
      .maybeSingle();
  };
}

/**
 * The bounded, sanitized audit sink.
 *
 * It records the action, the stable outcome, the verified caller and the
 * validated account. It never records the bearer, the request body, the
 * driver text or a credential-bearing URL.
 */
function createAuditSink(environment: ServerEnvironment) {
  return async (event: OwnerIntakeAuditEvent): Promise<void> => {
    try {
      const client = createClient(environment.url, environment.serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });

      const { error } = await client.from("system_logs").insert({
        level: event.status >= 500 ? "error" : event.status >= 400 ? "warn" : "info",
        category: "edge",
        source: "instagram-insights-sync",
        message: `instagram insights sync ${event.action} ${event.outcome}`,
        user_id: event.userId ?? null,
        metadata: redactSensitive({
          action: event.action,
          outcome: event.outcome,
          status: event.status,
          social_account_id: event.socialAccountId ?? null,
        }) as Record<string, unknown>,
      });

      if (error) {
        // The row was not stored. It is never reported as stored, and the
        // work that produced this outcome is never repeated because of it.
        console.warn("[instagram-insights-sync] the audit write did not succeed");
      }
    } catch {
      console.warn("[instagram-insights-sync] the audit write did not succeed");
    }
  };
}

/**
 * The service RPC caller.
 *
 * It uses the service role and it runs only the service RPCs of the durable
 * collection job substrate, whose ownership checks live in SQL. The client is
 * built per call so the caller's abort signal reaches the transport.
 */
function createServiceRpcCaller(environment: ServerEnvironment): OwnerServiceRpcCaller {
  return async (functionName, args, signal) => {
    const client = createClient(environment.url, environment.serviceRoleKey, {
      global: {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          fetch(input, { ...init, signal: signal ?? init?.signal }),
      },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    // The raw driver envelope. The store reads its own descriptors before a
    // SQLSTATE is allowed to mean anything.
    return await client.rpc(functionName, args);
  };
}

/**
 * The service read port.
 *
 * The table name is a closed union in the store, so no dynamic table can be
 * smuggled in, and every read is owner-scoped by its filters.
 */
function createServiceReadPort(environment: ServerEnvironment): OwnerServiceReadPort {
  return {
    async readOne(table, columns, filters) {
      const client = createClient(environment.url, environment.serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });

      let builder = client.from(table).select(columns);
      for (const [column, value] of Object.entries(filters)) {
        builder = builder.eq(column, value);
      }
      return await builder.maybeSingle();
    },

    async readMany(table, columns, filters, idColumn, ids) {
      if (ids.length === 0) return { data: [], error: null };

      const client = createClient(environment.url, environment.serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });

      let builder = client.from(table).select(columns);
      for (const [column, value] of Object.entries(filters)) {
        builder = builder.eq(column, value);
      }
      builder = builder.in(idColumn, [...ids]);
      return await builder;
    },
  };
}

/**
 * The administrator check.
 *
 * A failed read is NOT an administrator. The check fails closed, so an
 * unreachable database locks the service path rather than opening it.
 */
function createAdminChecker(environment: ServerEnvironment) {
  return async (userId: string): Promise<boolean> => {
    try {
      const client = createClient(environment.url, environment.serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });

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
 * The Graph provider.
 *
 * The version is server configuration and it is validated. The app id is
 * only used to build the shared throttle bucket key, which is a digest of
 * two non-secret values.
 */
function createGraphProvider(): InstagramGraphProvider {
  return new InstagramGraphProvider({
    apiVersion: Deno.env.get("FACEBOOK_GRAPH_API_VERSION") ?? undefined,
    appId: Deno.env.get("FACEBOOK_APP_ID") ?? null,
  });
}

/**
 * The service worker ports.
 *
 * The worker runs with the service role: the accepted worker RPCs are
 * service-only and they re-derive the owner from the target row.
 */
function createOwnerWorkerPorts(environment: ServerEnvironment): OwnerWorkerPorts {
  const provider = createGraphProvider();
  const store = createOwnerCollectionServiceStore({
    rpc: createServiceRpcCaller(environment),
    reads: createServiceReadPort(environment),
  });

  return {
    store,
    provider,
    // The shared bucket follows the credential that Meta meters: the app and
    // the protected credential id. The token is never part of it.
    bucketKeyFor: async (credentialId) => await provider.bucketKey(credentialId),
    now: () => Date.now(),
    log: (event) => {
      console.log("[instagram-insights-sync]", JSON.stringify(event));
    },
  };
}

const deps: InstagramInsightsSyncDeps = {
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

    // The server-verified envelope, returned whole. The token is verified by
    // the project's own signing keys, never decoded on its own. Destructuring
    // data or error would run accessors and copy inherited fields into own
    // values before the handler's descriptor check.
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
    return createOwnerCollectionStore(
      createUserRpcCaller(environment, verifiedToken),
    );
  },

  service: {
    cronSecret: () => Deno.env.get("CRON_SECRET") ?? null,
    serviceRoleKey: () => Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? null,

    isAdmin: async (userId) => {
      const environment = currentEnvironment();
      if (!environment) return false;
      return await createAdminChecker(environment)(userId);
    },

    createServiceWorker: () => {
      const environment = currentEnvironment();
      if (!environment) throw new Error("the server configuration is not usable");
      return createOwnerWorkerPorts(environment);
    },
  },

  audit: async (event) => {
    const environment = currentEnvironment();
    if (!environment) return;
    await createAuditSink(environment)(event);
  },
};

const handler = createInstagramInsightsSyncHandler(deps);

Deno.serve((request: Request) => handler(request));
