/**
 * The ACTUAL registered `competitor-snapshot-sync` route.
 *
 * WHAT THIS SUITE IS
 *
 *   It loads the real `supabase/functions/competitor-snapshot-sync/index.ts`,
 *   lets it register its handler through `Deno.serve`, and drives real
 *   requests through it. It is NOT a copy of the dispatch: a broken copy of
 *   the route fails this suite.
 *
 *   Only the INFRASTRUCTURE is faked. The Supabase client is replaced, so
 *   the HTTP composition is observable: which key was supplied, which
 *   Authorization header was sent, and which function was called.
 *   Everything else is the production code: the request contract, the
 *   authorization matrix, the gates, the store, the projection parsing and
 *   the response mapping.
 *
 * THE RELOCATION AND THE MUTATIONS
 *
 *   Three proofs run against COPIES of the source tree. The repository
 *   source is never modified:
 *
 *     - the relocated positive: the same route, copied to another
 *       directory, still enqueues and still reads a status;
 *     - the broken identity copy: a copy whose owner RPC replaces the
 *       verified bearer with a service Authorization identity is refused
 *       and never reports an enqueue;
 *     - the broken routing copy: a copy whose route no longer reaches the
 *       handler answers 404.
 *
 *   Every proof is behavioural. A source pattern that "looks right" is not
 *   a proof.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testFilePath = fileURLToPath(import.meta.url);
const FUNCTIONS_ROOT = dirname(dirname(testFilePath));
const REPO_ROOT = dirname(dirname(FUNCTIONS_ROOT));
const require = createRequire(join(REPO_ROOT, "package.json"));
const { build } = require("esbuild") as {
  build: (options: Record<string, unknown>) => Promise<unknown>;
};

const BUNDLE_DIR = Deno.makeTempDirSync({ prefix: "postora-competitor-route-" });
const COPY_DIR = Deno.makeTempDirSync({ prefix: "postora-competitor-copy-" });

const SUPABASE_URL = "https://api.postora.invalid";
const ANON_KEY = "synthetic-anon-key";
const SERVICE_ROLE_KEY = "synthetic-service-role-key";
const CRON_SECRET = "synthetic-cron-secret";
const OWNER_ID = "0f100001-0000-4000-8000-000000000001";
const WATCHLIST_ID = "0f1c0002-0000-4000-8000-000000000012";
const BEARER = "synthetic.owner.bearer";

interface Probe {
  readonly clients: Array<{ url: string; key: string; authorization: string | null }>;
  readonly claimTokens: string[];
  readonly rpcCalls: Array<{
    name: string;
    args: Record<string, unknown>;
    key: string;
    authorization: string | null;
  }>;
  readonly settingReads: Array<{ settingKey: string; clientKey: string }>;
  readonly inserts: Array<{ table: string; row: Record<string, unknown>; clientKey: string }>;
  readonly tableReads: Array<{ table: string; filters: Record<string, unknown>; clientKey: string }>;
  claims: unknown;
  rpc: unknown;
  appSettings: Record<string, unknown>;
  userRoles: unknown;
}

function newProbe(): Probe {
  return {
    clients: [],
    claimTokens: [],
    rpcCalls: [],
    settingReads: [],
    inserts: [],
    tableReads: [],
    claims: { data: { claims: { sub: OWNER_ID, role: "authenticated" } }, error: null },
    rpc: {
      data: {
        accepted: true,
        reason: "enqueued",
        job_id: "5c1b0003-0000-4000-8000-000000000003",
        job_generation: 1,
        status: "queued",
        captured_on: "2026-10-29",
        created: true,
        accepted_at: "2026-10-29T02:00:00.123456+00:00",
      },
      error: null,
    },
    appSettings: {
      collection_instagram_insights_enabled: { data: { value: true }, error: null },
      credential_facebook_user_mode: { data: { value: "protected" }, error: null },
    },
    userRoles: { data: null, error: null },
  };
}

const STUB_SOURCE = `
export function createClient(url, key, options) {
  const probe = globalThis.__postoraCompetitorProbe;
  const headers = options && options.global && options.global.headers ? options.global.headers : {};
  const authorization = headers.Authorization ? headers.Authorization : null;
  probe.clients.push({ url, key, authorization });

  const readTable = (state) => {
    probe.tableReads.push({ table: state.table, filters: state.filters, clientKey: key });

    if (state.table === "app_settings") {
      const row = probe.appSettings[state.filters.key];
      probe.settingReads.push({ settingKey: state.filters.key, clientKey: key });
      return row ? row : { data: null, error: null };
    }
    if (state.table === "user_roles") {
      return probe.userRoles;
    }
    if (state.table === "competitor_watchlist") {
      return { data: null, error: null };
    }
    if (state.table === "social_accounts" || state.table === "instagram_account_capabilities") {
      return { data: [], error: null };
    }
    if (state.table === "instagram_provider_throttle_buckets") {
      return { data: null, error: null };
    }
    return { data: [], error: null };
  };

  const from = (table) => {
    const state = { table, filters: {}, columns: null, limit: null };
    const builder = {
      select(columns) { state.columns = columns; return builder; },
      eq(column, value) { state.filters[column] = value; return builder; },
      limit(count) { state.limit = count; return builder; },
      async maybeSingle() { return readTable(state); },
      async insert(row) {
        probe.inserts.push({ table: state.table, row, clientKey: key });
        return { data: null, error: null };
      },
      then(onFulfilled, onRejected) {
        return Promise.resolve(readTable(state)).then(onFulfilled, onRejected);
      },
    };
    return builder;
  };

  return {
    auth: {
      async getClaims(token) {
        probe.claimTokens.push(token);
        return probe.claims;
      },
    },
    rpc(name, args) {
      probe.rpcCalls.push({ name, args, key, authorization });
      // The bearer is the identity this fake answers for. A different
      // Authorization value is refused.
      if (authorization !== ${JSON.stringify(`Bearer ${BEARER}`)}) {
        return Promise.resolve({ data: null, error: { code: "42501" } });
      }
      return Promise.resolve(probe.rpc);
    },
    from,
  };
}
`;

const bundles = new Map<string, string>();
let importSeq = 0;

async function bundle(entry: string, functionsRoot: string): Promise<string> {
  const key = `${functionsRoot}::${entry}`;
  const cached = bundles.get(key);
  if (cached) return cached;

  await Deno.mkdir(BUNDLE_DIR, { recursive: true });
  const outfile = `${BUNDLE_DIR}/${key.replaceAll(/[\\/:]/g, "-")}-${++importSeq}.mjs`;

  await build({
    entryPoints: [join(functionsRoot, entry)],
    bundle: true,
    format: "esm",
    platform: "neutral",
    outfile,
    plugins: [{
      name: "infrastructure-ports",
      setup(esbuild: {
        onResolve: (
          options: { filter: RegExp },
          callback: (args: { path: string }) => unknown,
        ) => void;
        onLoad: (
          options: { filter: RegExp; namespace: string },
          callback: () => unknown,
        ) => void;
      }) {
        esbuild.onResolve({ filter: /.*/ }, (args) => {
          const path = args.path;
          if (path.includes("@supabase/supabase-js") || path.includes("esm.sh/@supabase")) {
            return { path: "port", namespace: "stub" };
          }
          // The real Zod is resolved by Deno at import time.
          if (path.startsWith("npm:")) {
            return { path, external: true };
          }
          return undefined;
        });
        esbuild.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: STUB_SOURCE,
          loader: "js",
        }));
      },
    }],
  });

  bundles.set(key, outfile);
  return outfile;
}

const originalServe = Deno.serve;
const originalEnv = {
  SUPABASE_URL: Deno.env.get("SUPABASE_URL"),
  SUPABASE_ANON_KEY: Deno.env.get("SUPABASE_ANON_KEY"),
  SUPABASE_SERVICE_ROLE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  CRON_SECRET: Deno.env.get("CRON_SECRET"),
};

globalThis.addEventListener("unload", () => {
  Deno.serve = originalServe;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  try {
    Deno.removeSync(BUNDLE_DIR, { recursive: true });
    Deno.removeSync(COPY_DIR, { recursive: true });
  } catch (_error) {
    // A failed temp cleanup must not hide the test result.
  }
});

type RouteHandler = (request: Request) => Response | Promise<Response>;

async function loadRoute(
  probe: Probe,
  functionsRoot: string = FUNCTIONS_ROOT,
): Promise<RouteHandler> {
  const globals = globalThis as { __postoraCompetitorProbe?: Probe };
  globals.__postoraCompetitorProbe = probe;

  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("CRON_SECRET", CRON_SECRET);

  let handler: RouteHandler | null = null;
  const previousServe = Deno.serve;
  Deno.serve = ((registered: RouteHandler) => {
    handler = registered;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  }) as typeof Deno.serve;

  try {
    const outfile = await bundle("competitor-snapshot-sync/index.ts", functionsRoot);
    await import(`${pathToFileURL(outfile).href}?case=${++importSeq}`);
  } finally {
    Deno.serve = previousServe;
  }

  if (!handler) throw new Error("competitor-snapshot-sync did not register a request handler");
  return handler as RouteHandler;
}

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://api.postora.invalid/functions/v1/competitor-snapshot-sync", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BEARER}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function body(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

// ---------------------------------------------------------------------------
// The copied source trees
// ---------------------------------------------------------------------------

let copySeq = 0;

async function copyTree(from: string, to: string): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory) await copyTree(source, target);
    else if (entry.isFile) await Deno.copyFile(source, target);
  }
}

async function copyWithMutation(
  mutate: (functionsRoot: string) => void,
): Promise<string> {
  const target = `${COPY_DIR}/copy-${++copySeq}`;
  await Deno.mkdir(`${target}/supabase/functions`, { recursive: true });
  for (const folder of ["competitor-snapshot-sync", "_shared"]) {
    await copyTree(
      join(FUNCTIONS_ROOT, folder),
      `${target}/supabase/functions/${folder}`,
    );
  }
  const functionsRoot = `${target}/supabase/functions`;
  mutate(functionsRoot);
  return functionsRoot;
}

function replaceInFile(path: string, from: string, to: string): void {
  const text = Deno.readTextFileSync(path);
  if (!text.includes(from)) {
    throw new Error(`the mutation anchor is missing in ${path}`);
  }
  Deno.writeTextFileSync(path, text.replaceAll(from, to));
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

Deno.test("the actual registered route enqueues as the verified caller", async () => {
  const probe = newProbe();
  const handler = await loadRoute(probe);

  const response = await handler(request({ mode: "entry", watchlist_id: WATCHLIST_ID }));

  assertEquals(response.status, 202);
  const payload = await body(response);
  assertEquals(payload.accepted, true);
  assertEquals(payload.job_id, "5c1b0003-0000-4000-8000-000000000003");

  // The owner RPC ran on the PUBLIC key, with the caller's own bearer, and
  // with the competitor target kind.
  assertEquals(probe.rpcCalls.length, 1);
  const call = probe.rpcCalls[0]!;
  assertEquals(call.name, "enqueue_instagram_collection_job");
  assertEquals(call.key, ANON_KEY);
  assertEquals(call.authorization, `Bearer ${BEARER}`);
  assertEquals(call.args, {
    p_target_kind: "competitor",
    p_target_id: WATCHLIST_ID,
    p_mode: "normal",
  });

  // The claim verification used the same bearer, unchanged.
  assertEquals(probe.claimTokens.length, 1);
  assertEquals(probe.claimTokens[0], BEARER);

  // The service client was used for the settings and for the audit row
  // only. It never ran an owner RPC.
  assertEquals(probe.settingReads.length, 2);
  for (const read of probe.settingReads) {
    assertEquals(read.clientKey, SERVICE_ROLE_KEY);
  }
  assertEquals(probe.inserts.length, 1);
  assertEquals(probe.inserts[0]!.table, "system_logs");
  assertEquals(probe.inserts[0]!.clientKey, SERVICE_ROLE_KEY);
  assertEquals(probe.inserts[0]!.row.user_id, OWNER_ID);
  assertEquals(JSON.stringify(probe.inserts[0]!.row).includes(BEARER), false);
});

Deno.test("the actual registered route reads a status as the verified caller", async () => {
  const probe = newProbe();
  probe.rpc = {
    data: {
      target_kind: "competitor",
      target_id: WATCHLIST_ID,
      captured_on: "2026-10-29",
      status: "partial",
      job_generation: 3,
      attempts: 2,
      due_at: "2026-10-29T02:00:00+00:00",
      next_retry_at: null,
      last_attempt_at: "2026-10-29T02:00:00+00:00",
      last_partial_at: null,
      last_success_at: null,
      reason_code: "provider_throttled",
      inventory: {
        truncated: false,
        partial: false,
        window_covered: false,
        oldest_returned_at: null,
        gap_reason: null,
        pages_fetched: 0,
      },
      pending_operations: 7,
    },
    error: null,
  };

  const handler = await loadRoute(probe);
  const response = await handler(request({ mode: "status", watchlist_id: WATCHLIST_ID }));

  assertEquals(response.status, 200);
  const payload = await body(response);
  assertEquals(payload.pending_operations, 7);
  assertEquals(payload.target_kind, "competitor");
  assertEquals("job_id" in payload, false);

  assertEquals(probe.rpcCalls.length, 1);
  assertEquals(probe.rpcCalls[0]!.name, "read_instagram_collection_job_status");
  assertEquals(probe.rpcCalls[0]!.key, ANON_KEY);
  assertEquals(probe.rpcCalls[0]!.args.p_capture_day, null);
});

Deno.test("the actual registered route refuses a throttle with a Retry-After", async () => {
  const probe = newProbe();
  probe.rpc = {
    data: {
      accepted: false,
      reason: "throttled",
      retry_after_seconds: 120,
      captured_on: "2026-10-29",
    },
    error: null,
  };

  const handler = await loadRoute(probe);
  const response = await handler(request({ mode: "entry", watchlist_id: WATCHLIST_ID }));

  assertEquals(response.status, 429);
  assertEquals(response.headers.get("Retry-After"), "120");
});

Deno.test("the actual registered route refuses the cron secret for a user mode", async () => {
  const probe = newProbe();
  const handler = await loadRoute(probe);

  const response = await handler(
    request({ mode: "entry", watchlist_id: WATCHLIST_ID }, {
      Authorization: `Bearer ${CRON_SECRET}`,
    }),
  );

  assertEquals(response.status, 403);
  assertEquals((await body(response)).error, "forbidden");
  assertEquals(probe.rpcCalls.length, 0);
});

Deno.test("the actual registered route refuses a plain user for the service modes", async () => {
  const probe = newProbe();
  const handler = await loadRoute(probe);

  const response = await handler(request({ mode: "all" }));

  assertEquals(response.status, 403);
  assertEquals((await body(response)).error, "forbidden");
});

Deno.test("the actual registered route refuses a disabled collection before any owner work", async () => {
  const probe = newProbe();
  probe.appSettings = {
    collection_instagram_insights_enabled: { data: null, error: null },
    credential_facebook_user_mode: { data: { value: "protected" }, error: null },
  };

  const handler = await loadRoute(probe);
  const response = await handler(request({ mode: "entry", watchlist_id: WATCHLIST_ID }));

  assertEquals(response.status, 503);
  assertEquals((await body(response)).error, "collection_disabled");
  assertEquals(probe.rpcCalls.length, 0);
  assertEquals(probe.settingReads.length, 1);
});

Deno.test("the actual registered route refuses a legacy credential mode", async () => {
  const probe = newProbe();
  probe.appSettings = {
    collection_instagram_insights_enabled: { data: { value: true }, error: null },
    credential_facebook_user_mode: { data: { value: "legacy" }, error: null },
  };

  const handler = await loadRoute(probe);
  const response = await handler(request({ mode: "entry", watchlist_id: WATCHLIST_ID }));

  assertEquals(response.status, 503);
  assertEquals((await body(response)).error, "protected_credentials_required");
  assertEquals(probe.rpcCalls.length, 0);
});

Deno.test("the relocated route still enqueues and still reads a status", async () => {
  const functionsRoot = await copyWithMutation(() => undefined);

  const probe = newProbe();
  const handler = await loadRoute(probe, functionsRoot);

  const enqueued = await handler(request({ mode: "entry", watchlist_id: WATCHLIST_ID }));
  assertEquals(enqueued.status, 202);
  assertEquals((await body(enqueued)).accepted, true);

  // The status call is answered with the accepted no-job projection: the
  // relocated route must still parse a real status receipt.
  probe.rpc = {
    data: {
      target_kind: "competitor",
      target_id: WATCHLIST_ID,
      captured_on: "2026-10-29",
      status: "none",
      job_generation: 0,
      attempts: 0,
      due_at: null,
      next_retry_at: null,
      last_attempt_at: null,
      last_partial_at: null,
      last_success_at: null,
      reason_code: null,
      inventory: {
        truncated: false,
        partial: false,
        window_covered: false,
        oldest_returned_at: null,
        gap_reason: null,
        pages_fetched: 0,
      },
    },
    error: null,
  };
  const status = await handler(request({ mode: "status", watchlist_id: WATCHLIST_ID }));
  assertEquals(status.status, 200);
  assertEquals((await body(status)).target_kind, "competitor");
});

Deno.test("a copy that swaps the caller identity is refused and never enqueues", async () => {
  const functionsRoot = await copyWithMutation((root) => {
    replaceInFile(
      join(root, "competitor-snapshot-sync/index.ts"),
      "headers: { Authorization: `Bearer ${verifiedToken}` },",
      "headers: { Authorization: `Bearer ${environment.serviceRoleKey}` },",
    );
  });

  const probe = newProbe();
  const handler = await loadRoute(probe, functionsRoot);

  const response = await handler(request({ mode: "entry", watchlist_id: WATCHLIST_ID }));

  // The statement really ran, with the SWAPPED identity, and the database
  // refused it. The endpoint never reports an enqueue.
  const call = probe.rpcCalls.find((entry) => entry.name === "enqueue_instagram_collection_job");
  assert(call !== undefined);
  assertEquals(call.authorization, `Bearer ${SERVICE_ROLE_KEY}`);

  assertEquals(response.status, 403);
  const payload = await body(response);
  assertEquals(payload.error, "forbidden");
  assertEquals(payload.accepted, undefined);
  assertEquals(payload.job_id, undefined);
});

Deno.test("a copy whose route no longer reaches the handler answers 404", async () => {
  const functionsRoot = await copyWithMutation((root) => {
    replaceInFile(
      join(root, "competitor-snapshot-sync/index.ts"),
      "Deno.serve((request: Request) => handler(request));",
      'Deno.serve(() => new Response("not found", { status: 404 }));',
    );
  });

  const probe = newProbe();
  const handler = await loadRoute(probe, functionsRoot);

  const response = await handler(request({ mode: "entry", watchlist_id: WATCHLIST_ID }));

  assertEquals(response.status, 404);
});
