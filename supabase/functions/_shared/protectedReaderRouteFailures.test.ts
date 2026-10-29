/**
 * Actual ad-analytics and facebook-places-search handlers.
 *
 * The bundle is built from the supabase/functions tree that contains this
 * file, and esbuild is resolved from that tree's package.json. A relocated
 * copy therefore exercises its own routes. Only auth, Supabase, and fetch are
 * faked. Deno.makeTempDir follows the process temp directory.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testFilePath = fileURLToPath(import.meta.url);
const functionsRoot = dirname(dirname(testFilePath));
const repoRoot = dirname(dirname(functionsRoot));
const packageJsonPath = join(repoRoot, "package.json");
const require = createRequire(packageJsonPath);
const { build } = require("esbuild") as {
  build: (options: {
    entryPoints: string[];
    bundle: boolean;
    format: "esm";
    platform: "node";
    outfile: string;
    logLevel: "silent";
    plugins: unknown[];
  }) => Promise<unknown>;
};

const bundleDir = Deno.makeTempDirSync({ prefix: "postora-reader-route-" });
const USER_ID = "b0000000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "a0000000-0000-4000-8000-000000000001";
const SECRET = "synthetic-reader-transport-secret";
const PAGE_TOKEN = "synthetic-page-token";
const METADATA_TOKEN = "synthetic-metadata-token";
const RPC_TOKEN = "synthetic-rpc-token";

const ENV_KEYS = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"] as const;

type RpcKind =
  | "omit-error"
  | "error-undefined"
  | "error-false"
  | "error-null"
  | "prototype"
  | "data-missing"
  | "data-undefined"
  | "data-null";

type AccountRead = "ok" | "throw" | "driver-error";
type RouteName = "ad-analytics" | "facebook-places-search";
type RouteHandler = (request: Request) => Promise<Response> | Response;

interface ProbeState {
  mode: "protected" | "absent";
  rpcKind: RpcKind;
  accountRead: AccountRead;
  /** Authority rows the per-account cutover read sees (existence columns). */
  authorities: Array<{ social_account_id: string; user_id: string }>;
  /** Every authority-table select and the columns it asked for. */
  authorityReads: Array<{ table: string; columns: string }>;
  http: string[];
  rpc: string[];
  mutations: string[];
  logs: string[];
  client: ReturnType<typeof createClient>;
}

function credentialData(): Record<string, unknown> {
  return {
    found: true,
    social_account_id: ACCOUNT_ID,
    platform: "facebook",
    credential_id: "33333333-3333-4333-8333-333333333333",
    credential_kind: "facebook_user",
    token: RPC_TOKEN,
    token_expires_at: null,
    revision: 1,
    capability_generation: null,
    connection_version: 1,
  };
}

function rpcEnvelope(kind: RpcKind): unknown {
  const data = credentialData();
  switch (kind) {
    case "omit-error":
      return { data };
    case "error-undefined":
      return { data, error: undefined };
    case "error-false":
      return { data, error: false };
    case "error-null":
      return { data, error: null };
    case "prototype":
      return Object.create({ data, error: null });
    case "data-missing":
      return { error: null, leaked: RPC_TOKEN };
    case "data-undefined":
      return { data: undefined, error: null, leaked: RPC_TOKEN };
    case "data-null":
      return { data: null, error: null, leaked: RPC_TOKEN };
  }
}

const AUTHORITY_TABLES = new Set([
  "facebook_user_credential_bindings",
  "instagram_account_credentials",
]);

function createClient(state: ProbeState) {
  class Query {
    private readonly table: string;
    private readonly filters: Record<string, unknown> = {};
    private inValues: unknown[] | null = null;
    private op = "select";

    constructor(table: string) {
      this.table = table;
    }

    select(columns?: string) {
      if (AUTHORITY_TABLES.has(this.table)) {
        state.authorityReads.push({ table: this.table, columns: String(columns ?? "*") });
      }
      return this;
    }

    in(_column: string, values: unknown[]) {
      this.inValues = values;
      return this;
    }

    eq(key: string, value: unknown) {
      this.filters[key] = value;
      return this;
    }

    single() {
      return this;
    }

    maybeSingle() {
      return this;
    }

    insert() {
      this.op = "insert";
      return this;
    }

    update() {
      this.op = "update";
      return this;
    }

    upsert() {
      this.op = "upsert";
      return this;
    }

    delete() {
      this.op = "delete";
      return this;
    }

    then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
      return Promise.resolve().then(() => this.execute()).then(onFulfilled, onRejected);
    }

    private execute(): unknown {
      if (this.op !== "select") {
        state.mutations.push(`${this.table}:${this.op}`);
        return { data: null, error: null };
      }
      if (this.table === "app_settings") {
        if (state.mode === "protected" && this.filters.key === "credential_facebook_user_mode") {
          return { data: { value: "protected" }, error: null };
        }
        return { data: null, error: null };
      }
      if (this.table === "social_accounts") {
        if (state.accountRead === "throw") {
          throw new Error(`synthetic-transport-error access_token=${SECRET}`);
        }
        if (state.accountRead === "driver-error") {
          return { data: null, error: { message: `database read failed ${SECRET}`, code: "57014" } };
        }
        return {
          data: {
            id: ACCOUNT_ID,
            platform: "facebook",
            platform_user_id: "synthetic-fb",
            access_token: PAGE_TOKEN,
            account_metadata: { user_token: METADATA_TOKEN },
          },
          error: null,
        };
      }
      if (AUTHORITY_TABLES.has(this.table)) {
        // Only the binding table carries this synthetic account.
        if (this.table !== "facebook_user_credential_bindings") return { data: [], error: null };
        const rows = state.authorities.filter((row) =>
          !this.inValues || this.inValues.includes(row.social_account_id)
        );
        return { data: rows, error: null };
      }
      throw new Error(`unexpected table ${this.table}`);
    }
  }

  return {
    from: (table: string) => new Query(table),
    rpc: (name: string, _args: Record<string, unknown>) => {
      state.rpc.push(name);
      return Promise.resolve(rpcEnvelope(state.rpcKind));
    },
    auth: {
      getClaims: (_token: string) => Promise.resolve({
        data: { claims: { sub: USER_ID } },
        error: null,
      }),
    },
  };
}

function createState(
  overrides: Partial<Pick<ProbeState, "mode" | "rpcKind" | "accountRead" | "authorities">> = {},
): ProbeState {
  const state = {
    mode: overrides.mode ?? "protected",
    rpcKind: overrides.rpcKind ?? "error-null",
    accountRead: overrides.accountRead ?? "ok",
    authorities: overrides.authorities ?? [],
    authorityReads: [] as ProbeState["authorityReads"],
    http: [] as string[],
    rpc: [] as string[],
    mutations: [] as string[],
    logs: [] as string[],
    client: null as ProbeState["client"] | null,
  };
  const ready = state as ProbeState;
  ready.client = createClient(ready);
  return ready;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  if (!isRecord(value) || !Object.hasOwn(value, key)) return undefined;
  return value[key];
}

function countUrl(state: ProbeState, needle: string): number {
  return state.http.filter((url) => url.includes(needle)).length;
}

function leaked(text: string): boolean {
  return text.includes(SECRET) || text.includes(RPC_TOKEN) || text.includes(PAGE_TOKEN) ||
    text.includes(METADATA_TOKEN);
}

const originalFetch = globalThis.fetch;
const originalServe = Deno.serve;
const originalWarn = console.warn;
const originalError = console.error;
const probeGlobal = globalThis as { __postoraReaderRouteProbe?: ProbeState };

function snapshotEnv(): Map<string, string | undefined> {
  return new Map(ENV_KEYS.map((key) => [key, Deno.env.get(key)]));
}

function restoreEnv(saved: Map<string, string | undefined>) {
  for (const [key, value] of saved) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
}

function restoreProcess(savedEnv: Map<string, string | undefined>) {
  globalThis.fetch = originalFetch;
  Deno.serve = originalServe;
  console.warn = originalWarn;
  console.error = originalError;
  delete probeGlobal.__postoraReaderRouteProbe;
  restoreEnv(savedEnv);
}

function removeBundleDir() {
  try {
    Deno.removeSync(bundleDir, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      originalWarn.call(console, "[reader-route-test] bundle cleanup failed");
    }
  }
}

globalThis.addEventListener("unload", () => {
  restoreProcess(snapshotEnv());
  removeBundleDir();
});

function installRuntime(state: ProbeState) {
  for (const [key, value] of [
    ["SUPABASE_URL", "https://synthetic.invalid"],
    ["SUPABASE_ANON_KEY", "synthetic-anon"],
    ["SUPABASE_SERVICE_ROLE_KEY", "synthetic-service"],
  ] as const) {
    Deno.env.set(key, value);
  }
  probeGlobal.__postoraReaderRouteProbe = state;
  const record = (method: "warn" | "error", args: unknown[]) => {
    state.logs.push(args.map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return `${arg.name} ${arg.message}`;
      try {
        return JSON.stringify(arg);
      } catch {
        return "";
      }
    }).join(" "));
    if (method === "warn") originalWarn.apply(console, args);
    else originalError.apply(console, args);
  };
  console.warn = (...args: unknown[]) => record("warn", args);
  console.error = (...args: unknown[]) => record("error", args);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    state.http.push(requestUrl(input));
    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function adRequest(): Request {
  return new Request("https://synthetic.invalid/functions/v1/ad-analytics", {
    method: "POST",
    headers: {
      Authorization: "Bearer synthetic-user",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "get_ad_accounts", social_account_id: ACCOUNT_ID }),
  });
}

function placesRequest(body: Record<string, unknown>): Request {
  return new Request("https://synthetic.invalid/functions/v1/facebook-places-search", {
    method: "POST",
    headers: {
      Authorization: "Bearer synthetic-user",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const supabaseStub = {
  name: "supabase-port",
  setup(esbuild: {
    onResolve: (
      options: { filter: RegExp },
      callback: (args: { path: string }) => { path: string; namespace: string },
    ) => void;
    onLoad: (
      options: { filter: RegExp; namespace: string },
      callback: () => { contents: string; loader: "js" },
    ) => void;
  }) {
    esbuild.onResolve({ filter: /^https:\/\/esm\.sh\/@supabase\// }, () => ({
      path: "supabase-client",
      namespace: "reader-stub",
    }));
    esbuild.onLoad({ filter: /.*/, namespace: "reader-stub" }, () => ({
      contents: "export const createClient = () => globalThis.__postoraReaderRouteProbe.client;",
      loader: "js",
    }));
  },
};

async function loadHandlers(): Promise<Record<RouteName, RouteHandler>> {
  const savedEnv = snapshotEnv();
  const handlers: Partial<Record<RouteName, RouteHandler>> = {};
  let loading: RouteName = "ad-analytics";
  const captureServe = (handler: RouteHandler): undefined => {
    handlers[loading] = handler;
    return undefined;
  };
  Deno.serve = captureServe as unknown as typeof Deno.serve;
  try {
    for (const route of ["ad-analytics", "facebook-places-search"] as const) {
      const outfile = join(bundleDir, `${route}.mjs`);
      await build({
        entryPoints: [join(functionsRoot, route, "index.ts")],
        bundle: true,
        format: "esm",
        platform: "node",
        outfile,
        logLevel: "silent",
        plugins: [supabaseStub],
      });
      loading = route;
      await import(pathToFileURL(outfile).href);
    }
  } finally {
    restoreProcess(savedEnv);
  }
  const adAnalytics = handlers["ad-analytics"];
  const places = handlers["facebook-places-search"];
  if (!adAnalytics || !places) {
    throw new Error("route handler was not registered from its own function root");
  }
  return { "ad-analytics": adAnalytics, "facebook-places-search": places };
}

const handlers = await loadHandlers();
let tail: Promise<void> = Promise.resolve();

function readerTest(name: string, fn: () => Promise<void>) {
  Deno.test(name, async () => {
    const previous = tail;
    let release: () => void = () => {};
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const savedEnv = snapshotEnv();
    try {
      await fn();
    } finally {
      restoreProcess(savedEnv);
      release();
    }
  });
}

async function withState<T>(state: ProbeState, fn: () => T | Promise<T>): Promise<T> {
  installRuntime(state);
  try {
    return await fn();
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
    globalThis.fetch = originalFetch;
    delete probeGlobal.__postoraReaderRouteProbe;
  }
}

function assertNoLeak(state: ProbeState, body: unknown) {
  const text = JSON.stringify(body) + "\n" + state.logs.join("\n");
  assertEquals(leaked(text), false);
}

async function assertMalformedRpc(kind: RpcKind) {
  const state = createState({ mode: "protected", rpcKind: kind, accountRead: "ok" });
  const response = await withState(state, () => handlers["ad-analytics"](adRequest()));
  const body: unknown = await response.json();
  assertEquals(response.status, 503);
  assertEquals(field(body, "error_code"), "PROTECTED_CREDENTIAL_INVALID");
  assertEquals(field(body, "error"), "The protected credential read was unusable.");
  assertEquals(countUrl(state, "graph.facebook.com"), 0);
  assertEquals(countUrl(state, "nominatim.openstreetmap.org"), 0);
  assertEquals(state.rpc.length, 1);
  assertEquals(state.rpc[0], "read_facebook_user_account_credential");
  assertEquals(state.mutations.length, 0);
  assertNoLeak(state, body);
}

readerTest("a raw rpc envelope with no error property never calls Graph", () => assertMalformedRpc("omit-error"));
readerTest("a raw rpc envelope with error undefined never calls Graph", () => assertMalformedRpc("error-undefined"));
readerTest("a raw rpc envelope with error false never calls Graph", () => assertMalformedRpc("error-false"));
readerTest("a prototype-inherited rpc envelope never calls Graph", () => assertMalformedRpc("prototype"));
readerTest("a raw rpc envelope with missing data never calls Graph", () => assertMalformedRpc("data-missing"));
readerTest("a raw rpc envelope with undefined data never calls Graph", () => assertMalformedRpc("data-undefined"));
readerTest("a raw rpc envelope with null data never calls Graph", () => assertMalformedRpc("data-null"));

readerTest("an explicit null rpc error reaches the provider once", async () => {
  const state = createState({ mode: "protected", rpcKind: "error-null", accountRead: "ok" });
  const response = await withState(state, () => handlers["ad-analytics"](adRequest()));
  const body: unknown = await response.json();
  assertEquals(response.status, 200);
  assertEquals(body, []);
  assertEquals(countUrl(state, "graph.facebook.com"), 1);
  assertEquals(state.http.some((url) => url.includes(RPC_TOKEN)), true);
  assertEquals(state.http.some((url) => url.includes(PAGE_TOKEN) || url.includes(METADATA_TOKEN)), false);
  assertEquals(state.rpc.length, 1);
  assertEquals(state.mutations.length, 0);
  assertEquals(leaked(JSON.stringify(body) + "\n" + state.logs.join("\n")), false);
});

readerTest("a thrown selected-account read is an explicit failure without provider calls", async () => {
  const state = createState({ mode: "protected", rpcKind: "error-null", accountRead: "throw" });
  const response = await withState(state, () => handlers["facebook-places-search"](placesRequest({
    query: "Kuwait",
    account_id: ACCOUNT_ID,
  })));
  const body: unknown = await response.json();
  assertEquals(response.status, 200);
  assertEquals(field(body, "places"), []);
  assertEquals(field(body, "source"), "meta");
  assertEquals(field(body, "error"), "ACCOUNT_READ_FAILED");
  assertEquals(countUrl(state, "graph.facebook.com"), 0);
  assertEquals(countUrl(state, "nominatim.openstreetmap.org"), 0);
  assertEquals(state.rpc.length, 0);
  assertEquals(state.mutations.length, 0);
  assertNoLeak(state, body);
});

readerTest("a returned selected-account error stays an explicit read failure", async () => {
  const state = createState({ mode: "protected", rpcKind: "error-null", accountRead: "driver-error" });
  const response = await withState(state, () => handlers["facebook-places-search"](placesRequest({
    query: "Kuwait",
    account_id: ACCOUNT_ID,
  })));
  const body: unknown = await response.json();
  assertEquals(response.status, 200);
  assertEquals(field(body, "error"), "ACCOUNT_READ_FAILED");
  assertEquals(field(body, "source"), "meta");
  assertEquals(countUrl(state, "graph.facebook.com"), 0);
  assertEquals(countUrl(state, "nominatim.openstreetmap.org"), 0);
  assertEquals(state.rpc.length, 0);
  assertEquals(state.mutations.length, 0);
  assertNoLeak(state, body);
});

readerTest("a protected provider with no usable places falls back to Nominatim", async () => {
  const state = createState({ mode: "protected", rpcKind: "error-null", accountRead: "ok" });
  const response = await withState(state, () => handlers["facebook-places-search"](placesRequest({
    query: "Kuwait",
    account_id: ACCOUNT_ID,
  })));
  const body: unknown = await response.json();
  assertEquals(response.status, 200);
  assertEquals(field(body, "source"), "nominatim");
  assertEquals(field(body, "places"), []);
  assertEquals(countUrl(state, "graph.facebook.com"), 1);
  assertEquals(countUrl(state, "nominatim.openstreetmap.org"), 1);
  assertEquals(state.http.some((url) => url.includes("graph.facebook.com") && url.includes(RPC_TOKEN)), true);
  assertEquals(state.http.some((url) => url.includes(PAGE_TOKEN) || url.includes(METADATA_TOKEN)), false);
  assertEquals(state.rpc.length, 1);
  assertEquals(state.mutations.length, 0);
  assertEquals(leaked(JSON.stringify(body)), false);
});

readerTest("a search without an account uses Nominatim and no Meta credential", async () => {
  const state = createState({ mode: "absent", rpcKind: "error-null", accountRead: "ok" });
  const response = await withState(state, () => handlers["facebook-places-search"](placesRequest({
    query: "Kuwait",
  })));
  const body: unknown = await response.json();
  assertEquals(response.status, 200);
  assertEquals(field(body, "source"), "nominatim");
  assertEquals(field(body, "places"), []);
  assertEquals(countUrl(state, "graph.facebook.com"), 0);
  assertEquals(countUrl(state, "nominatim.openstreetmap.org"), 1);
  assertEquals(state.rpc.length, 0);
  assertEquals(state.mutations.length, 0);
});

readerTest("legacy mode with no provider results still falls back to Nominatim", async () => {
  const state = createState({ mode: "absent", rpcKind: "error-null", accountRead: "ok" });
  const response = await withState(state, () => handlers["facebook-places-search"](placesRequest({
    query: "Kuwait",
    account_id: ACCOUNT_ID,
  })));
  const body: unknown = await response.json();
  assertEquals(response.status, 200);
  assertEquals(field(body, "source"), "nominatim");
  assertEquals(countUrl(state, "graph.facebook.com"), 2);
  assertEquals(countUrl(state, "nominatim.openstreetmap.org"), 1);
  assertEquals(state.http.some((url) => url.includes(METADATA_TOKEN)), true);
  assertEquals(state.http.some((url) => url.includes(PAGE_TOKEN)), true);
  assertEquals(state.http.some((url) => url.includes(RPC_TOKEN)), false);
  assertEquals(state.rpc.length, 0);
  assertEquals(state.mutations.length, 0);
  assertEquals(leaked(JSON.stringify(body)), false);
  // The per-account cutover asked only whether an authority exists.
  assertEquals(state.authorityReads.length > 0, true);
  for (const read of state.authorityReads) {
    assertEquals(read.columns, "social_account_id, user_id");
  }
});

readerTest("legacy mode reads the protected credential for an account that holds an authority", async () => {
  const state = createState({
    mode: "absent",
    rpcKind: "error-null",
    accountRead: "ok",
    authorities: [{ social_account_id: ACCOUNT_ID, user_id: USER_ID }],
  });
  const response = await withState(state, () => handlers["facebook-places-search"](placesRequest({
    query: "Kuwait",
    account_id: ACCOUNT_ID,
  })));
  await response.json();
  assertEquals(response.status, 200);
  // The protected credential, never the metadata copy or the Page token.
  assertEquals(state.rpc.length > 0, true);
  assertEquals(state.http.some((url) => url.includes(RPC_TOKEN)), true);
  assertEquals(state.http.some((url) => url.includes(METADATA_TOKEN)), false);
  assertEquals(state.http.some((url) => url.includes(PAGE_TOKEN)), false);
  assertEquals(state.mutations.length, 0);
});

readerTest("legacy mode ignores an authority row that belongs to another owner", async () => {
  const state = createState({
    mode: "absent",
    rpcKind: "error-null",
    accountRead: "ok",
    authorities: [{ social_account_id: ACCOUNT_ID, user_id: "b0000000-0000-4000-8000-000000000002" }],
  });
  const response = await withState(state, () => handlers["facebook-places-search"](placesRequest({
    query: "Kuwait",
    account_id: ACCOUNT_ID,
  })));
  await response.json();
  assertEquals(state.rpc.length, 0);
  assertEquals(state.http.some((url) => url.includes(METADATA_TOKEN)), true);
});
