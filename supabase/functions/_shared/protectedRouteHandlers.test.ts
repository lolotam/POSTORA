/**
 * Executes the real Edge Function handlers.
 *
 * Each index is bundled with its real credential and refusal modules. Only
 * infrastructure ports are replaced, and the test calls the function that
 * `Deno.serve` registered. A refusal that still reaches provider HTTP, state
 * creation, an account write, or the global health alert fails here.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Route source is the supabase/functions tree that contains this file.
 * esbuild is loaded from that checkout's package.json and node_modules.
 * A copied candidate brings the same install through its own node_modules
 * link, or through npm ci in that checkout. Bundles use the process temp
 * directory.
 */
const testFilePath = fileURLToPath(import.meta.url);
const FUNCTIONS_ROOT = dirname(dirname(testFilePath));
const REPO_ROOT = dirname(dirname(FUNCTIONS_ROOT));
const require = createRequire(join(REPO_ROOT, "package.json"));
const { build } = require("esbuild") as {
  build: (options: Record<string, unknown>) => Promise<unknown>;
};

const BUNDLE_DIR = Deno.makeTempDirSync({ prefix: "postora-route-" });
const SECRET = "EAABwzLixnjYBO7ZBsecretValueThatIsLongEnoughToLookLikeAToken123";
const USER_ID = "b0000000-0000-4000-8000-000000000001";
const FACEBOOK_ID = "a0000000-0000-4000-8000-000000000001";
const TIKTOK_ID = "a0000000-0000-4000-8000-000000000002";
const SIBLING_ID = "a0000000-0000-4000-8000-000000000003";
const DEFERRED_ID = "a0000000-0000-4000-8000-000000000004";
const INSTAGRAM_ID = "a0000000-0000-4000-8000-000000000005";
const PAGE_TOKEN = "page-token-must-not-leak";
const METADATA_TOKEN = "metadata-token-must-not-leak";
const RPC_TOKEN = "rpc-user-token-only";

const ENV: Record<string, string> = {
  SUPABASE_URL: "https://synthetic.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "synthetic-service",
  SUPABASE_ANON_KEY: "synthetic-anon",
  CRON_SECRET: "synthetic-cron",
  FACEBOOK_APP_ID: "synthetic-fb-app",
  FACEBOOK_APP_SECRET: "synthetic-fb-secret",
  INSTAGRAM_APP_ID: "synthetic-ig-app",
  INSTAGRAM_APP_SECRET: "synthetic-ig-secret",
  PUBLIC_API_ORIGIN: "https://api.postora.cloud",
};

type SettingMode =
  | "protected"
  | "absent"
  | "undefined-data"
  | "undefined-value"
  | "undefined-error"
  | "driver-error"
  | "throw"
  | "malformed";

type RpcMode = "forbid" | "token" | "missing" | "schema" | "transport" | "malformed" | "refused";

interface AccountRow {
  id: string;
  user_id: string;
  platform: string;
  platform_user_id: string;
  platform_username: string;
  is_active: boolean;
  needs_reauth: boolean;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  failure_count: number;
  last_refresh_attempt_at?: string;
  account_metadata?: Record<string, unknown>;
  ig_auth_type?: string | null;
}

interface Probe {
  setting: SettingMode;
  rpcMode: RpcMode;
  providerMode: "forbid" | "success";
  accounts: AccountRow[];
  userId: string;
  statePayload: Record<string, unknown>;
  handler: ((req: Request) => Promise<Response> | Response) | null;
  providerCalls: string[];
  stateCreates: number;
  stateVerifies: number;
  http: { url: string; body?: string }[];
  mutations: { table: string; op: string }[];
  history: number;
  rpc: string[];
  reads: string[];
}

function facebookAccount(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: FACEBOOK_ID,
    user_id: USER_ID,
    platform: "facebook",
    platform_user_id: "synthetic-fb",
    platform_username: "synthetic",
    is_active: true,
    needs_reauth: false,
    access_token: PAGE_TOKEN,
    refresh_token: null,
    token_expires_at: "2020-01-01T00:00:00.000Z",
    failure_count: 0,
    account_metadata: { user_token: METADATA_TOKEN },
    ...overrides,
  };
}

function probe(overrides: Partial<Probe> = {}): Probe {
  return {
    setting: "protected",
    rpcMode: "forbid",
    providerMode: "forbid",
    accounts: [facebookAccount()],
    userId: USER_ID,
    statePayload: {
      user_id: USER_ID,
      platform: "facebook",
      flow: "pages",
      return_to: "https://postora.cloud/profiles",
      profile_id: null,
    },
    handler: null,
    providerCalls: [],
    stateCreates: 0,
    stateVerifies: 0,
    http: [],
    mutations: [],
    history: 0,
    rpc: [],
    reads: [],
    ...overrides,
  };
}

function installClient(current: Probe) {
  class Query {
    table: string;
    filters: Record<string, unknown> = {};
    inFilter: { column: string; values: unknown[] } | null = null;
    orFilters: string[] = [];
    op = "select";
    one = false;

    constructor(table: string) {
      this.table = table;
    }

    select() {
      return this;
    }
    eq(key: string, value: unknown) {
      this.filters[key] = value;
      return this;
    }
    or(filters: string) {
      this.orFilters.push(filters);
      return this;
    }
    order() {
      return this;
    }
    in(column: string, values: unknown[]) {
      this.inFilter = { column, values };
      return this;
    }
    not() {
      return this;
    }
    limit() {
      return this;
    }
    single() {
      this.one = true;
      return this;
    }
    maybeSingle() {
      this.one = true;
      return this;
    }
    insert(payload: unknown) {
      this.op = "insert";
      this.filters.payload = payload;
      return this;
    }
    update(payload: unknown) {
      this.op = "update";
      this.filters.payload = payload;
      return this;
    }
    upsert(payload: unknown) {
      this.op = "upsert";
      this.filters.payload = payload;
      return this;
    }
    delete() {
      this.op = "delete";
      return this;
    }

    then(ok: (value: unknown) => unknown, bad?: (reason: unknown) => unknown) {
      return Promise.resolve().then(() => this.execute()).then(ok, bad);
    }

    execute() {
      if (this.op !== "select") {
        if (this.table === "token_refresh_history") current.history += 1;
        else current.mutations.push({ table: this.table, op: this.op });
        return { data: this.op === "insert" ? { id: "synthetic-row" } : null, error: null };
      }
      current.reads.push(this.table);
      if (this.table === "app_settings") return settingsRow(current, String(this.filters.key ?? ""));
      const rows = current.accounts.filter((account) => {
        if (this.filters.id && account.id !== this.filters.id) return false;
        if (this.filters.user_id && account.user_id !== this.filters.user_id) return false;
        if (this.filters.platform && account.platform !== this.filters.platform) return false;
        if (this.inFilter?.column === "id" && !this.inFilter.values.includes(account.id)) return false;
        if (this.inFilter?.column === "platform" && !this.inFilter.values.includes(account.platform)) {
          return false;
        }
        if (
          this.orFilters.some((filter) => filter.includes("needs_reauth.eq.false")) &&
          account.needs_reauth
        ) {
          return false;
        }
        return true;
      });
      return { data: this.one ? rows[0] ?? null : rows, error: null };
    }
  }

  currentClient = {
    from: (table: string) => new Query(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      current.rpc.push(name);
      if (current.rpcMode === "forbid" || current.rpcMode === "transport") {
        throw new Error(`rpc failed access_token=${SECRET}`);
      }
      if (current.rpcMode === "schema") {
        return {
          data: null,
          error: {
            message: `Could not find the function public.${name} token ${SECRET}`,
            code: "PGRST202",
          },
        };
      }
      if (current.rpcMode === "refused") {
        return { data: null, error: { message: `account ${SECRET} is not owned`, code: "P0001" } };
      }
      if (current.rpcMode === "malformed") return { data: { found: "yes" }, error: null };
      if (current.rpcMode === "missing") {
        return {
          data: {
            found: false,
            social_account_id: args.p_social_account_id,
            platform: "facebook",
            credential_id: null,
            credential_kind: null,
            token: null,
            token_expires_at: null,
            revision: null,
            capability_generation: null,
            connection_version: null,
          },
          error: null,
        };
      }
      return {
        data: {
          found: true,
          social_account_id: args.p_social_account_id,
          platform: "facebook",
          credential_id: "33333333-3333-3333-3333-333333333333",
          credential_kind: "facebook_user",
          token: RPC_TOKEN,
          token_expires_at: null,
          revision: 1,
          capability_generation: null,
          connection_version: 1,
        },
        error: null,
      };
    },
    auth: {
      getClaims: async () => ({ data: { claims: { sub: current.userId } }, error: null }),
      getUser: async () => ({ data: { user: { id: current.userId } }, error: null }),
    },
  };
}

let currentClient: {
  from: (table: string) => unknown;
  rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  auth: {
    getClaims: (token: string) => Promise<unknown>;
    getUser: (token: string) => Promise<unknown>;
  };
};

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const originalServe = Deno.serve;

function restoreProcess(savedEnv: Map<string, string | undefined>) {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  Deno.serve = originalServe;
  const globals = globalThis as { __postoraProbe?: unknown; __postoraRouteClient?: unknown };
  delete globals.__postoraProbe;
  delete globals.__postoraRouteClient;
  for (const [key, value] of savedEnv) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
}

globalThis.addEventListener("unload", () => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  Deno.serve = originalServe;
  try {
    Deno.removeSync(BUNDLE_DIR, { recursive: true });
  } catch (_error) {
    // A failed temp cleanup must not hide the test result.
  }
});

function routeTest(name: string, fn: () => Promise<void>) {
  Deno.test(name, async () => {
    const savedEnv = new Map(Object.keys(ENV).map((key) => [key, Deno.env.get(key)]));
    try {
      await fn();
    } finally {
      restoreProcess(savedEnv);
    }
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function installFetch(current: Probe) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : undefined;
    current.http.push({ url: requestUrl(input), body });
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function settingsRow(current: Probe, key: string) {
  if (current.setting === "throw") throw new Error(`connect failed access_token=${SECRET}`);
  if (current.setting === "driver-error") {
    return { data: null, error: { message: `synthetic database outage ${SECRET}` } };
  }
  if (current.setting === "undefined-error") return { data: null, error: undefined };
  if (current.setting === "undefined-data") return { data: undefined, error: null };
  if (current.setting === "malformed") return { data: { unexpected: true }, error: null };
  if (current.setting === "undefined-value") return { data: { value: undefined }, error: null };
  if (current.setting === "absent" || key !== "credential_facebook_user_mode") {
    return { data: null, error: null };
  }
  return { data: { value: "protected" }, error: null };
}

const bundles = new Map<string, string>();
let importSeq = 0;

function stubSource(): string {
  const refreshNames = [
    "refreshFacebookToken",
    "refreshInstagramBusinessToken",
    "refreshTikTokToken",
    "refreshYouTubeToken",
    "refreshPinterestToken",
    "refreshLinkedInToken",
    "refreshTwitterToken",
    "refreshThreadsToken",
    "refreshBlueskyToken",
    "refreshRedditToken",
  ];
  const refreshExports = refreshNames.map((name) => {
    const success = name === "refreshTikTokToken" || name === "refreshYouTubeToken"
      ? `{ access_token: "provider-token", refresh_token: "provider-refresh", expires_in: 3600 }`
      : `{ ok: true, access_token: "provider-token", expires_in: 3600 }`;
    return `export async function ${name}() {
      globalThis.__postoraProbe.providerCalls.push(${JSON.stringify(name)});
      if (globalThis.__postoraProbe.providerMode !== "success") throw new Error("provider invoked");
      return ${success};
    }`;
  }).join("\n");
  return `
    const P = () => globalThis.__postoraProbe;
    export const createClient = () => globalThis.__postoraRouteClient;
    export const verifyCronAuth = () => ({ ok: true });
    export const handleCorsOptions = () => new Response(null, { status: 204 });
    export function createLogger() {
      return { info: async () => {}, warn: async () => {}, error: async () => {} };
    }
    export const logTokenEvent = async () => {};
    export const composioClientFromEnv = () => null;
    export async function authenticateCaller() {
      return { userId: P().userId, isServiceRole: false };
    }
    export async function serviceRoleCallerUserId() { return null; }
    export function timingSafeTokenEqual() { return false; }
    export async function createOAuthState() {
      P().stateCreates += 1;
      return "synthetic-state";
    }
    export async function verifyOAuthState() {
      P().stateVerifies += 1;
      return P().statePayload;
    }
    export async function cacheAvatarToCdn() { return null; }
    ${refreshExports}
    export async function fetchFacebookAvatarUrl() { return null; }
    export async function fetchInstagramAvatarUrl() { return null; }
    export async function fetchTikTokAvatarUrl() { return null; }
    export async function fetchTwitterAvatarUrl() { return null; }
    export async function fetchLinkedInAvatarUrl() { return null; }
    export async function fetchPinterestAvatarUrl() { return null; }
    export async function fetchYouTubeAvatarUrl() { return null; }
    export async function fetchThreadsAvatarUrl() { return null; }
    export async function fetchBlueskyAvatarUrl() { return null; }
    export async function fetchRedditAvatarUrl() { return null; }
  `;
}

async function bundle(entry: string): Promise<string> {
  const cached = bundles.get(entry);
  if (cached) return cached;
  await Deno.mkdir(BUNDLE_DIR, { recursive: true });
  const outfile = `${BUNDLE_DIR}/${entry.replaceAll("/", "-")}.mjs`;
  await build({
    entryPoints: [join(FUNCTIONS_ROOT, entry)],
    bundle: true,
    format: "esm",
    platform: "neutral",
    outfile,
    plugins: [{
      name: "infrastructure-ports",
      setup(esbuild: {
        onResolve: (options: { filter: RegExp }, callback: (args: { path: string }) => unknown) => void;
        onLoad: (options: { filter: RegExp; namespace: string }, callback: () => unknown) => void;
      }) {
        esbuild.onResolve({ filter: /.*/ }, (args) => {
          const path = args.path;
          if (path.includes("@supabase/supabase-js") || path.includes("esm.sh/@supabase")) {
            return { path: "port", namespace: "stub" };
          }
          const ports = [
            "cron-auth.ts",
            "logging.ts",
            "composioClient.ts",
            "social-auth.ts",
            "avatar-cache.ts",
            "auth-helper.ts",
            "oauthState.ts",
          ];
          if (ports.some((name) => path.endsWith(name))) return { path: "port", namespace: "stub" };
          return undefined;
        });
        esbuild.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: stubSource(),
          loader: "js",
        }));
      },
    }],
  });
  bundles.set(entry, outfile);
  return outfile;
}

async function loadHandler(entry: string, current: Probe) {
  installClient(current);
  (globalThis as { __postoraProbe?: Probe }).__postoraProbe = current;
  (globalThis as { __postoraRouteClient?: typeof currentClient }).__postoraRouteClient = currentClient;
  for (const [key, value] of Object.entries(ENV)) Deno.env.set(key, value);
  installFetch(current);
  const outfile = await bundle(entry);
  const previousServe = Deno.serve;
  Deno.serve = ((handler: (req: Request) => Response | Promise<Response>) => {
    current.handler = handler;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  }) as typeof Deno.serve;
  try {
    await import(`${pathToFileURL(outfile).href}?case=${++importSeq}`);
  } finally {
    Deno.serve = previousServe;
  }
  if (!current.handler) throw new Error(`${entry} did not register a request handler`);
  return current.handler;
}

function authHeaders(): HeadersInit {
  return {
    Authorization: "Bearer synthetic-user",
    "Content-Type": "application/json",
    "x-cron-secret": "synthetic-cron",
  };
}

async function callJson(handler: (req: Request) => Promise<Response> | Response, url: string, body: unknown) {
  const response = await handler(new Request(url, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() };
}

function providerUrls(current: Probe): string[] {
  return current.http.map((call) => call.url).filter((url) =>
    url.includes("graph.facebook.com") ||
    url.includes("graph.instagram.com") ||
    url.includes("graph.threads.net") ||
    url.includes("nominatim.openstreetmap.org") ||
    url.includes("send-token-failure-alert")
  );
}

function accountMutations(current: Probe): { table: string; op: string }[] {
  return current.mutations.filter((mutation) =>
    mutation.table === "social_accounts" ||
    mutation.table.startsWith("oauth_pending")
  );
}

routeTest("protected oauth routes refuse the unsupported actions before provider exchange, state creation, and writes", async () => {
  // The JavaScript-SDK and provider-token-only shapes cannot substitute for a
  // captured preauthorization. They stay refused in protected mode.
  const facebookPosts = [
    { action: "list_pages", provider_token: PAGE_TOKEN },
    { action: "store_account", provider_token: PAGE_TOKEN },
    { action: "store_instagram", instagram_account_id: "ig-1", selection_id: "selection-1" },
  ];
  for (const body of facebookPosts) {
    const current = probe();
    const handler = await loadHandler("facebook-oauth/index.ts", current);
    const result = await callJson(handler, "https://synthetic.invalid/functions/v1/facebook-oauth", body);
    assertEquals(result.status, 503);
    assertEquals(result.body.error_code, "lifecycle_prerequisite_missing");
    assertEquals(current.stateCreates, 0);
    assertEquals(current.providerCalls, []);
    assertEquals(providerUrls(current), []);
    assertEquals(accountMutations(current), []);
    assertEquals(current.rpc, []);
    assertEquals(JSON.stringify(result.body).includes(PAGE_TOKEN), false);
  }

  // The unsigned direct POST callback shim carries no signed attempt.
  {
    const current = probe({
      statePayload: {
        user_id: USER_ID,
        platform: "instagram",
        flow: "direct",
        return_to: "https://postora.cloud/profiles?connected=instagram",
      },
    });
    const handler = await loadHandler("instagram-oauth/index.ts", current);
    const result = await callJson(
      handler,
      "https://synthetic.invalid/functions/v1/instagram-oauth",
      { action: "callback" },
    );
    assertEquals(result.status, 503);
    assertEquals(result.body.error_code, "lifecycle_prerequisite_missing");
    assertEquals(current.stateCreates, 0);
    assertEquals(providerUrls(current), []);
    assertEquals(accountMutations(current), []);
  }
});

routeTest("protected oauth callbacks redirect before the code exchange", async () => {
  // A legacy callback that arrives while protected mode is selected refuses
  // and asks for a restart instead of writing a legacy account.
  const cases = [
    {
      entry: "facebook-oauth/index.ts",
      path: "/functions/v1/facebook-oauth",
      payload: {
        user_id: USER_ID,
        platform: "facebook",
        flow: "pages",
        return_to: "https://postora.cloud/profiles",
      },
    },
    {
      entry: "instagram-business-oauth/index.ts",
      path: "/functions/v1/instagram-business-oauth",
      payload: {
        user_id: USER_ID,
        platform: "instagram",
        flow: "facebook_business",
        return_to: "https://postora.cloud/profiles?connected=instagram_business",
      },
    },
    {
      entry: "instagram-oauth/index.ts",
      path: "/functions/v1/instagram-oauth",
      payload: {
        user_id: USER_ID,
        platform: "instagram",
        flow: "direct",
        return_to: "https://postora.cloud/profiles?connected=instagram",
      },
    },
  ];
  for (const routeCase of cases) {
    const current = probe({ statePayload: routeCase.payload });
    const handler = await loadHandler(routeCase.entry, current);
    const response = await handler(new Request(
      `https://synthetic.invalid${routeCase.path}?code=synthetic-code&state=synthetic-state`,
      { method: "GET" },
    ));
    assertEquals(response.status, 302);
    const location = response.headers.get("location") ?? "";
    assertEquals(location.includes("error=protected_reauthorization_required"), true);
    assertEquals(location.includes(SECRET), false);
    assertEquals(current.stateCreates, 0);
    assertEquals(current.stateVerifies, 1);
    assertEquals(providerUrls(current), []);
    assertEquals(accountMutations(current), []);
  }
});

routeTest("a missing settings row lets oauth authorize continue without a protected read", async () => {
  const current = probe({ setting: "absent" });
  const handler = await loadHandler("facebook-oauth/index.ts", current);
  const result = await callJson(handler, "https://synthetic.invalid/functions/v1/facebook-oauth", {
    action: "authorize",
  });
  assertEquals(result.status, 200);
  assertEquals(typeof result.body.url, "string");
  assertEquals(String(result.body.url).includes("facebook.com"), true);
  assertEquals(current.stateCreates, 1);
  assertEquals(current.rpc, []);
  assertEquals(accountMutations(current), []);
});

routeTest("undefined and failed settings reads do not continue an oauth route", async () => {
  for (const setting of ["undefined-data", "undefined-value", "undefined-error", "driver-error", "throw", "malformed"] as const) {
    const current = probe({ setting });
    const logs: string[] = [];
    const previous = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" "));
    };
    try {
      const handler = await loadHandler("facebook-oauth/index.ts", current);
      const result = await callJson(handler, "https://synthetic.invalid/functions/v1/facebook-oauth", {
        action: "authorize",
      });
      assertEquals(result.status, 503);
      assertEquals(result.body.error_code, "CREDENTIAL_CONFIGURATION_UNAVAILABLE");
      assertEquals(JSON.stringify(result.body).includes(SECRET), false);
      assertEquals(logs.some((line) => line.includes(SECRET)), false);
      assertEquals(current.stateCreates, 0);
      assertEquals(providerUrls(current), []);
      assertEquals(current.rpc, []);
    } finally {
      console.error = previous;
    }
  }
});

routeTest("protected scheduled, single, and bulk refresh refuse without alerts or account writes", async () => {
  const entry = "refresh-tokens/index.ts";
  const url = "https://synthetic.invalid/functions/v1/refresh-tokens";

  const scheduled = probe();
  const scheduledHandler = await loadHandler(entry, scheduled);
  const scheduledResult = await callJson(scheduledHandler, url, {});
  assertEquals(scheduledResult.status, 503);
  assertEquals(scheduledResult.body.message, "Protected Meta refresh refused");
  assertEquals(scheduledResult.body.error_code, "lifecycle_prerequisite_missing");
  assertEquals(scheduledResult.body.refused, 1);
  assertEquals(scheduledResult.body.alertsSent, 0);
  assertEquals(scheduled.providerCalls, []);
  assertEquals(providerUrls(scheduled), []);
  assertEquals(accountMutations(scheduled), []);
  assertEquals(scheduled.rpc, []);
  assertEquals(scheduled.history, 1);

  const single = probe({ accounts: [facebookAccount({ needs_reauth: true })] });
  const singleHandler = await loadHandler(entry, single);
  const singleResult = await callJson(singleHandler, url, { accountId: FACEBOOK_ID, force: true });
  assertEquals(singleResult.status, 503);
  assertEquals(singleResult.body.message, "Protected Meta refresh refused");
  assertEquals(singleResult.body.message.includes("complete"), false);
  assertEquals(single.providerCalls, []);
  assertEquals(providerUrls(single), []);
  assertEquals(accountMutations(single), []);
  assertEquals(single.rpc, []);
  assertEquals(single.history, 1);

  const bulk = probe();
  const bulkHandler = await loadHandler(entry, bulk);
  const bulkResult = await callJson(bulkHandler, url, { accountIds: [FACEBOOK_ID], force: true });
  assertEquals(bulkResult.status, 503);
  assertEquals(bulkResult.body.message, "Protected Meta refresh refused");
  assertEquals(bulkResult.body.refused, 1);
  assertEquals(bulk.providerCalls, []);
  assertEquals(accountMutations(bulk), []);
  assertEquals(bulk.rpc, []);
  assertEquals(bulk.history, 1);
});

routeTest("cooldown and a recent attempt do not bypass a protected meta refusal", async () => {
  const current = probe({
    accounts: [facebookAccount({ last_refresh_attempt_at: new Date().toISOString(), access_token: null })],
  });
  const handler = await loadHandler("refresh-tokens/index.ts", current);
  const result = await callJson(handler, "https://synthetic.invalid/functions/v1/refresh-tokens", {});
  assertEquals(result.status, 503);
  assertEquals(result.body.results[0].error_code, "lifecycle_prerequisite_missing");
  assertEquals(result.body.results[0].status === "cooldown", false);
  assertEquals(result.body.results[0].status === "needs_reauth", false);
  assertEquals(current.providerCalls, []);
  assertEquals(accountMutations(current), []);
  assertEquals(current.rpc, []);
  assertEquals(providerUrls(current), []);
});

routeTest("a mixed sweep refreshes non-meta work and does not let a refused account send the health alert alone", async () => {
  const current = probe({
    providerMode: "success",
    accounts: [
      facebookAccount(),
      facebookAccount({
        id: TIKTOK_ID,
        platform: "tiktok",
        refresh_token: "tiktok-refresh",
        access_token: "tiktok-access",
        account_metadata: {},
      }),
    ],
  });
  const handler = await loadHandler("refresh-tokens/index.ts", current);
  const result = await callJson(handler, "https://synthetic.invalid/functions/v1/refresh-tokens", {});
  assertEquals(result.status, 200);
  assertEquals(result.body.message, "Token refresh complete");
  assertEquals(result.body.refused, 1);
  assertEquals(current.providerCalls.includes("refreshFacebookToken"), false);
  assertEquals(current.providerCalls.includes("refreshTikTokToken"), true);
  const alerts = current.http.filter((call) => call.url.includes("send-token-failure-alert"));
  assertEquals(alerts.length, 1);
  const alertBody = JSON.parse(alerts[0].body ?? "{}");
  assertEquals(alertBody.healthAlert.expiredCount, 1);
  assertEquals(alertBody.healthAlert.totalAccounts, 1);
  assertEquals(alertBody.healthAlert.needsReauthCount, 0);
});

routeTest("a protected needs_reauth sibling does not send the global health alert", async () => {
  const current = probe({
    accounts: [
      facebookAccount(),
      facebookAccount({ id: SIBLING_ID, needs_reauth: true, platform_username: "sibling" }),
    ],
  });
  const handler = await loadHandler("refresh-tokens/index.ts", current);
  const result = await callJson(handler, "https://synthetic.invalid/functions/v1/refresh-tokens", {});
  assertEquals(result.status, 503);
  assertEquals(result.body.message, "Protected Meta refresh refused");
  assertEquals(result.body.refused, 1);
  assertEquals(result.body.results.length, 1);
  assertEquals(result.body.results[0].id, FACEBOOK_ID);
  assertEquals(current.http.some((call) => call.url.includes("send-token-failure-alert")), false);
  assertEquals(current.providerCalls, []);
  assertEquals(accountMutations(current), []);
  assertEquals(current.rpc, []);
  assertEquals(current.history, 1);
});

routeTest("platform-filtered protected meta stays out of the health population", async () => {
  const current = probe({
    providerMode: "success",
    accounts: [
      facebookAccount({
        id: TIKTOK_ID,
        platform: "tiktok",
        refresh_token: "tiktok-refresh",
        access_token: "tiktok-access",
        account_metadata: {},
      }),
      facebookAccount(),
      facebookAccount({ id: SIBLING_ID, needs_reauth: true, platform_username: "sibling" }),
      facebookAccount({ id: INSTAGRAM_ID, platform: "instagram", platform_username: "ig" }),
    ],
  });
  const handler = await loadHandler("refresh-tokens/index.ts", current);
  const result = await callJson(handler, "https://synthetic.invalid/functions/v1/refresh-tokens", {
    platforms: ["tiktok"],
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.message, "Token refresh complete");
  assertEquals(result.body.refused, undefined);
  assertEquals(current.providerCalls, ["refreshTikTokToken"]);
  const alerts = current.http.filter((call) => call.url.includes("send-token-failure-alert"));
  assertEquals(alerts.length, 1);
  const alertBody = JSON.parse(alerts[0].body ?? "{}");
  assertEquals(alertBody.healthAlert.totalAccounts, 1);
  assertEquals(alertBody.healthAlert.expiredCount, 1);
  assertEquals(alertBody.healthAlert.needsReauthCount, 0);
  assertEquals(current.rpc, []);
  assertEquals(current.history, 1);
});

routeTest("a facebook-only sweep does not alert for protected meta left out of the filter", async () => {
  const current = probe({
    accounts: [
      facebookAccount(),
      facebookAccount({ id: SIBLING_ID, needs_reauth: true, platform_username: "sibling" }),
      facebookAccount({ id: INSTAGRAM_ID, platform: "instagram", platform_username: "ig" }),
    ],
  });
  const handler = await loadHandler("refresh-tokens/index.ts", current);
  const result = await callJson(handler, "https://synthetic.invalid/functions/v1/refresh-tokens", {
    platforms: ["facebook"],
  });
  assertEquals(result.status, 503);
  assertEquals(result.body.refused, 1);
  assertEquals(result.body.results.length, 1);
  assertEquals(result.body.results[0].id, FACEBOOK_ID);
  assertEquals(current.http.some((call) => call.url.includes("send-token-failure-alert")), false);
  assertEquals(current.providerCalls, []);
  assertEquals(accountMutations(current), []);
  assertEquals(current.rpc, []);
  assertEquals(current.history, 1);
});

routeTest("a budget-deferred protected account does not send the global health alert", async () => {
  const current = probe({
    accounts: [
      facebookAccount(),
      facebookAccount({ id: DEFERRED_ID, platform_username: "deferred" }),
    ],
  });
  const handler = await loadHandler("refresh-tokens/index.ts", current);
  const start = 1_700_000_000_000;
  let reads = 0;
  Date.now = () => {
    reads += 1;
    return reads <= 2 ? start : start + 30_000;
  };
  const result = await callJson(handler, "https://synthetic.invalid/functions/v1/refresh-tokens", {});
  assertEquals(result.body.results.map((row: { id: string; error?: string }) => [row.id, row.error]), [
    [FACEBOOK_ID, "Protected Meta account changes are unavailable until the lifecycle contract is ready."],
    [DEFERRED_ID, "Deferred: sweep budget spent"],
  ]);
  assertEquals(result.status, 200);
  assertEquals(result.body.message, "Token refresh complete");
  assertEquals(result.body.refused, 1);
  assertEquals(current.http.some((call) => call.url.includes("send-token-failure-alert")), false);
  assertEquals(current.providerCalls, []);
  assertEquals(accountMutations(current), []);
  assertEquals(current.rpc, []);
  assertEquals(current.history, 1);
});

routeTest("an absent settings row still refreshes a legacy meta account and does not read the protected schema", async () => {
  const current = probe({ setting: "absent", providerMode: "success" });
  const handler = await loadHandler("refresh-tokens/index.ts", current);
  const result = await callJson(handler, "https://synthetic.invalid/functions/v1/refresh-tokens", {});
  assertEquals(result.status, 200);
  assertEquals(result.body.message, "Token refresh complete");
  assertEquals(current.providerCalls.includes("refreshFacebookToken"), true);
  assertEquals(current.rpc, []);
  const alerts = current.http.filter((call) => call.url.includes("send-token-failure-alert"));
  assertEquals(alerts.length, 1);
  const alertBody = JSON.parse(alerts[0].body ?? "{}");
  assertEquals(alertBody.healthAlert.totalAccounts, 1);
  assertEquals(alertBody.healthAlert.expiredCount, 1);
});

routeTest("protected readers refuse failed configuration and bad credential reads without a page token", async () => {
  const logs: string[] = [];
  const previous = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" "));
  };
  try {
    for (const setting of ["driver-error", "throw", "malformed", "undefined-data"] as const) {
      const current = probe({ setting, rpcMode: "token" });
      const handler = await loadHandler("ad-analytics/index.ts", current);
      const result = await callJson(handler, "https://synthetic.invalid/functions/v1/ad-analytics", {
        action: "get_ad_accounts",
        social_account_id: FACEBOOK_ID,
      });
      assertEquals(result.status, 503);
      assertEquals(result.body.error_code, "CREDENTIAL_CONFIGURATION_UNAVAILABLE");
      assertEquals(JSON.stringify(result.body).includes(SECRET), false);
      assertEquals(JSON.stringify(result.body).includes(PAGE_TOKEN), false);
      assertEquals(JSON.stringify(result.body).includes(METADATA_TOKEN), false);
      assertEquals(providerUrls(current), []);
      assertEquals(current.rpc, []);
    }

    const missing = probe({ rpcMode: "missing" });
    const missingHandler = await loadHandler("ad-analytics/index.ts", missing);
    const missingResult = await callJson(missingHandler, "https://synthetic.invalid/functions/v1/ad-analytics", {
      action: "get_ad_accounts",
      social_account_id: FACEBOOK_ID,
    });
    assertEquals(missingResult.status, 404);
    assertEquals(missingResult.body.error_code, "PROTECTED_CREDENTIAL_UNAVAILABLE");
    assertEquals(providerUrls(missing), []);

    const schema = probe({ rpcMode: "schema" });
    const schemaHandler = await loadHandler("ad-analytics/index.ts", schema);
    const schemaResult = await callJson(schemaHandler, "https://synthetic.invalid/functions/v1/ad-analytics", {
      action: "get_ad_accounts",
      social_account_id: FACEBOOK_ID,
    });
    assertEquals(schemaResult.status, 503);
    assertEquals(schemaResult.body.error_code, "SCHEMA_UNAVAILABLE");
    assertEquals(JSON.stringify(schemaResult.body).includes(SECRET), false);
    assertEquals(providerUrls(schema), []);

    const transport = probe({ rpcMode: "transport" });
    const transportHandler = await loadHandler("ad-analytics/index.ts", transport);
    const transportResult = await callJson(transportHandler, "https://synthetic.invalid/functions/v1/ad-analytics", {
      action: "get_ad_accounts",
      social_account_id: FACEBOOK_ID,
    });
    assertEquals(transportResult.status, 503);
    assertEquals(transportResult.body.error_code, "PROTECTED_CREDENTIAL_READ_FAILED");
    assertEquals(JSON.stringify(transportResult.body).includes(SECRET), false);

    const placesMissing = probe({ rpcMode: "missing" });
    const placesHandler = await loadHandler("facebook-places-search/index.ts", placesMissing);
    const placesResult = await callJson(placesHandler, "https://synthetic.invalid/functions/v1/facebook-places-search", {
      query: "Kuwait",
      account_id: FACEBOOK_ID,
    });
    assertEquals(placesResult.status, 200);
    assertEquals(placesResult.body.error, "PROTECTED_CREDENTIAL_UNAVAILABLE");
    assertEquals(providerUrls(placesMissing).some((url) => url.includes("graph.facebook.com")), false);
    assertEquals(providerUrls(placesMissing).some((url) => url.includes("nominatim")), false);

    const placesSchema = probe({ rpcMode: "schema" });
    const placesSchemaHandler = await loadHandler("facebook-places-search/index.ts", placesSchema);
    const placesSchemaResult = await callJson(
      placesSchemaHandler,
      "https://synthetic.invalid/functions/v1/facebook-places-search",
      { query: "Kuwait", account_id: FACEBOOK_ID },
    );
    assertEquals(placesSchemaResult.status, 503);
    assertEquals(placesSchemaResult.body.error_code, "SCHEMA_UNAVAILABLE");
    assertEquals(providerUrls(placesSchema).some((url) => url.includes("nominatim")), false);

    const threadsAccount = facebookAccount({
      platform: "threads",
      access_token: null,
      account_metadata: {},
    });
    const threadsSchema = probe({
      rpcMode: "schema",
      accounts: [threadsAccount, facebookAccount()],
    });
    const threadsHandler = await loadHandler("threads-location-search/index.ts", threadsSchema);
    const threadsResult = await callJson(
      threadsHandler,
      "https://synthetic.invalid/functions/v1/threads-location-search",
      { query: "Kuwait" },
    );
    assertEquals(threadsResult.status, 200);
    assertEquals(threadsResult.body.ok, false);
    assertEquals(threadsResult.body.error_code, "SCHEMA_UNAVAILABLE");
    assertEquals(providerUrls(threadsSchema).some((url) => url.includes("nominatim")), false);
    assertEquals(providerUrls(threadsSchema).some((url) => url.includes(PAGE_TOKEN)), false);
    assertEquals(logs.some((line) => line.includes(SECRET)), false);

    const refused = probe({ rpcMode: "refused" });
    const refusedHandler = await loadHandler("ad-analytics/index.ts", refused);
    const refusedResult = await callJson(refusedHandler, "https://synthetic.invalid/functions/v1/ad-analytics", {
      action: "get_ad_accounts",
      social_account_id: FACEBOOK_ID,
    });
    assertEquals(refusedResult.status, 403);
    assertEquals(refusedResult.body.error_code, "PROTECTED_CREDENTIAL_INELIGIBLE");
    assertEquals(JSON.stringify(refusedResult.body).includes(SECRET), false);
    assertEquals(providerUrls(refused), []);

    const placesRefused = probe({ rpcMode: "refused" });
    const placesRefusedHandler = await loadHandler("facebook-places-search/index.ts", placesRefused);
    const placesRefusedResult = await callJson(
      placesRefusedHandler,
      "https://synthetic.invalid/functions/v1/facebook-places-search",
      { query: "Kuwait", account_id: FACEBOOK_ID },
    );
    assertEquals(placesRefusedResult.status, 200);
    assertEquals(placesRefusedResult.body.error, "PROTECTED_CREDENTIAL_UNAVAILABLE");
    assertEquals(providerUrls(placesRefused), []);

    const threadsRefused = probe({
      rpcMode: "refused",
      accounts: [threadsAccount, facebookAccount()],
    });
    const threadsRefusedHandler = await loadHandler("threads-location-search/index.ts", threadsRefused);
    const threadsRefusedResult = await callJson(
      threadsRefusedHandler,
      "https://synthetic.invalid/functions/v1/threads-location-search",
      { query: "Kuwait" },
    );
    assertEquals(threadsRefusedResult.status, 200);
    assertEquals(threadsRefusedResult.body.ok, false);
    assertEquals(threadsRefusedResult.body.reason, "no_account");
    assertEquals(providerUrls(threadsRefused).some((url) => url.includes("nominatim")), false);
    assertEquals(providerUrls(threadsRefused).some((url) => url.includes("graph.facebook.com")), false);
    assertEquals(logs.some((line) => line.includes(SECRET)), false);
  } finally {
    console.error = previous;
  }
});

routeTest("a protected ad account token comes from the owner-scoped read", async () => {
  const current = probe({ rpcMode: "token" });
  const handler = await loadHandler("ad-analytics/index.ts", current);
  const response = await handler(new Request("https://synthetic.invalid/functions/v1/ad-analytics", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ action: "get_ad_accounts", social_account_id: FACEBOOK_ID }),
  }));
  await response.text();
  const graph = current.http.filter((call) => call.url.includes("graph.facebook.com"));
  assertEquals(graph.length, 1);
  assertEquals(graph[0].url.includes(RPC_TOKEN), true);
  assertEquals(graph[0].url.includes(PAGE_TOKEN), false);
  assertEquals(graph[0].url.includes(METADATA_TOKEN), false);
  assertEquals(current.rpc, ["read_facebook_user_account_credential"]);
});
