/**
 * The ACTUAL registered `instagram-insights-sync` route.
 *
 * WHAT THIS SUITE IS
 *
 *   It loads the real `supabase/functions/instagram-insights-sync/index.ts`,
 *   lets it register its handler through `Deno.serve`, and drives real
 *   requests through it. It is NOT a copy of the dispatch: a broken copy of
 *   the route fails this suite.
 *
 *   Only the INFRASTRUCTURE is faked. The Supabase client is replaced, so
 *   the HTTP composition is observable: which key was supplied, which
 *   Authorization header was sent, and which function was called. Everything
 *   else is the production code: the request contract, the claim validation,
 *   the gates, the deadlines, the store, the projection parsing and the
 *   response mapping.
 *
 *   The fake is a behavioral HTTP client composition control. It is not a
 *   Postgres session and it does not see PostgREST. The answer it gives an
 *   owner RPC follows the Authorization bearer. The apikey alone is not
 *   that role: changing only the apikey does not stand in for `auth.uid()`
 *   and is not the `service_role` EXECUTE denial, which is proved against
 *   Postgres separately. The contract still requires the public key together
 *   with the same verified bearer, and the positive case asserts both.
 *
 * THE RELOCATION AND THE MUTATIONS
 *
 *   Three proofs run against COPIES of the source tree. The repository
 *   source is never modified:
 *
 *     - the relocated positive: the same route, copied to another directory,
 *       still enqueues and still reads a status;
 *     - the broken identity copy: a copy whose owner RPC replaces the
 *       verified bearer with a service Authorization identity is refused
 *       and never reports an enqueue;
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

const BUNDLE_DIR = Deno.makeTempDirSync({ prefix: "postora-owner-intake-handler-" });
const COPY_DIR = Deno.makeTempDirSync({ prefix: "postora-owner-intake-copy-" });

const SUPABASE_URL = "https://api.postora.invalid";
const ANON_KEY = "synthetic-anon-key";
const SERVICE_ROLE_KEY = "synthetic-service-role-key";
const OWNER_ID = "0f100001-0000-4000-8000-000000000001";
const ACCOUNT_ID = "0f1a0002-0000-4000-8000-000000000012";
const BEARER = "synthetic.owner.bearer";
const CAPTURED_ON = "2026-10-28";

interface Probe {
  clients: Array<{ url: string; key: string; authorization: string | null }>;
  claimTokens: string[];
  rpcCalls: Array<{
    name: string;
    args: Record<string, unknown>;
    key: string;
    authorization: string | null;
  }>;
  settingReads: Array<{ settingKey: string; clientKey: string }>;
  inserts: Array<{ table: string; row: Record<string, unknown>; clientKey: string }>;
  claims: unknown;
  rpc: unknown;
  appSettings: Record<string, unknown>;
}

function newProbe(): Probe {
  return {
    clients: [],
    claimTokens: [],
    rpcCalls: [],
    settingReads: [],
    inserts: [],
    claims: { data: { claims: { sub: OWNER_ID, role: "authenticated" } }, error: null },
    rpc: {
      data: {
        accepted: true,
        reason: "enqueued",
        job_id: "5c1b0003-0000-4000-8000-000000000003",
        job_generation: 1,
        status: "queued",
        captured_on: CAPTURED_ON,
        created: true,
        accepted_at: "2026-10-28T07:00:00+00:00",
      },
      error: null,
    },
    appSettings: {
      collection_instagram_insights_enabled: { data: { value: true }, error: null },
      credential_facebook_user_mode: { data: { value: "protected" }, error: null },
    },
  };
}

const STUB_SOURCE = `
export function createClient(url, key, options) {
  const probe = globalThis.__postoraOwnerIntakeProbe;
  const headers = options && options.global && options.global.headers ? options.global.headers : {};
  const authorization = headers.Authorization ? headers.Authorization : null;
  probe.clients.push({ url, key, authorization });

  const from = (table) => {
    let selectedKey = null;
    const builder = {
      select() { return builder; },
      eq(_column, value) { selectedKey = value; return builder; },
      async maybeSingle() {
        probe.settingReads.push({ settingKey: selectedKey, clientKey: key });
        const row = probe.appSettings[selectedKey];
        return row ? row : { data: null, error: null };
      },
      async insert(row) {
        probe.inserts.push({ table, row, clientKey: key });
        return { data: null, error: null };
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
      // Authorization value is refused. The apikey is recorded and is not
      // the role.
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
          // The real Zod is resolved by Deno at import time. The bundle keeps
          // the npm specifier, so the production validator is the production
          // validator.
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
  const globals = globalThis as { __postoraOwnerIntakeProbe?: Probe };
  globals.__postoraOwnerIntakeProbe = probe;

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
    const outfile = await bundle("instagram-insights-sync/index.ts", functionsRoot);
    await import(`${pathToFileURL(outfile).href}?case=${++importSeq}`);
  } finally {
    Deno.serve = previousServe;
  }

  if (!handler) throw new Error("instagram-insights-sync did not register a request handler");
  return handler as RouteHandler;
}

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://api.postora.invalid/functions/v1/instagram-insights-sync", {
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

/**
 * Copies the source tree into an isolated directory and applies one
 * mutation. The repository source is never touched.
 */
async function copyWithMutation(
  mutate: (functionsRoot: string) => void,
): Promise<string> {
  const target = `${COPY_DIR}/copy-${++copySeq}`;
  await Deno.mkdir(`${target}/supabase/functions`, { recursive: true });
  for (const folder of ["instagram-insights-sync", "_shared"]) {
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

async function sha256(path: string): Promise<string> {
  const bytes = await Deno.readFile(path);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const SOURCE_FILES = [
  join(FUNCTIONS_ROOT, "instagram-insights-sync/index.ts"),
  join(FUNCTIONS_ROOT, "instagram-insights-sync/handler.ts"),
  join(FUNCTIONS_ROOT, "instagram-insights-sync/store.ts"),
];

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

Deno.test("the actual registered route enqueues as the verified caller", async () => {
  const probe = newProbe();
  const handler = await loadRoute(probe);

  const response = await handler(
    request({ action: "enqueue", social_account_id: ACCOUNT_ID }),
  );
  assertEquals(response.status, 202);
  assertEquals((await body(response)).accepted, true);

  // The owner RPC ran on the PUBLIC key, with the caller's own bearer, and
  // with the fixed owner target kind.
  assertEquals(probe.rpcCalls.length, 1);
  const call = probe.rpcCalls[0]!;
  assertEquals(call.name, "enqueue_instagram_collection_job");
  assertEquals(call.key, ANON_KEY);
  assertEquals(call.authorization, `Bearer ${BEARER}`);
  assertEquals(call.args, {
    p_target_kind: "owner",
    p_target_id: ACCOUNT_ID,
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
      target_kind: "owner",
      target_id: ACCOUNT_ID,
      captured_on: CAPTURED_ON,
      status: "partial",
      job_generation: 3,
      attempts: 2,
      due_at: "2026-10-28T07:00:00+00:00",
      next_retry_at: null,
      last_attempt_at: "2026-10-28T07:00:00+00:00",
      last_partial_at: "2026-10-28T07:00:00+00:00",
      last_success_at: null,
      reason_code: "provider_throttled",
      inventory: {
        truncated: false,
        partial: false,
        window_covered: true,
        oldest_returned_at: "2026-10-28T07:00:00+00:00",
        gap_reason: null,
        pages_fetched: 4,
      },
      pending_operations: 7,
    },
    error: null,
  };

  const handler = await loadRoute(probe);
  const response = await handler(
    request({ action: "status", social_account_id: ACCOUNT_ID }),
  );

  assertEquals(response.status, 200);
  const payload = await body(response);
  assertEquals(payload.pending_operations, 7);
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
      captured_on: CAPTURED_ON,
    },
    error: null,
  };

  const handler = await loadRoute(probe);
  const response = await handler(
    request({ action: "enqueue", social_account_id: ACCOUNT_ID }),
  );

  assertEquals(response.status, 429);
  assertEquals(response.headers.get("Retry-After"), "120");
  assertEquals(probe.rpcCalls.length, 1);
});

Deno.test("the actual registered route refuses a missing target with one 404", async () => {
  const probe = newProbe();
  probe.rpc = { data: null, error: { code: "P0002" } };

  const handler = await loadRoute(probe);
  const response = await handler(
    request({ action: "status", social_account_id: ACCOUNT_ID }),
  );

  assertEquals(response.status, 404);
  assertEquals((await body(response)).error, "not_found");
});

Deno.test("the actual registered route refuses an unauthenticated caller", async () => {
  const probe = newProbe();
  probe.claims = { data: null, error: { message: "invalid jwt" } };

  const handler = await loadRoute(probe);
  const response = await handler(
    request({ action: "status", social_account_id: ACCOUNT_ID }),
  );

  assertEquals(response.status, 401);
  assertEquals(probe.rpcCalls.length, 0);
});

Deno.test("the actual registered route refuses a service identity", async () => {
  const probe = newProbe();
  probe.claims = {
    data: { claims: { sub: OWNER_ID, role: "service_role" } },
    error: null,
  };

  const handler = await loadRoute(probe);
  const response = await handler(
    request({ action: "status", social_account_id: ACCOUNT_ID }),
  );

  assertEquals(response.status, 401);
  assertEquals(probe.rpcCalls.length, 0);
});

Deno.test("the actual registered route refuses a disabled collection before any owner work", async () => {
  const probe = newProbe();
  probe.appSettings = {
    collection_instagram_insights_enabled: { data: null, error: null },
    credential_facebook_user_mode: { data: { value: "protected" }, error: null },
  };

  const handler = await loadRoute(probe);
  const response = await handler(
    request({ action: "status", social_account_id: ACCOUNT_ID }),
  );

  assertEquals(response.status, 503);
  assertEquals((await body(response)).error, "collection_disabled");
  assertEquals(probe.rpcCalls.length, 0);
  assertEquals(probe.settingReads.length, 1);
});

Deno.test("the actual registered route does not refuse a legacy credential mode", async () => {
  // The global credential mode says WHERE a Facebook User secret is read
  // from. It is not collection permission, so a readable `legacy` mode no
  // longer refuses the request.
  const probe = newProbe();
  probe.appSettings = {
    collection_instagram_insights_enabled: { data: { value: true }, error: null },
    credential_facebook_user_mode: { data: { value: "legacy" }, error: null },
  };
  probe.rpc = {
    data: {
      target_kind: "owner",
      target_id: ACCOUNT_ID,
      captured_on: CAPTURED_ON,
      status: "partial",
      job_generation: 3,
      attempts: 2,
      due_at: "2026-10-28T07:00:00+00:00",
      next_retry_at: null,
      last_attempt_at: "2026-10-28T07:00:00+00:00",
      last_partial_at: "2026-10-28T07:00:00+00:00",
      last_success_at: null,
      reason_code: "provider_throttled",
      inventory: {
        truncated: false,
        partial: false,
        window_covered: true,
        oldest_returned_at: "2026-10-28T07:00:00+00:00",
        gap_reason: null,
        pages_fetched: 4,
      },
      pending_operations: 7,
    },
    error: null,
  };

  const handler = await loadRoute(probe);
  const response = await harnessRequest(handler);

  assertEquals(response.status, 200);
  assertEquals(probe.rpcCalls.length, 1);
  assertEquals(probe.rpcCalls[0]!.name, "read_instagram_collection_job_status");
});

async function harnessRequest(handler: RouteHandler): Promise<Response> {
  return await handler(request({ action: "status", social_account_id: ACCOUNT_ID }));
}

// ---------------------------------------------------------------------------
// Raw driver envelopes, through the registered root
// ---------------------------------------------------------------------------

const ACCEPTED_DATA = {
  accepted: true,
  reason: "enqueued",
  job_id: "5c1b0003-0000-4000-8000-000000000003",
  job_generation: 1,
  status: "queued",
  captured_on: CAPTURED_ON,
  created: true,
  accepted_at: "2026-10-28T07:00:00+00:00",
};

function installGetter(
  record: object,
  key: string,
  value: unknown,
  hits: { count: number },
): void {
  Object.defineProperty(record, key, {
    enumerable: true,
    configurable: true,
    get() {
      hits.count += 1;
      return value;
    },
  });
}

async function posted(probe: Probe, handlerBody: unknown = {
  action: "enqueue",
  social_account_id: ACCOUNT_ID,
}): Promise<{ status: number; payload: Record<string, unknown> }> {
  const handler = await loadRoute(probe);
  const response = await handler(request(handlerBody));
  return { status: response.status, payload: await body(response) };
}

Deno.test("raw falsy RPC and setting errors are not an explicit null", async () => {
  for (const value of [undefined, false, 0, ""]) {
    const rpcProbe = newProbe();
    rpcProbe.rpc = { data: ACCEPTED_DATA, error: value };
    const rpc = await posted(rpcProbe);
    assertEquals(rpc.status, 503, `rpc error ${String(value)}`);
    assertEquals(rpc.payload.error, "enqueue_indeterminate");
    assertEquals(rpcProbe.rpcCalls.length, 1);

    const settingProbe = newProbe();
    settingProbe.appSettings = {
      collection_instagram_insights_enabled: { data: { value: true }, error: value },
      credential_facebook_user_mode: { data: { value: "protected" }, error: null },
    };
    const setting = await posted(settingProbe);
    assertEquals(setting.status, 503, `setting error ${String(value)}`);
    assertEquals(setting.payload.error, "settings_unavailable");
    assertEquals(settingProbe.rpcCalls.length, 0);
  }
});

Deno.test("raw missing error fields stay unavailable", async () => {
  const rpcProbe = newProbe();
  rpcProbe.rpc = { data: ACCEPTED_DATA };
  const rpc = await posted(rpcProbe);
  assertEquals(rpc.status, 503);
  assertEquals(rpc.payload.error, "enqueue_indeterminate");
  assertEquals(rpcProbe.rpcCalls.length, 1);

  const settingProbe = newProbe();
  settingProbe.appSettings = {
    collection_instagram_insights_enabled: { data: { value: true } },
  };
  const setting = await posted(settingProbe);
  assertEquals(setting.status, 503);
  assertEquals(setting.payload.error, "settings_unavailable");
  assertEquals(settingProbe.rpcCalls.length, 0);

  const absentProbe = newProbe();
  absentProbe.appSettings = {
    collection_instagram_insights_enabled: { data: null },
  };
  const absent = await posted(absentProbe);
  assertEquals(absent.status, 503);
  assertEquals(absent.payload.error, "settings_unavailable");
  assertEquals(absentProbe.rpcCalls.length, 0);
  assertEquals(absentProbe.settingReads.length, 1);
});

Deno.test("raw accessor envelopes are refused without running the getter", async () => {
  const hits = { count: 0 };

  const rpcData = newProbe();
  const rpcDataEnvelope = { data: ACCEPTED_DATA, error: null };
  installGetter(rpcDataEnvelope, "data", ACCEPTED_DATA, hits);
  rpcData.rpc = rpcDataEnvelope;
  const rpcDataResult = await posted(rpcData);
  assertEquals(rpcDataResult.status, 503);
  assertEquals(rpcDataResult.payload.error, "enqueue_indeterminate");

  const rpcError = newProbe();
  const rpcErrorEnvelope = { data: ACCEPTED_DATA, error: null };
  installGetter(rpcErrorEnvelope, "error", null, hits);
  rpcError.rpc = rpcErrorEnvelope;
  const rpcErrorResult = await posted(rpcError);
  assertEquals(rpcErrorResult.status, 503);
  assertEquals(rpcErrorResult.payload.error, "enqueue_indeterminate");

  const settingData = newProbe();
  const settingDataEnvelope = { data: { value: true }, error: null };
  installGetter(settingDataEnvelope, "data", { value: true }, hits);
  settingData.appSettings = {
    collection_instagram_insights_enabled: settingDataEnvelope,
  };
  const settingDataResult = await posted(settingData);
  assertEquals(settingDataResult.status, 503);
  assertEquals(settingDataResult.payload.error, "settings_unavailable");
  assertEquals(settingData.rpcCalls.length, 0);

  const settingError = newProbe();
  const settingErrorEnvelope = { data: { value: true }, error: null };
  installGetter(settingErrorEnvelope, "error", null, hits);
  settingError.appSettings = {
    collection_instagram_insights_enabled: settingErrorEnvelope,
  };
  const settingErrorResult = await posted(settingError);
  assertEquals(settingErrorResult.status, 503);
  assertEquals(settingErrorResult.payload.error, "settings_unavailable");
  assertEquals(settingError.rpcCalls.length, 0);

  const authData = newProbe();
  const authDataEnvelope = {
    data: { claims: { sub: OWNER_ID, role: "authenticated" } },
    error: null,
  };
  installGetter(
    authDataEnvelope,
    "data",
    { claims: { sub: OWNER_ID, role: "authenticated" } },
    hits,
  );
  authData.claims = authDataEnvelope;
  const authDataResult = await posted(authData);
  assertEquals(authDataResult.status, 401);
  assertEquals(authDataResult.payload.error, "unauthorized");
  assertEquals(authData.rpcCalls.length, 0);

  const authError = newProbe();
  const authErrorEnvelope = {
    data: { claims: { sub: OWNER_ID, role: "authenticated" } },
    error: null,
  };
  installGetter(authErrorEnvelope, "error", null, hits);
  authError.claims = authErrorEnvelope;
  const authErrorResult = await posted(authError);
  assertEquals(authErrorResult.status, 401);
  assertEquals(authErrorResult.payload.error, "unauthorized");
  assertEquals(authError.rpcCalls.length, 0);

  assertEquals(hits.count, 0);
});

Deno.test("raw inherited envelopes are refused", async () => {
  const rpcProbe = newProbe();
  rpcProbe.rpc = Object.create({ data: ACCEPTED_DATA, error: null });
  const rpc = await posted(rpcProbe);
  assertEquals(rpc.status, 503);
  assertEquals(rpc.payload.error, "enqueue_indeterminate");
  assertEquals(rpcProbe.rpcCalls.length, 1);

  const settingProbe = newProbe();
  settingProbe.appSettings = {
    collection_instagram_insights_enabled: Object.create({
      data: { value: true },
      error: null,
    }),
  };
  const setting = await posted(settingProbe);
  assertEquals(setting.status, 503);
  assertEquals(setting.payload.error, "settings_unavailable");
  assertEquals(settingProbe.rpcCalls.length, 0);

  const authProbe = newProbe();
  authProbe.claims = Object.create({
    data: { claims: { sub: OWNER_ID, role: "authenticated" } },
    error: null,
  });
  const auth = await posted(authProbe);
  assertEquals(auth.status, 401);
  assertEquals(auth.payload.error, "unauthorized");
  assertEquals(authProbe.rpcCalls.length, 0);
});

Deno.test("a failure envelope without its own data field is indeterminate", async () => {
  const probe = newProbe();
  probe.rpc = { error: { code: "P0002" } };
  const result = await posted(probe);

  assertEquals(result.status, 503);
  assertEquals(result.payload.error, "enqueue_indeterminate");
  assertEquals(probe.rpcCalls.length, 1);
});

Deno.test("a failure envelope whose data is an accessor is indeterminate", async () => {
  const hits = { count: 0 };
  const envelope = { error: { code: "P0002" } };
  installGetter(envelope, "data", null, hits);
  const probe = newProbe();
  probe.rpc = envelope;
  const result = await posted(probe);

  assertEquals(result.status, 503);
  assertEquals(result.payload.error, "enqueue_indeterminate");
  assertEquals(hits.count, 0);
  assertEquals(probe.rpcCalls.length, 1);
});

Deno.test("a failure envelope with only inherited data is indeterminate", async () => {
  const probe = newProbe();
  probe.rpc = Object.assign(Object.create({ data: null }), {
    error: { code: "P0002" },
  });
  const result = await posted(probe);

  assertEquals(result.status, 503);
  assertEquals(result.payload.error, "enqueue_indeterminate");
  assertEquals(probe.rpcCalls.length, 1);
});

Deno.test("an accessor SQLSTATE is not a definitive not-found", async () => {
  const hits = { count: 0 };
  const error = {};
  installGetter(error, "code", "P0002", hits);
  const probe = newProbe();
  probe.rpc = { data: null, error };
  const result = await posted(probe);

  assertEquals(result.status, 503);
  assertEquals(result.payload.error, "enqueue_indeterminate");
  assertEquals(hits.count, 0);
  assertEquals(probe.rpcCalls.length, 1);
});

Deno.test("an own SQLSTATE still keeps its own meaning", async () => {
  const notFound = newProbe();
  notFound.rpc = { data: null, error: { code: "P0002", message: "secret sql" } };
  const missing = await posted(notFound, { action: "status", social_account_id: ACCOUNT_ID });
  assertEquals(missing.status, 404);
  assertEquals(missing.payload.error, "not_found");
  assertEquals(JSON.stringify(missing.payload).includes("secret"), false);

  const refused = newProbe();
  refused.rpc = { data: null, error: { code: "22023", hint: "secret sql" } };
  const bad = await posted(refused);
  assertEquals(bad.status, 400);
  assertEquals(bad.payload.error, "invalid_request");
  assertEquals(JSON.stringify(bad.payload).includes("secret"), false);

  const denied = newProbe();
  denied.rpc = { data: null, error: { code: "42501", details: "secret sql" } };
  const role = await posted(denied);
  assertEquals(role.status, 401);
  assertEquals(role.payload.error, "unauthorized");
  assertEquals(JSON.stringify(role.payload).includes("secret"), false);
});

Deno.test("an oversized body is 413 when cancellation never settles", async () => {
  const probe = newProbe();
  const handler = await loadRoute(probe);
  const started = Date.now();
  const response = await handler(new Request(
    "https://api.postora.invalid/functions/v1/instagram-insights-sync",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${BEARER}` },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(4097));
        },
        cancel() {
          return new Promise(() => undefined);
        },
      }),
      duplex: "half",
    } as RequestInit,
  ));
  const elapsed = Date.now() - started;

  assertEquals(response.status, 413);
  assertEquals((await body(response)).error, "payload_too_large");
  assertEquals(probe.rpcCalls.length, 0);
  assertEquals(probe.claimTokens.length, 0);
  assert(elapsed < 1_000);
});

// ---------------------------------------------------------------------------
// The relocation and the mutations
// ---------------------------------------------------------------------------

Deno.test("the relocated route still enqueues and still reads a status", async () => {
  const functionsRoot = await copyWithMutation(() => undefined);
  const probe = newProbe();
  const handler = await loadRoute(probe, functionsRoot);

  const enqueued = await handler(
    request({ action: "enqueue", social_account_id: ACCOUNT_ID }),
  );
  assertEquals(enqueued.status, 202);
  assertEquals(probe.rpcCalls[0]!.key, ANON_KEY);
  assertEquals(probe.rpcCalls[0]!.authorization, `Bearer ${BEARER}`);

  const statusProbe = newProbe();
  statusProbe.rpc = {
    data: {
      target_kind: "owner",
      target_id: ACCOUNT_ID,
      captured_on: CAPTURED_ON,
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

  const statusHandler = await loadRoute(statusProbe, functionsRoot);
  const read = await statusHandler(
    request({ action: "status", social_account_id: ACCOUNT_ID }),
  );
  assertEquals(read.status, 200);
  const payload = await body(read);
  assertEquals(payload.status, "none");
  assertEquals("pending_operations" in payload, false);
});

Deno.test("a copy that changes only the apikey still runs as the verified bearer", async () => {
  const functionsRoot = await copyWithMutation((root) => {
    replaceInFile(
      join(root, "instagram-insights-sync/index.ts"),
      `    const client = createClient(environment.url, environment.anonKey, {
      global: {
        headers: { Authorization: \`Bearer \${verifiedToken}\` },`,
      `    const client = createClient(environment.url, environment.serviceRoleKey, {
      global: {
        headers: { Authorization: \`Bearer \${verifiedToken}\` },`,
    );
  });

  const probe = newProbe();
  const handler = await loadRoute(probe, functionsRoot);
  const response = await handler(
    request({ action: "enqueue", social_account_id: ACCOUNT_ID }),
  );

  // The verified user request still carries the verified bearer, so this
  // HTTP composition control accepts it. The apikey change is visible and
  // is not treated as a Postgres role change.
  assertEquals(response.status, 202);
  assertEquals(probe.rpcCalls.length, 1);
  assertEquals(probe.rpcCalls[0]!.key, SERVICE_ROLE_KEY);
  assertEquals(probe.rpcCalls[0]!.authorization, `Bearer ${BEARER}`);
});

Deno.test("a copy that replaces the verified bearer never enqueues", async () => {
  const functionsRoot = await copyWithMutation((root) => {
    replaceInFile(
      join(root, "instagram-insights-sync/index.ts"),
      "headers: { Authorization: `Bearer ${verifiedToken}` },",
      "headers: { Authorization: `Bearer ${environment.serviceRoleKey}` },",
    );
  });

  const probe = newProbe();
  const handler = await loadRoute(probe, functionsRoot);
  const response = await handler(
    request({ action: "enqueue", social_account_id: ACCOUNT_ID }),
  );

  // Same verified-user request as the positive case. The copy sends a
  // service Authorization identity instead of that bearer, so the call is
  // refused. The public key is still the one the client was built with.
  const payload = await body(response);
  assertEquals(response.status, 401);
  assertEquals(payload.error, "unauthorized");
  assertEquals(payload.accepted, undefined);
  assertEquals(probe.rpcCalls.length, 1);
  assertEquals(probe.rpcCalls[0]!.key, ANON_KEY);
  assertEquals(probe.rpcCalls[0]!.authorization, `Bearer ${SERVICE_ROLE_KEY}`);
});

Deno.test("a copy whose route no longer reaches the handler answers 404", async () => {
  const functionsRoot = await copyWithMutation((root) => {
    replaceInFile(
      join(root, "instagram-insights-sync/index.ts"),
      "Deno.serve((request: Request) => handler(request));",
      `Deno.serve((_request: Request) => new Response("not-routed", { status: 404 }));`,
    );
  });

  const probe = newProbe();
  const handler = await loadRoute(probe, functionsRoot);
  const response = await handler(
    request({ action: "enqueue", social_account_id: ACCOUNT_ID }),
  );

  assertEquals(response.status, 404);
  assertEquals(probe.rpcCalls.length, 0);
});

Deno.test("the repository source is unchanged by the relocation and the mutations", async () => {
  const before = await Promise.all(SOURCE_FILES.map((path) => sha256(path)));

  await copyWithMutation(() => undefined);
  await copyWithMutation((root) => {
    replaceInFile(
      join(root, "instagram-insights-sync/index.ts"),
      "Deno.serve((request: Request) => handler(request));",
      `Deno.serve((_request: Request) => new Response("not-routed", { status: 404 }));`,
    );
  });

  const after = await Promise.all(SOURCE_FILES.map((path) => sha256(path)));
  assertEquals(after, before);
  assert(before.every((hash) => hash.length === 64));
});
