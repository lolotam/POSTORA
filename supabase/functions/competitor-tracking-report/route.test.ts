/**
 * The ACTUAL registered `competitor-tracking-report` route.
 *
 * WHAT THIS SUITE IS
 *
 *   It loads the real `supabase/functions/competitor-tracking-report/index.ts`,
 *   lets it register its handler through `Deno.serve`, and drives real
 *   requests through it. It is NOT a copy of the dispatch: a broken copy of
 *   the route fails this suite.
 *
 *   Only the INFRASTRUCTURE is faked. The Supabase client is replaced, so the
 *   HTTP composition is observable: which key was supplied, which
 *   Authorization header was sent, and which function was called. Everything
 *   else is the production code: the request contract, the authorization
 *   rule, the store, the assembler and the response mapping.
 *
 * THE RELOCATION AND THE MUTATIONS
 *
 *   Three proofs run against COPIES of the source tree. The repository
 *   source is never modified:
 *
 *     - the relocated positive: the same route, copied to another
 *       directory, still reads;
 *     - the broken identity copy: a copy whose store replaces the verified
 *       bearer with a service Authorization identity is refused and never
 *       reports a read;
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

const BUNDLE_DIR = Deno.makeTempDirSync({ prefix: "postora-competitor-report-route-" });
const COPY_DIR = Deno.makeTempDirSync({ prefix: "postora-competitor-report-copy-" });

const SUPABASE_URL = "https://api.postora.invalid";
const ANON_KEY = "synthetic-anon-key";
const SERVICE_ROLE_KEY = "synthetic-service-role-key";
const OWNER_ID = "0f100001-0000-4000-8000-000000000001";
const WATCHLIST_ID = "e2000000-0000-4000-8000-0000000000b1";
const BEARER = "synthetic.owner.bearer";

const CAPTURED_FIXTURE = join(
  dirname(testFilePath),
  "fixtures",
  "captured-report.json",
);

interface Probe {
  readonly clients: Array<{ url: string; key: string; authorization: string | null }>;
  readonly claimTokens: string[];
  readonly rpcCalls: Array<{
    name: string;
    args: Record<string, unknown>;
    key: string;
    authorization: string | null;
  }>;
  claims: unknown;
  rpc: unknown;
}

async function capturedProjection(): Promise<Record<string, unknown>> {
  return JSON.parse(await Deno.readTextFile(CAPTURED_FIXTURE));
}

function newProbe(): Probe {
  return {
    clients: [],
    claimTokens: [],
    rpcCalls: [],
    claims: { data: { claims: { sub: OWNER_ID, role: "authenticated" } }, error: null },
    rpc: { data: null, error: null },
  };
}

const STUB_SOURCE = `
export function createClient(url, key, options) {
  const probe = globalThis.__postoraCompetitorReportProbe;
  const headers = options && options.global && options.global.headers ? options.global.headers : {};
  const authorization = headers.Authorization ? headers.Authorization : null;
  probe.clients.push({ url, key, authorization });

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
    from() {
      throw new Error("this endpoint never reads a table");
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
          // The node builtins are resolved by Deno at import time.
          if (path.startsWith("node:")) {
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
  const globals = globalThis as { __postoraCompetitorReportProbe?: Probe };
  globals.__postoraCompetitorReportProbe = probe;

  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);

  let handler: RouteHandler | null = null;
  const previousServe = Deno.serve;
  Deno.serve = ((registered: RouteHandler) => {
    handler = registered;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  }) as typeof Deno.serve;

  try {
    const outfile = await bundle("competitor-tracking-report/index.ts", functionsRoot);
    await import(`${pathToFileURL(outfile).href}?case=${++importSeq}`);
  } finally {
    Deno.serve = previousServe;
  }

  if (!handler) throw new Error("competitor-tracking-report did not register a request handler");
  return handler as RouteHandler;
}

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://api.postora.invalid/functions/v1/competitor-tracking-report", {
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

/* --------------------------------------------------------------------------- */
/* The copied source trees                                                       */
/* --------------------------------------------------------------------------- */

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
  for (const folder of ["competitor-tracking-report", "_shared"]) {
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

/* --------------------------------------------------------------------------- */
/* The tests                                                                     */
/* --------------------------------------------------------------------------- */

Deno.test("the actual registered route reads as the verified caller", async () => {
  const probe = newProbe();
  probe.rpc = { data: await capturedProjection(), error: null };

  const handler = await loadRoute(probe);
  const response = await handler(
    request({
      action: "detail",
      watchlist_id: WATCHLIST_ID,
      period_days: 7,
    }),
  );

  assertEquals(response.status, 200);
  const payload = await body(response);
  assertEquals(payload.version, 1);
  assertEquals(payload.capture_timezone, "Asia/Kuwait");
  assertEquals(payload.next_cursor, null);

  // The owner RPC ran on the PUBLIC key, with the caller's own bearer.
  assertEquals(probe.rpcCalls.length, 1);
  const call = probe.rpcCalls[0]!;
  assertEquals(call.name, "read_own_competitor_tracking_report");
  assertEquals(call.key, ANON_KEY);
  assertEquals(call.authorization, `Bearer ${BEARER}`);
  assertEquals(call.args.p_request, {
    action: "detail",
    watchlist_id: WATCHLIST_ID,
    period_days: 7,
    limit: 20,
  });

  // The claim verification used the same bearer, unchanged.
  assertEquals(probe.claimTokens.length, 1);
  assertEquals(probe.claimTokens[0], BEARER);

  // No service-role client was ever built.
  for (const client of probe.clients) {
    assertEquals(client.key, ANON_KEY);
  }
});

Deno.test("the actual registered route refuses the service role", async () => {
  const probe = newProbe();
  const handler = await loadRoute(probe);

  const response = await handler(
    request(
      { action: "list", state: "active" },
      { Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    ),
  );

  assertEquals(response.status, 403);
  assertEquals((await body(response)).error, { code: "UNAUTHORIZED" });
  assertEquals(probe.rpcCalls.length, 0);
});

Deno.test("the actual registered route refuses an anonymous caller", async () => {
  const probe = newProbe();
  const handler = await loadRoute(probe);

  const response = await handler(
    new Request("https://api.postora.invalid/functions/v1/competitor-tracking-report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "list", state: "active" }),
    }),
  );

  assertEquals(response.status, 401);
  assertEquals((await body(response)).error, { code: "UNAUTHORIZED" });
  assertEquals(probe.rpcCalls.length, 0);
});

Deno.test("the actual registered route refuses a method other than POST", async () => {
  const probe = newProbe();
  const handler = await loadRoute(probe);

  const response = await handler(
    new Request("https://api.postora.invalid/functions/v1/competitor-tracking-report", {
      method: "GET",
      headers: { Authorization: `Bearer ${BEARER}` },
    }),
  );

  assertEquals(response.status, 405);
  assertEquals(probe.rpcCalls.length, 0);
});

Deno.test("the actual registered route refuses an unknown body key", async () => {
  const probe = newProbe();
  const handler = await loadRoute(probe);

  const response = await handler(
    request({ action: "list", state: "active", user_id: OWNER_ID }),
  );

  assertEquals(response.status, 400);
  assertEquals((await body(response)).error, { code: "INVALID_REQUEST" });
  assertEquals(probe.rpcCalls.length, 0);
});

Deno.test("the actual registered route maps a missing entry onto a 404", async () => {
  const probe = newProbe();
  probe.rpc = {
    data: null,
    error: {
      code: "P0002",
      message: "COMPETITOR_REPORT_NOT_FOUND: the competitor tracking report has no such entry",
    },
  };

  const handler = await loadRoute(probe);
  const response = await handler(
    request({
      action: "detail",
      watchlist_id: WATCHLIST_ID,
      period_days: 7,
    }),
  );

  assertEquals(response.status, 404);
  assertEquals((await body(response)).error, { code: "NOT_FOUND" });
});

Deno.test("the actual registered route never leaks the driver text", async () => {
  const probe = newProbe();
  probe.rpc = {
    data: null,
    error: {
      code: "42501",
      message: "permission denied for table competitor_watchlist",
    },
  };

  const handler = await loadRoute(probe);
  const response = await handler(request({ action: "list", state: "active" }));
  const text = await response.text();

  assertEquals(text.includes("competitor_watchlist"), false);
  assertEquals(text.includes("42501"), false);
  assertEquals(text.includes("permission denied"), false);
});

Deno.test("the relocated route still reads", async () => {
  const functionsRoot = await copyWithMutation(() => undefined);

  const probe = newProbe();
  probe.rpc = { data: await capturedProjection(), error: null };

  const handler = await loadRoute(probe, functionsRoot);
  const response = await handler(
    request({
      action: "detail",
      watchlist_id: WATCHLIST_ID,
      period_days: 7,
    }),
  );

  assertEquals(response.status, 200);
  const payload = await body(response);
  assertEquals(payload.version, 1);
  assertEquals(probe.rpcCalls.length, 1);
  assertEquals(probe.rpcCalls[0]!.authorization, `Bearer ${BEARER}`);
});

Deno.test("a copy that swaps the caller identity is refused and never reads", async () => {
  const functionsRoot = await copyWithMutation((root) => {
    replaceInFile(
      join(root, "competitor-tracking-report/index.ts"),
      "headers: { Authorization: `Bearer ${verifiedBearer}` },",
      'headers: { Authorization: "Bearer synthetic-anon-key" },',
    );
  });

  const probe = newProbe();
  probe.rpc = { data: await capturedProjection(), error: null };

  const handler = await loadRoute(probe, functionsRoot);
  const response = await handler(request({ action: "list", state: "active" }));

  // The statement really ran, with the SWAPPED identity, and the database
  // refused it. The endpoint never reports a read.
  const call = probe.rpcCalls.find((entry) => entry.name === "read_own_competitor_tracking_report");
  assert(call !== undefined);
  assertEquals(call.authorization, "Bearer synthetic-anon-key");

  assertEquals(response.status, 401);
  const payload = await body(response);
  assertEquals(payload.error, { code: "UNAUTHORIZED" });
  assertEquals(payload.version, undefined);
  assertEquals(payload.entries, undefined);
});

Deno.test("a copy whose route no longer reaches the handler answers 404", async () => {
  const functionsRoot = await copyWithMutation((root) => {
    replaceInFile(
      join(root, "competitor-tracking-report/index.ts"),
      "Deno.serve((request: Request) => handler(request));",
      'Deno.serve(() => new Response("not found", { status: 404 }));',
    );
  });

  const probe = newProbe();
  const handler = await loadRoute(probe, functionsRoot);

  const response = await handler(request({ action: "list", state: "active" }));

  assertEquals(response.status, 404);
  assertEquals(probe.rpcCalls.length, 0);
});
