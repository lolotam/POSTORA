/**
 * The ACTUAL registered `competitor-retention` route.
 *
 * WHAT THIS SUITE IS
 *
 *   It loads the real `supabase/functions/competitor-retention/index.ts`,
 *   lets it register its handler through `Deno.serve`, and drives real
 *   requests through it. It is NOT a copy of the dispatch: a broken copy of
 *   the route fails this suite.
 *
 *   Only the INFRASTRUCTURE is faked. The Supabase client is replaced, so
 *   the HTTP composition is observable: which key was supplied, which
 *   function was called and with WHICH arguments. Everything else is the
 *   production code: the request contract, the authorization matrix, the
 *   body validation, the run and the response mapping.
 *
 * THE RELOCATION AND THE MUTATIONS
 *
 *   Three proofs run against COPIES of the source tree. The repository
 *   source is never modified:
 *
 *     - the relocated positive: the same route, copied to another
 *       directory, still runs the cleanup;
 *     - the broken-auth copy: a copy whose authorization check is removed
 *       accepts an anonymous caller, which proves the check is load-bearing;
 *     - the broken routing copy: a copy whose route no longer reaches the
 *       handler answers 404.
 *
 *   Every proof is behavioural. A source pattern that "looks right" is not a
 *   proof.
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

const BUNDLE_DIR = Deno.makeTempDirSync({ prefix: "postora-competitor-retention-route-" });
const COPY_DIR = Deno.makeTempDirSync({ prefix: "postora-competitor-retention-copy-" });

const SUPABASE_URL = "https://api.postora.invalid";
const ANON_KEY = "synthetic-anon-key";
const SERVICE_ROLE_KEY = "synthetic-service-role-key";
const CRON_SECRET = "synthetic-cron-secret";
const ADMIN_ID = "0f100001-0000-4000-8000-000000000009";
const ADMIN_BEARER = "synthetic.admin.bearer";
const ORDINARY_BEARER = "synthetic.ordinary.bearer";

interface Probe {
  readonly clients: Array<{ url: string; key: string }>;
  readonly rpcCalls: Array<{ name: string; args: Record<string, unknown>; key: string }>;
  readonly inserts: Array<{ table: string; row: Record<string, unknown>; key: string }>;
  rpc: unknown;
  adminRole: unknown;
}

function newProbe(): Probe {
  return {
    clients: [],
    rpcCalls: [],
    inserts: [],
    rpc: {
      switch_state: "enabled",
      dry_run: false,
      parents_considered: 2,
      parents_deleted: 1,
      parents_projected: 1,
      parents_skipped_live_lease: 0,
      parents_skipped_ineligible: 1,
      child_counts: {
        competitor_media_snapshots: 2,
        competitor_profile_snapshots: 0,
        competitor_capture_coverage: 0,
        instagram_collection_job_operations: 0,
        instagram_collection_job_checkpoints: 0,
        instagram_collection_jobs: 1,
        instagram_collection_request_throttles: 0,
      },
      children_counted: 3,
      children_deleted: 3,
      has_more: false,
    },
    adminRole: { data: { role: "admin" }, error: null },
  };
}

const STUB_SOURCE = `
export function createClient(url, key, options) {
  const probe = globalThis.__postoraRetentionProbe;
  probe.clients.push({ url, key });

  const builder = (table) => {
    const state = { table, filters: {}, columns: null };
    const b = {
      select(columns) { state.columns = columns; return b; },
      eq(column, value) { state.filters[column] = value; return b; },
      async maybeSingle() {
        if (state.table === "user_roles") return probe.adminRole;
        return { data: null, error: null };
      },
      async insert(row) {
        probe.inserts.push({ table: state.table, row, key });
        return { data: null, error: null };
      },
      async maybeSingleAsync() { return { data: null, error: null }; },
      then(onFulfilled, onRejected) {
        return Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected);
      },
    };
    return b;
  };

  return {
    auth: {
      async getUser(token) {
        if (token === ${JSON.stringify(ADMIN_BEARER)}) {
          return { data: { user: { id: ${JSON.stringify(ADMIN_ID)} } }, error: null };
        }
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    rpc(name, args) {
      probe.rpcCalls.push({ name, args, key });
      // The database echoes the flag it was given.
      return Promise.resolve({ data: { ...probe.rpc, dry_run: args.p_dry_run }, error: null });
    },
    from(table) {
      return builder(table);
    },
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
  const globals = globalThis as { __postoraRetentionProbe?: Probe };
  globals.__postoraRetentionProbe = probe;

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
    const outfile = await bundle("competitor-retention/index.ts", functionsRoot);
    await import(`${pathToFileURL(outfile).href}?case=${++importSeq}`);
  } finally {
    Deno.serve = previousServe;
  }

  if (!handler) throw new Error("competitor-retention did not register a request handler");
  return handler as RouteHandler;
}

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://api.postora.invalid/functions/v1/competitor-retention", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-cron-secret": CRON_SECRET,
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
  for (const folder of ["competitor-retention", "_shared"]) {
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

Deno.test("the actual registered route runs the cleanup for the cron scheduler", async () => {
  const probe = newProbe();
  const handler = await loadRoute(probe);

  const response = await handler(request({ dry_run: false }));

  assertEquals(response.status, 200);
  const payload = await body(response);
  assertEquals(payload.parents_deleted, 1);
  assertEquals(payload.children_deleted, 3);
  assertEquals(payload.switch_state, "enabled");
  assertEquals(payload.stop_reason, "completed");

  // Exactly one call, to the batch RPC, with exactly the three allowed
  // arguments: no owner, no cutoff, no time.
  assertEquals(probe.rpcCalls.length, 1);
  const call = probe.rpcCalls[0]!;
  assertEquals(call.name, "run_competitor_retention_batch");
  assertEquals(Object.keys(call.args).sort(), ["p_child_limit", "p_dry_run", "p_parent_limit"]);
  assertEquals(call.args, {
    p_parent_limit: 50,
    p_child_limit: 500,
    p_dry_run: false,
  });
  assertEquals(call.key, SERVICE_ROLE_KEY);

  // The service client is used for the audit row only.
  assertEquals(probe.inserts.length, 1);
  assertEquals(probe.inserts[0]!.table, "system_logs");
  assertEquals(probe.inserts[0]!.key, SERVICE_ROLE_KEY);
});

Deno.test("the actual registered route refuses an anonymous caller", async () => {
  const probe = newProbe();
  const handler = await loadRoute(probe);

  const response = await handler(
    new Request("https://api.postora.invalid/functions/v1/competitor-retention", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dry_run: false }),
    }),
  );

  assertEquals(response.status, 401);
  assertEquals(probe.rpcCalls.length, 0);
});

Deno.test("the actual registered route refuses an ordinary user", async () => {
  const probe = newProbe();
  const handler = await loadRoute(probe);

  const response = await handler(
    request({ dry_run: false }, {
      "x-cron-secret": "",
      Authorization: `Bearer ${ORDINARY_BEARER}`,
    }),
  );

  assertEquals(response.status, 401);
  assertEquals(probe.rpcCalls.length, 0);
});

Deno.test("the actual registered route accepts a verified admin", async () => {
  const probe = newProbe();
  const handler = await loadRoute(probe);

  const response = await handler(
    request({ dry_run: true }, {
      "x-cron-secret": "",
      Authorization: `Bearer ${ADMIN_BEARER}`,
    }),
  );

  assertEquals(response.status, 200);
  assertEquals(probe.rpcCalls.length, 1);
  assertEquals(probe.rpcCalls[0]!.args.p_dry_run, true);
});

Deno.test("the actual registered route refuses a client-supplied cutoff", async () => {
  const probe = newProbe();
  const handler = await loadRoute(probe);

  const response = await handler(request({ dry_run: false, cutoff: "2020-01-01T00:00:00Z" }));

  assertEquals(response.status, 400);
  assertEquals(probe.rpcCalls.length, 0);
});

Deno.test("the actual registered route answers the preflight", async () => {
  const probe = newProbe();
  const handler = await loadRoute(probe);

  const response = await handler(
    new Request("https://api.postora.invalid/functions/v1/competitor-retention", { method: "OPTIONS" }),
  );

  assertEquals(response.status, 204);
  assertEquals(response.headers.get("access-control-allow-origin") === "*", false);
});

Deno.test("the relocated route still runs the cleanup", async () => {
  const functionsRoot = await copyWithMutation(() => undefined);

  const probe = newProbe();
  const handler = await loadRoute(probe, functionsRoot);

  const response = await handler(request({ dry_run: false }));

  assertEquals(response.status, 200);
  assertEquals((await body(response)).parents_deleted, 1);
  assertEquals(probe.rpcCalls.length, 1);
  assertEquals(probe.rpcCalls[0]!.name, "run_competitor_retention_batch");
});

Deno.test("a copy whose authorization check is removed accepts an anonymous caller", async () => {
  const functionsRoot = await copyWithMutation((root) => {
    replaceInFile(
      join(root, "competitor-retention/handler.ts"),
      "  const auth = await verifyCronOrAdmin(req);\n  if (!auth.ok) {",
      "  const auth = { ok: true } as const;\n  if (!auth.ok) {",
    );
  });

  const probe = newProbe();
  const handler = await loadRoute(probe, functionsRoot);

  const response = await handler(
    new Request("https://api.postora.invalid/functions/v1/competitor-retention", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dry_run: false }),
    }),
  );

  // The statement really ran: the copy reached the cleanup without an
  // authority, which is what the real route refuses.
  assertEquals(response.status, 200);
  assertEquals(probe.rpcCalls.length, 1);
});

Deno.test("a copy whose route no longer reaches the handler answers 404", async () => {
  const functionsRoot = await copyWithMutation((root) => {
    replaceInFile(
      join(root, "competitor-retention/index.ts"),
      "Deno.serve((req) => handleCompetitorRetentionRequest(req));",
      'Deno.serve(() => new Response("not found", { status: 404 }));',
    );
  });

  const probe = newProbe();
  const handler = await loadRoute(probe, functionsRoot);

  const response = await handler(request({ dry_run: false }));

  assertEquals(response.status, 404);
  assertEquals(probe.rpcCalls.length, 0);
  assert(
    true,
    "the mutation anchor must still exist in index.ts, otherwise the copy is not the route under test",
  );
});
