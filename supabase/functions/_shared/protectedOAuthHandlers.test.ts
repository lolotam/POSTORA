/**
 * The real Meta OAuth handlers, executing the protected lifecycle.
 *
 * Each entrypoint is bundled with its real attempt store, protected flow and
 * signed-state module. Only the infrastructure ports are replaced: the
 * Supabase client, the authentication helper and the avatar cache. The
 * signed OAuth state is the REAL one, so a tampered, expired or wrongly
 * routed state is exercised against the production verifier.
 *
 * The suite proves the contract the handlers are supposed to hold:
 *
 *   - the explicit intent is captured before the authorization URL is
 *     returned, and the attempt is claimed before the provider is contacted;
 *   - a signed, captured attempt continues protected after a mode flip, and
 *     a legacy callback in protected mode refuses;
 *   - every supplied pending reference is classified in both modes before any
 *     provider call, mutation, secret read or deletion;
 *   - the selection authority is the attempt id plus the opaque selection
 *     key, and the paired Page-plus-Instagram commit is one receipt;
 *   - the picker close is truthful, and the post-commit subscription is a
 *     bounded, explicitly reassertable side effect;
 *   - no claim token, provider token or raw driver text reaches a browser
 *     response, a redirect URL or a log line.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createOAuthState } from "./oauthState.ts";

const testFilePath = fileURLToPath(import.meta.url);
const FUNCTIONS_ROOT = dirname(dirname(testFilePath));
const REPO_ROOT = dirname(dirname(FUNCTIONS_ROOT));
const require = createRequire(join(REPO_ROOT, "package.json"));
const { build } = require("esbuild") as {
  build: (options: Record<string, unknown>) => Promise<unknown>;
};

const BUNDLE_DIR = Deno.makeTempDirSync({ prefix: "postora-protected-oauth-" });

const SECRET = "EAABwzLixnjYBO7ZBsecretValueThatIsLongEnoughToLookLikeAToken123";
const STATE_SECRET = "synthetic-oauth-state-secret-for-the-protected-suite";
const USER_ID = "b0000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "b0000000-0000-4000-8000-000000000002";
const ATTEMPT_ID = "c0000000-0000-4000-8000-000000000001";
const PENDING_ID = "d0000000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "a0000000-0000-4000-8000-000000000001";
const TARGET_ID = "a0000000-0000-4000-8000-000000000002";
const SOURCE_ID = "a0000000-0000-4000-8000-000000000003";
const NONCE = "synthetic-nonce-value";
const CLAIM_TOKEN = "claim-token-must-not-leak";
const PROVIDER_TOKEN = "provider-token-must-not-leak";
const PAGE_TOKEN = "page-token-must-not-leak";
const RAW_DRIVER_TEXT = "raw driver text must not leak";

const ENV: Record<string, string> = {
  SUPABASE_URL: "https://synthetic.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "synthetic-service",
  SUPABASE_ANON_KEY: "synthetic-anon",
  FACEBOOK_APP_ID: "synthetic-fb-app",
  FACEBOOK_APP_SECRET: "synthetic-fb-secret",
  INSTAGRAM_APP_ID: "synthetic-ig-app",
  INSTAGRAM_APP_SECRET: "synthetic-ig-secret",
  PUBLIC_API_ORIGIN: "https://api.postora.cloud",
  OAUTH_STATE_SECRET: STATE_SECRET,
};

type SettingMode = "protected" | "legacy" | "absent" | "throw" | "driver-error" | "malformed";
type RpcMode = "ok" | "throw" | "malformed" | "refused" | "missing-error";

interface Row {
  id: string;
  user_id: string;
  meta_oauth_attempt_id?: string | null;
  expires_at?: string | null;
  [key: string]: unknown;
}

interface Probe {
  userId: string;
  setting: SettingMode;
  rpcMode: RpcMode;
  rpcOverrides: Record<string, unknown>;
  rpcErrors: Record<string, { message: string; code: string }>;
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
  instagramRows: Row[];
  facebookRows: Row[];
  attemptRows: Row[];
  receiptRows: Row[];
  socialRows: Row[];
  failingTables: string[];
  http: Array<{ url: string; body?: string }>;
  mutations: Array<{ table: string; op: string }>;
  tableReads: string[];
  providerFetch: (url: string) => { status: number; body: unknown };
  handler?: (req: Request) => Response | Promise<Response>;
}

function probe(overrides: Partial<Probe> = {}): Probe {
  return {
    userId: USER_ID,
    setting: "protected",
    rpcMode: "ok",
    rpcOverrides: {},
    rpcErrors: {},
    rpcCalls: [],
    instagramRows: [],
    facebookRows: [],
    attemptRows: [],
    receiptRows: [],
    socialRows: [],
    failingTables: [],
    http: [],
    mutations: [],
    tableReads: [],
    providerFetch: () => ({ status: 200, body: { data: [] } }),
    ...overrides,
  };
}

function beginResult(overrides: Record<string, unknown> = {}) {
  const flow = typeof overrides.flow === "string" ? overrides.flow : "facebook_page";
  const intent = typeof overrides.intent === "string" ? overrides.intent : "connect_new";
  return {
    attempt_id: ATTEMPT_ID,
    flow,
    intent,
    user_id: USER_ID,
    target_social_account_id: null,
    linked_target_social_account_id: null,
    source_social_account_id: null,
    intended_social_profile_id: null,
    capture_version: 1,
    captured_at: "2026-10-28T10:00:00+00:00",
    nonce: NONCE,
    nonce_digest: "digest",
    callback_deadline: "2026-10-28T10:10:00+00:00",
    picker_deadline: "2026-10-28T10:15:00+00:00",
    capture: { capture_version: 1 },
    ...overrides,
    // Named fixture correction: state.flow follows the requested flow.
    // A Facebook default here used to disagree with a direct or page-linked begin.
    state: overrides.state ?? { attempt_id: ATTEMPT_ID, nonce: NONCE, flow },
  };
}

function claimResult(overrides: Record<string, unknown> = {}) {
  return {
    attempt_id: ATTEMPT_ID,
    flow: "facebook_page",
    claim_token: CLAIM_TOKEN,
    claimed_at: "2026-10-28T10:01:00+00:00",
    callback_deadline: "2026-10-28T10:10:00+00:00",
    picker_deadline: "2026-10-28T10:15:00+00:00",
    capture: { capture_version: 1 },
    ...overrides,
  };
}

function completeResult(overrides: Record<string, unknown> = {}) {
  return {
    attempt_id: ATTEMPT_ID,
    flow: "facebook_page",
    pending_selection_id: PENDING_ID,
    login_kind: null,
    picker_deadline: "2026-10-28T10:15:00+00:00",
    candidates: [
      {
        selection_key: "facebook_page:page:page-1",
        ig_user_id: null,
        ig_username: null,
        ig_profile_picture_url: null,
        facebook_page_id: "page-1",
        facebook_page_name: "Shop",
      },
    ],
    ...overrides,
  };
}

function pickerResult(overrides: Record<string, unknown> = {}) {
  return {
    attempt_id: ATTEMPT_ID,
    flow: "facebook_page",
    intent: "connect_new",
    social_profile_id: null,
    picker_deadline: "2026-10-28T10:15:00+00:00",
    expires_at: "2026-10-28T10:15:00+00:00",
    committed_selection_keys: [],
    candidates: [
      {
        selection_key: "facebook_page:page:page-1",
        ig_user_id: null,
        ig_username: null,
        ig_profile_picture_url: null,
        facebook_page_id: "page-1",
        facebook_page_name: "Shop",
      },
    ],
    ...overrides,
  };
}

function receiptResult(overrides: Record<string, unknown> = {}) {
  return {
    attempt_id: ATTEMPT_ID,
    selection_key: "facebook_page:page:page-1",
    flow: "facebook_page",
    intent: "connect_new",
    platform: "facebook",
    platform_user_id: "page-1",
    instagram_user_id: null,
    facebook_page_id: "page-1",
    facebook_user_id: "fb-1",
    social_account_id: ACCOUNT_ID,
    companion_social_account_id: null,
    username: "Shop",
    operation: "created",
    login_kind: null,
    credential_id: "cred-1",
    credential_revision: 1,
    connection_version: 1,
    capability_generation: 2,
    committed_at: "2026-10-28T10:05:00+00:00",
    ...overrides,
  };
}

function claimedFlow(current: Probe): string {
  const claim = [...current.rpcCalls].reverse().find((call) => call.name === "claim_meta_oauth_callback");
  const payload = (claim?.args.p_payload ?? {}) as Record<string, unknown>;
  return typeof payload.flow === "string" ? payload.flow : "facebook_page";
}

/**
 * Named per-flow completion fixtures.
 *
 * The complete SQL payload has no flow field. The wire result still has to
 * agree with the claim that produced it, so the fixture follows that claim
 * instead of always returning the Facebook page candidate.
 */
function completeResultForClaim(current: Probe): unknown {
  const flow = claimedFlow(current);
  if (flow === "instagram_direct") {
    return completeResult({
      flow,
      login_kind: "direct",
      candidates: [{
        selection_key: "instagram_direct:ig:ig-canonical",
        ig_user_id: "ig-canonical",
        ig_username: "shop",
        ig_profile_picture_url: null,
        facebook_page_id: null,
        facebook_page_name: null,
      }],
    });
  }
  if (flow === "instagram_page_linked") {
    return completeResult({
      flow,
      candidates: [{
        selection_key: "instagram_page_linked:ig:ig-1",
        ig_user_id: "ig-1",
        ig_username: "shop",
        ig_profile_picture_url: null,
        facebook_page_id: "page-1",
        facebook_page_name: "Shop",
      }],
    });
  }
  return completeResult({ flow });
}

/**
 * Named per-flow receipt fixtures.
 *
 * Commit SQL does not accept a flow. The receipt's flow comes from the
 * owner-scoped attempt row the route already read.
 */
function receiptForAttempt(current: Probe, payload: Record<string, unknown>): unknown {
  const attemptId = typeof payload.attempt_id === "string" ? payload.attempt_id : ATTEMPT_ID;
  const attempt = current.attemptRows.find((row) => row.id === attemptId);
  const flow = typeof attempt?.flow === "string" ? attempt.flow : "facebook_page";
  if (flow === "instagram_direct") {
    return receiptResult({
      attempt_id: attemptId,
      selection_key: payload.selection_key,
      flow,
      platform: "instagram",
      platform_user_id: "ig-canonical",
      instagram_user_id: "ig-canonical",
      facebook_page_id: null,
      facebook_user_id: null,
      username: "shop",
      login_kind: "direct",
    });
  }
  if (flow === "instagram_page_linked") {
    return receiptResult({
      attempt_id: attemptId,
      selection_key: payload.selection_key,
      flow,
      platform: "instagram",
      platform_user_id: "ig-1",
      instagram_user_id: "ig-1",
      facebook_page_id: "page-1",
      username: "shop",
      login_kind: "page_linked",
    });
  }
  return receiptResult({
    attempt_id: attemptId,
    selection_key: payload.selection_key,
    flow,
  });
}

function defaultRpcResult(name: string, args: Record<string, unknown>, current: Probe): unknown {
  const payload = (args.p_payload ?? {}) as Record<string, unknown>;
  switch (name) {
    case "begin_meta_oauth_attempt": {
      const flow = (payload.flow ?? "facebook_page") as string;
      // The accepted begin result echoes the captured account references.
      // Leaving them null made a reconnect or grant extension disagree with
      // its own request and refuse after the RPC.
      return beginResult({
        flow,
        intent: payload.intent ?? "connect_new",
        target_social_account_id: payload.target_social_account_id ?? null,
        linked_target_social_account_id: payload.linked_target_social_account_id ?? null,
        source_social_account_id: payload.source_social_account_id ?? null,
        intended_social_profile_id: payload.intended_social_profile_id ?? null,
      });
    }
    case "claim_meta_oauth_callback":
      return claimResult({ flow: payload.flow ?? "facebook_page" });
    case "complete_meta_oauth_callback":
      return completeResultForClaim(current);
    case "read_meta_oauth_attempt":
      return pickerResult({ flow: "instagram_page_linked" });
    case "commit_meta_oauth_selection":
      return receiptForAttempt(current, payload);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Infrastructure ports
// ---------------------------------------------------------------------------

function rowsFor(current: Probe, table: string): Row[] {
  switch (table) {
    case "oauth_pending_instagram_selections":
      return current.instagramRows;
    case "oauth_pending_facebook_selections":
      return current.facebookRows;
    case "meta_oauth_attempts":
      return current.attemptRows;
    case "meta_oauth_attempt_receipts":
      return current.receiptRows;
    case "social_accounts":
      return current.socialRows;
    default:
      return [];
  }
}

function installClient(current: Probe) {
  class Query {
    table: string;
    filters: Record<string, unknown> = {};
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
    single() {
      this.one = true;
      return this;
    }
    maybeSingle() {
      this.one = true;
      return this;
    }

    then(ok: (value: unknown) => unknown, bad?: (reason: unknown) => unknown) {
      return Promise.resolve().then(() => this.execute()).then(ok, bad);
    }

    execute() {
      if (this.op !== "select") {
        current.mutations.push({ table: this.table, op: this.op });
        return { data: this.op === "insert" ? { id: "synthetic-inserted" } : null, error: null };
      }
      current.tableReads.push(this.table);
      if (current.failingTables.includes(this.table)) {
        return { data: null, error: { message: `${RAW_DRIVER_TEXT}` } };
      }
      if (this.table === "app_settings") {
        const key = String(this.filters.key ?? "");
        if (current.setting === "throw") throw new Error(`${RAW_DRIVER_TEXT}`);
        if (current.setting === "driver-error") {
          return { data: null, error: { message: `${RAW_DRIVER_TEXT}` } };
        }
        if (current.setting === "malformed") return { data: { unexpected: true }, error: null };
        if (current.setting === "absent") return { data: null, error: null };
        if (key !== "credential_facebook_user_mode") return { data: null, error: null };
        return { data: { value: current.setting }, error: null };
      }
      const rows = rowsFor(current, this.table).filter((row) => {
        for (const [key, value] of Object.entries(this.filters)) {
          if (row[key] !== value) return false;
        }
        return true;
      });
      return { data: this.one ? rows[0] ?? null : rows, error: null };
    }
  }

  return {
    from: (table: string) => new Query(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      current.rpcCalls.push({ name, args });
      if (current.rpcMode === "throw") throw new Error(`${RAW_DRIVER_TEXT}`);
      if (current.rpcMode === "malformed") return { data: { unexpected: true }, error: null };
      if (current.rpcMode === "missing-error") return { data: { attempt_id: ATTEMPT_ID } };
      if (current.rpcMode === "refused") {
        return { data: null, error: { message: RAW_DRIVER_TEXT, code: "MOA02" } };
      }
      const rpcError = current.rpcErrors[name];
      if (rpcError) return { data: null, error: rpcError };
      const override = current.rpcOverrides[name];
      const data = override !== undefined ? override : defaultRpcResult(name, args, current);
      return { data, error: null };
    },
    auth: {
      getClaims: async () => ({ data: { claims: { sub: current.userId } }, error: null }),
      getUser: async () => ({ data: { user: { id: current.userId } }, error: null }),
    },
  };
}

const originalFetch = globalThis.fetch;
const originalServe = Deno.serve;

function restoreProcess(savedEnv: Map<string, string | undefined>) {
  globalThis.fetch = originalFetch;
  Deno.serve = originalServe;
  const target = globals();
  delete target.__postoraProbe;
  delete target.__postoraRouteClient;
  for (const [key, value] of savedEnv) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
}

globalThis.addEventListener("unload", () => {
  globalThis.fetch = originalFetch;
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

function stubSource(): string {
  return `
    const P = () => globalThis.__postoraProbe;
    export const createClient = () => globalThis.__postoraRouteClient;
    export async function authenticateCaller() {
      return { userId: P().userId, isServiceRole: false };
    }
    export async function cacheAvatarToCdn() { return "https://cdn.invalid/avatar.png"; }
  `;
}

const bundles = new Map<string, string>();
let importSeq = 0;

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
          // The signed-state module is deliberately NOT stubbed: the production
          // verifier has to reject a tampered, expired or wrongly routed state.
          const ports = ["avatar-cache.ts", "auth-helper.ts"];
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
  const client = installClient(current);
  globals().__postoraProbe = current;
  globals().__postoraRouteClient = client;
  for (const [key, value] of Object.entries(ENV)) Deno.env.set(key, value);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? init.body : undefined;
    current.http.push({ url, body });
    const result = current.providerFetch(url);
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
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

interface ProbeGlobals {
  __postoraProbe?: Probe;
  __postoraRouteClient?: unknown;
}

function globals(): ProbeGlobals {
  return globalThis as unknown as ProbeGlobals;
}

function authHeaders(): HeadersInit {
  return {
    Authorization: "Bearer synthetic-user",
    "Content-Type": "application/json",
  };
}

async function callJson(
  handler: (req: Request) => Promise<Response> | Response,
  url: string,
  body: unknown,
) {
  const response = await handler(new Request(url, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() };
}

function providerUrls(current: Probe): string[] {
  return current.http
    .map((call) => call.url)
    .filter((url) =>
      url.includes("graph.facebook.com") ||
      url.includes("graph.instagram.com") ||
      url.includes("api.instagram.com")
    );
}

function rpcNames(current: Probe): string[] {
  return current.rpcCalls.map((call) => call.name);
}

// ---------------------------------------------------------------------------
// Signed state
// ---------------------------------------------------------------------------

function base64UrlEncode(input: Uint8Array | string): string {
  const bin = typeof input === "string"
    ? input
    : Array.from(input).map((b) => String.fromCharCode(b)).join("");
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function signState(payload: Record<string, unknown>): Promise<string> {
  const raw = JSON.stringify(payload);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(STATE_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(raw),
  );
  return `${base64UrlEncode(raw)}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function protectedState(options: {
  platform: string;
  flow: string;
  sqlFlow?: string;
  attemptId?: string;
  nonce?: string;
  returnTo?: string;
  extra?: Record<string, unknown>;
}): Promise<string> {
  return await createOAuthState({
    platform: options.platform,
    flow: options.flow,
    user_id: USER_ID,
    profile_id: null,
    return_to: options.returnTo ?? "https://postora.cloud/profiles",
    extra: {
      ...(options.extra ?? {}),
      meta_attempt: {
        attempt_id: options.attemptId ?? ATTEMPT_ID,
        nonce: options.nonce ?? NONCE,
        flow: options.sqlFlow ?? "facebook_page",
      },
    },
  });
}

function legacyState(options: { platform: string; flow: string }): Promise<string> {
  return createOAuthState({
    platform: options.platform,
    flow: options.flow,
    user_id: USER_ID,
    profile_id: null,
    return_to: "https://postora.cloud/profiles",
    extra: options.platform === "facebook" ? { target_platform: "facebook" } : undefined,
  });
}

// ---------------------------------------------------------------------------
// Protected authorize
// ---------------------------------------------------------------------------

routeTest("protected authorize captures the attempt before the authorization URL is returned", async () => {
  const current = probe({ setting: "protected" });
  const handler = await loadHandler("facebook-oauth/index.ts", current);
  const result = await callJson(
    handler,
    "https://synthetic.invalid/functions/v1/facebook-oauth",
    { action: "authorize", social_profile_id: null },
  );

  assertEquals(result.status, 200);
  assertEquals(rpcNames(current), ["begin_meta_oauth_attempt"]);
  const begin = current.rpcCalls[0].args.p_payload as Record<string, unknown>;
  assertEquals(begin.flow, "facebook_page");
  assertEquals(begin.intent, "connect_new");
  assertEquals(providerUrls(current), []);
  assertEquals(current.mutations, []);

  const url = new URL(String(result.body.url));
  const state = url.searchParams.get("state") ?? "";
  assertEquals(state.length > 0, true);
  assertEquals(state.includes(CLAIM_TOKEN), false);
  assertEquals(state.includes(NONCE), false);
});

routeTest("protected authorize names the owned target of a reconnect", async () => {
  const current = probe({ setting: "protected" });
  const handler = await loadHandler("facebook-oauth/index.ts", current);
  const result = await callJson(
    handler,
    "https://synthetic.invalid/functions/v1/facebook-oauth",
    {
      action: "authorize",
      intent: "reconnect",
      target_social_account_id: TARGET_ID,
    },
  );
  assertEquals(result.status, 200);
  const begin = current.rpcCalls[0].args.p_payload as Record<string, unknown>;
  assertEquals(begin.intent, "reconnect");
  assertEquals(begin.target_social_account_id, TARGET_ID);
});

routeTest("protected authorize names the owned source of a grant extension", async () => {
  const current = probe({ setting: "protected" });
  const handler = await loadHandler("instagram-business-oauth/index.ts", current);
  const result = await callJson(
    handler,
    "https://synthetic.invalid/functions/v1/instagram-business-oauth",
    {
      action: "authorize",
      intent: "add_to_existing_grant",
      source_social_account_id: SOURCE_ID,
    },
  );
  assertEquals(result.status, 200);
  const begin = current.rpcCalls[0].args.p_payload as Record<string, unknown>;
  assertEquals(begin.flow, "instagram_page_linked");
  assertEquals(begin.intent, "add_to_existing_grant");
  assertEquals(begin.source_social_account_id, SOURCE_ID);
});

routeTest("protected direct authorize captures the direct flow", async () => {
  const current = probe({ setting: "protected" });
  const handler = await loadHandler("instagram-oauth/index.ts", current);
  const result = await callJson(
    handler,
    "https://synthetic.invalid/functions/v1/instagram-oauth",
    { action: "authorize" },
  );
  assertEquals(result.status, 200);
  const begin = current.rpcCalls[0].args.p_payload as Record<string, unknown>;
  assertEquals(begin.flow, "instagram_direct");
});

routeTest("legacy authorize does not capture an attempt", async () => {
  const current = probe({ setting: "legacy" });
  const handler = await loadHandler("facebook-oauth/index.ts", current);
  const result = await callJson(
    handler,
    "https://synthetic.invalid/functions/v1/facebook-oauth",
    { action: "authorize" },
  );
  assertEquals(result.status, 200);
  assertEquals(rpcNames(current), []);
  assertEquals(current.mutations, []);
});

routeTest("an unreadable mode is a typed failure and captures nothing", async () => {
  for (const setting of ["throw", "driver-error", "malformed"] as const) {
    const current = probe({ setting });
    const handler = await loadHandler("facebook-oauth/index.ts", current);
    const result = await callJson(
      handler,
      "https://synthetic.invalid/functions/v1/facebook-oauth",
      { action: "authorize" },
    );
    assertEquals(result.status, 503);
    assertEquals(result.body.error_code, "CREDENTIAL_CONFIGURATION_UNAVAILABLE");
    assertEquals(rpcNames(current), []);
    assertEquals(providerUrls(current), []);
  }
});

// ---------------------------------------------------------------------------
// Protected callbacks
// ---------------------------------------------------------------------------

function metaProvider(current: Probe) {
  current.providerFetch = (url) => {
    if (url.includes("/oauth/access_token") && url.includes("graph.facebook.com")) {
      return { status: 200, body: { access_token: PROVIDER_TOKEN, expires_in: 5184000 } };
    }
    if (url.includes("api.instagram.com/oauth/access_token")) {
      return { status: 200, body: { access_token: PROVIDER_TOKEN, user_id: "igid-1" } };
    }
    if (url.includes("graph.instagram.com") && url.includes("ig_exchange_token")) {
      return { status: 200, body: { access_token: PROVIDER_TOKEN, expires_in: 5184000 } };
    }
    if (url.includes("graph.instagram.com") && url.includes("/me/permissions")) {
      return { status: 200, body: { data: [] } };
    }
    if (url.includes("graph.instagram.com") && url.includes("/me?")) {
      return {
        status: 200,
        body: {
          id: "ig-canonical",
          user_id: "ig-messaging",
          username: "shop",
          account_type: "BUSINESS",
          profile_picture_url: null,
        },
      };
    }
    if (url.includes("graph.facebook.com") && url.includes("/me?fields=id")) {
      return { status: 200, body: { id: "fb-user-1" } };
    }
    if (url.includes("graph.facebook.com") && url.includes("/me/accounts")) {
      return {
        status: 200,
        body: {
          data: [
            {
              id: "page-1",
              name: "Shop",
              access_token: PAGE_TOKEN,
              instagram_business_account: {
                id: "ig-1",
                username: "shop",
                profile_picture_url: null,
              },
            },
          ],
        },
      };
    }
    // Graph confirms subscribed_apps with this body. HTTP 200 alone does not.
    if (url.includes("subscribed_apps")) {
      return { status: 200, body: { success: true } };
    }
    return { status: 200, body: { data: [] } };
  };
}

routeTest("the protected Facebook callback claims the attempt before the provider exchange", async () => {
  const current = probe({ setting: "protected" });
  metaProvider(current);
  const handler = await loadHandler("facebook-oauth/index.ts", current);
  const state = await protectedState({ platform: "facebook", flow: "pages", sqlFlow: "facebook_page" });

  const response = await handler(new Request(
    `https://synthetic.invalid/functions/v1/facebook-oauth?code=code-1&state=${encodeURIComponent(state)}`,
    { method: "GET" },
  ));

  assertEquals(response.status, 302);
  assertEquals(rpcNames(current), [
    "claim_meta_oauth_callback",
    "complete_meta_oauth_callback",
  ]);
  const location = response.headers.get("location") ?? "";
  assertEquals(location.includes(`select=${PENDING_ID}`), true);
  assertEquals(location.includes(CLAIM_TOKEN), false);
  assertEquals(location.includes(PROVIDER_TOKEN), false);
  assertEquals(location.includes(PAGE_TOKEN), false);

  const claim = current.rpcCalls[0].args.p_payload as Record<string, unknown>;
  assertEquals(claim.attempt_id, ATTEMPT_ID);
  assertEquals(claim.nonce, NONCE);
  assertEquals(claim.flow, "facebook_page");
});

routeTest("the protected Facebook callback maps a Page with a linked Instagram account", async () => {
  const current = probe({ setting: "protected" });
  metaProvider(current);
  const handler = await loadHandler("facebook-oauth/index.ts", current);
  const state = await protectedState({ platform: "facebook", flow: "pages", sqlFlow: "facebook_page" });
  await handler(new Request(
    `https://synthetic.invalid/functions/v1/facebook-oauth?code=code-1&state=${encodeURIComponent(state)}`,
    { method: "GET" },
  ));
  const complete = current.rpcCalls[1].args.p_payload as Record<string, unknown>;
  const stash = complete.stash as Record<string, unknown>;
  const candidates = stash.candidates as Record<string, unknown>[];
  assertEquals(candidates.length, 1);
  assertEquals(candidates[0].candidate_kind, "page_plus_ig");
  assertEquals(candidates[0].facebook_page_id, "page-1");
  assertEquals(candidates[0].ig_user_id, "ig-1");
  assertEquals(candidates[0].facebook_user_id, "fb-user-1");
});

routeTest("the protected Page-linked callback maps an Instagram-only candidate", async () => {
  const current = probe({ setting: "protected" });
  metaProvider(current);
  const handler = await loadHandler("instagram-business-oauth/index.ts", current);
  const state = await protectedState({
    platform: "instagram",
    flow: "facebook_business",
    sqlFlow: "instagram_page_linked",
  });
  const response = await handler(new Request(
    `https://synthetic.invalid/functions/v1/instagram-business-oauth?code=code-1&state=${encodeURIComponent(state)}`,
    { method: "GET" },
  ));
  assertEquals(response.status, 302);
  const complete = current.rpcCalls[1].args.p_payload as Record<string, unknown>;
  const stash = complete.stash as Record<string, unknown>;
  const candidates = stash.candidates as Record<string, unknown>[];
  assertEquals(candidates[0].candidate_kind, "ig_only");
  assertEquals(candidates[0].ig_user_id, "ig-1");
  assertEquals(candidates[0].facebook_user_id, "fb-user-1");
  assertEquals(stash.user_token, PROVIDER_TOKEN);
  assertEquals(stash.user_token_expires_in, 5184000);
  const location = response.headers.get("location") ?? "";
  assertEquals(location.includes("connected=instagram_business"), true);
});

routeTest("the protected direct callback needs both Instagram identities", async () => {
  const current = probe({
    setting: "protected",
    // Named fixture correction: the fresh callback commits only after the
    // stashed candidate carries both identities. The mock complete RPC does
    // not insert that row, so the test seeds the row SQL would have written.
    instagramRows: [protectedPendingRow({
      ig_candidates_json: [{ ig_user_id: "ig-canonical", ig_igid: "ig-messaging" }],
    })],
    attemptRows: [{
      id: ATTEMPT_ID,
      user_id: USER_ID,
      meta_oauth_attempt_id: ATTEMPT_ID,
      flow: "instagram_direct",
    }],
    socialRows: [{
      id: ACCOUNT_ID,
      user_id: USER_ID,
      platform: "instagram",
      platform_user_id: "ig-canonical",
      access_token: PAGE_TOKEN,
    }],
  });
  metaProvider(current);
  const handler = await loadHandler("instagram-oauth/index.ts", current);
  const state = await protectedState({
    platform: "instagram",
    flow: "direct",
    sqlFlow: "instagram_direct",
  });
  const response = await handler(new Request(
    `https://synthetic.invalid/functions/v1/instagram-oauth?code=code-1&state=${encodeURIComponent(state)}`,
    { method: "GET" },
  ));
  assertEquals(response.status, 302);
  const complete = current.rpcCalls.find((call) => call.name === "complete_meta_oauth_callback");
  assertEquals(complete !== undefined, true);
  const stash = (complete!.args.p_payload as Record<string, unknown>).stash as Record<string, unknown>;
  const candidates = stash.candidates as Record<string, unknown>[];
  assertEquals(candidates[0].ig_user_id, "ig-canonical");
  assertEquals(candidates[0].ig_igid, "ig-messaging");
  // The direct flow commits its own verified candidate.
  assertEquals(rpcNames(current).includes("commit_meta_oauth_selection"), true);
  const location = response.headers.get("location") ?? "";
  assertEquals(location.includes("connected=instagram"), true);
  assertEquals(location.includes("warning="), false);
});

routeTest("a direct callback without the messaging identity never completes", async () => {
  const current = probe({ setting: "protected" });
  current.providerFetch = (url) => {
    if (url.includes("api.instagram.com/oauth/access_token")) {
      return { status: 200, body: { access_token: PROVIDER_TOKEN, user_id: "igid-1" } };
    }
    if (url.includes("graph.instagram.com") && url.includes("ig_exchange_token")) {
      return { status: 200, body: { access_token: PROVIDER_TOKEN, expires_in: 5184000 } };
    }
    if (url.includes("graph.instagram.com") && url.includes("/me/permissions")) {
      return { status: 200, body: { data: [] } };
    }
    if (url.includes("graph.instagram.com") && url.includes("/me?")) {
      return {
        status: 200,
        body: { id: "ig-canonical", username: "shop", account_type: "BUSINESS" },
      };
    }
    return { status: 200, body: { data: [] } };
  };
  const handler = await loadHandler("instagram-oauth/index.ts", current);
  const state = await protectedState({
    platform: "instagram",
    flow: "direct",
    sqlFlow: "instagram_direct",
  });
  const response = await handler(new Request(
    `https://synthetic.invalid/functions/v1/instagram-oauth?code=code-1&state=${encodeURIComponent(state)}`,
    { method: "GET" },
  ));
  assertEquals(response.status, 302);
  assertEquals(rpcNames(current).includes("complete_meta_oauth_callback"), false);
  assertEquals(rpcNames(current).includes("commit_meta_oauth_selection"), false);
  const location = response.headers.get("location") ?? "";
  assertEquals(location.includes("PROTECTED_OAUTH_IDENTITY_UNVERIFIED"), true);
});

routeTest("a duplicate claim refuses before any provider call", async () => {
  const current = probe({ setting: "protected" });
  metaProvider(current);
  current.rpcErrors.claim_meta_oauth_callback = {
    message: RAW_DRIVER_TEXT,
    code: "MOA03",
  };
  const handler = await loadHandler("facebook-oauth/index.ts", current);
  const state = await protectedState({ platform: "facebook", flow: "pages", sqlFlow: "facebook_page" });
  const response = await handler(new Request(
    `https://synthetic.invalid/functions/v1/facebook-oauth?code=code-1&state=${encodeURIComponent(state)}`,
    { method: "GET" },
  ));
  assertEquals(response.status, 302);
  assertEquals(providerUrls(current), []);
  assertEquals(rpcNames(current).includes("complete_meta_oauth_callback"), false);
  assertEquals(current.mutations, []);
});

routeTest("a tampered state never reaches the claim or the provider", async () => {
  const current = probe({ setting: "protected" });
  metaProvider(current);
  const handler = await loadHandler("facebook-oauth/index.ts", current);
  const state = await protectedState({ platform: "facebook", flow: "pages", sqlFlow: "facebook_page" });
  const tampered = `${state.slice(0, state.length - 4)}AAAA`;
  const response = await handler(new Request(
    `https://synthetic.invalid/functions/v1/facebook-oauth?code=code-1&state=${encodeURIComponent(tampered)}`,
    { method: "GET" },
  ));
  assertEquals(response.status, 302);
  const location = response.headers.get("location") ?? "";
  assertEquals(location.includes("invalid_state"), true);
  assertEquals(rpcNames(current), []);
  assertEquals(providerUrls(current), []);
});

routeTest("an expired state never reaches the claim or the provider", async () => {
  const current = probe({ setting: "protected" });
  metaProvider(current);
  const handler = await loadHandler("facebook-oauth/index.ts", current);
  const expired = await signState({
    platform: "facebook",
    flow: "pages",
    user_id: USER_ID,
    profile_id: null,
    nonce: NONCE,
    iat: Math.floor(Date.now() / 1000) - 3600,
    meta_attempt: { attempt_id: ATTEMPT_ID, nonce: NONCE, flow: "facebook_page" },
  });
  const response = await handler(new Request(
    `https://synthetic.invalid/functions/v1/facebook-oauth?code=code-1&state=${encodeURIComponent(expired)}`,
    { method: "GET" },
  ));
  assertEquals(response.status, 302);
  assertEquals(rpcNames(current), []);
  assertEquals(providerUrls(current), []);
});

routeTest("a state minted for another flow is refused before the provider", async () => {
  const current = probe({ setting: "protected" });
  metaProvider(current);
  const handler = await loadHandler("instagram-oauth/index.ts", current);
  const state = await protectedState({
    platform: "instagram",
    flow: "direct",
    sqlFlow: "instagram_page_linked",
  });
  const response = await handler(new Request(
    `https://synthetic.invalid/functions/v1/instagram-oauth?code=code-1&state=${encodeURIComponent(state)}`,
    { method: "GET" },
  ));
  assertEquals(response.status, 302);
  const location = response.headers.get("location") ?? "";
  assertEquals(location.includes("protected_oauth_flow_mismatch"), true);
  assertEquals(rpcNames(current), []);
  assertEquals(providerUrls(current), []);
});

routeTest("a legacy callback in protected mode refuses and asks for a restart", async () => {
  const current = probe({ setting: "protected" });
  metaProvider(current);
  const handler = await loadHandler("facebook-oauth/index.ts", current);
  const state = await legacyState({ platform: "facebook", flow: "pages" });
  const response = await handler(new Request(
    `https://synthetic.invalid/functions/v1/facebook-oauth?code=code-1&state=${encodeURIComponent(state)}`,
    { method: "GET" },
  ));
  assertEquals(response.status, 302);
  const location = response.headers.get("location") ?? "";
  assertEquals(location.includes("protected_reauthorization_required"), true);
  assertEquals(providerUrls(current), []);
  assertEquals(current.mutations, []);
});

routeTest("the unsigned direct POST callback shim stays refused in protected mode", async () => {
  const current = probe({ setting: "protected" });
  metaProvider(current);
  const handler = await loadHandler("instagram-oauth/index.ts", current);
  const result = await callJson(
    handler,
    "https://synthetic.invalid/functions/v1/instagram-oauth",
    { action: "callback", code: "code-1", user_id: OTHER_USER_ID },
  );
  assertEquals(result.status, 503);
  assertEquals(result.body.error_code, "lifecycle_prerequisite_missing");
  assertEquals(providerUrls(current), []);
  assertEquals(current.mutations, []);
});

routeTest("a signed captured attempt keeps its protected lifecycle after a mode flip", async () => {
  const current = probe({ setting: "legacy" });
  metaProvider(current);
  const handler = await loadHandler("facebook-oauth/index.ts", current);
  const state = await protectedState({ platform: "facebook", flow: "pages", sqlFlow: "facebook_page" });
  const response = await handler(new Request(
    `https://synthetic.invalid/functions/v1/facebook-oauth?code=code-1&state=${encodeURIComponent(state)}`,
    { method: "GET" },
  ));
  assertEquals(response.status, 302);
  assertEquals(rpcNames(current), [
    "claim_meta_oauth_callback",
    "complete_meta_oauth_callback",
  ]);
  const location = response.headers.get("location") ?? "";
  assertEquals(location.includes(`select=${PENDING_ID}`), true);
});

routeTest("a refused capture never returns an authorization URL", async () => {
  const current = probe({ setting: "protected" });
  current.rpcErrors.begin_meta_oauth_attempt = {
    message: RAW_DRIVER_TEXT,
    code: "MOA02",
  };
  const handler = await loadHandler("facebook-oauth/index.ts", current);
  const result = await callJson(
    handler,
    "https://synthetic.invalid/functions/v1/facebook-oauth",
    { action: "authorize", intent: "reconnect", target_social_account_id: TARGET_ID },
  );
  assertEquals(result.status, 403);
  assertEquals(result.body.error_code, "PROTECTED_OAUTH_REFUSED");
  assertEquals(result.body.url, undefined);
  assertEquals(JSON.stringify(result.body).includes(RAW_DRIVER_TEXT), false);
  assertEquals(providerUrls(current), []);
});

routeTest("a wrong provider identity refuses the commit and never reports success", async () => {
  const current = probe({
    setting: "protected",
    instagramRows: [protectedPendingRow()],
    attemptRows: [{
      id: ATTEMPT_ID,
      user_id: USER_ID,
      meta_oauth_attempt_id: ATTEMPT_ID,
      flow: "facebook_page",
    }],
  });
  // MOA07 is the accepted stale-capture refusal: the provider identity does
  // not match the captured target.
  current.rpcErrors.commit_meta_oauth_selection = {
    message: RAW_DRIVER_TEXT,
    code: "MOA07",
  };
  const handler = await loadHandler("facebook-oauth/index.ts", current);
  const result = await callJson(
    handler,
    "https://synthetic.invalid/functions/v1/facebook-oauth",
    {
      action: "store_page",
      selection_id: PENDING_ID,
      attempt_id: ATTEMPT_ID,
      selection_key: "facebook_page:page:page-1",
    },
  );
  assertEquals(result.status, 409);
  assertEquals(result.body.success, undefined);
  assertEquals(JSON.stringify(result.body).includes(RAW_DRIVER_TEXT), false);
  assertEquals(current.mutations, []);
});

routeTest("successive selections commit one receipt each and never delete the stash", async () => {
  const current = probe({
    setting: "protected",
    instagramRows: [protectedPendingRow()],
    attemptRows: [{
      id: ATTEMPT_ID,
      user_id: USER_ID,
      meta_oauth_attempt_id: ATTEMPT_ID,
      flow: "facebook_page",
    }],
  });
  const handler = await loadHandler("facebook-oauth/index.ts", current);
  for (const selectionKey of ["facebook_page:page:page-1", "facebook_page:page:page-2"]) {
    const result = await callJson(
      handler,
      "https://synthetic.invalid/functions/v1/facebook-oauth",
      {
        action: "store_page",
        selection_id: PENDING_ID,
        attempt_id: ATTEMPT_ID,
        selection_key: selectionKey,
      },
    );
    assertEquals(result.status, 200);
  }
  const commits = current.rpcCalls.filter((call) => call.name === "commit_meta_oauth_selection");
  assertEquals(commits.length, 2);
  // The remaining candidates and the final stash consumption belong to the
  // accepted SQL transaction, not to the handler.
  assertEquals(current.mutations, []);
});

// ---------------------------------------------------------------------------
// Every-mode pending classification
// ---------------------------------------------------------------------------

function protectedPendingRow(overrides: Partial<Row> = {}): Row {
  return {
    id: PENDING_ID,
    user_id: USER_ID,
    meta_oauth_attempt_id: ATTEMPT_ID,
    expires_at: new Date(Date.now() + 60000).toISOString(),
    ig_candidates_json: [],
    ...overrides,
  };
}

routeTest("a protected pending row is read through the protected adapter in protected mode", async () => {
  const current = probe({
    setting: "protected",
    instagramRows: [protectedPendingRow()],
  });
  const handler = await loadHandler("instagram-business-oauth/index.ts", current);
  const result = await callJson(
    handler,
    "https://synthetic.invalid/functions/v1/instagram-business-oauth",
    { action: "get_pending_selection", selection_id: PENDING_ID },
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.protected, true);
  assertEquals(rpcNames(current), ["read_meta_oauth_attempt"]);
  assertEquals(result.body.attempt_id, ATTEMPT_ID);
  assertEquals(JSON.stringify(result.body).includes(PROVIDER_TOKEN), false);
});

routeTest("a protected pending row still routes to the protected adapter after a mode flip", async () => {
  const current = probe({
    setting: "legacy",
    instagramRows: [protectedPendingRow()],
  });
  const handler = await loadHandler("instagram-business-oauth/index.ts", current);
  const result = await callJson(
    handler,
    "https://synthetic.invalid/functions/v1/instagram-business-oauth",
    { action: "get_pending_selection", selection_id: PENDING_ID },
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.protected, true);
  assertEquals(rpcNames(current), ["read_meta_oauth_attempt"]);
});

routeTest("a pending reference combined with a provider token is refused before any work", async () => {
  for (const setting of ["protected", "legacy"] as const) {
    const current = probe({
      setting,
      instagramRows: [protectedPendingRow()],
    });
    const handler = await loadHandler("instagram-business-oauth/index.ts", current);
    const result = await callJson(
      handler,
      "https://synthetic.invalid/functions/v1/instagram-business-oauth",
      {
        action: "get_pending_selection",
        selection_id: PENDING_ID,
        provider_token: PROVIDER_TOKEN,
      },
    );
    assertEquals(result.status, 400);
    assertEquals(result.body.error_code, "PROTECTED_OAUTH_AMBIGUOUS_REFERENCE");
    assertEquals(rpcNames(current), []);
    assertEquals(providerUrls(current), []);
    assertEquals(current.mutations, []);
  }
});

routeTest("a foreign pending row is refused", async () => {
  const current = probe({
    setting: "protected",
    instagramRows: [protectedPendingRow({ user_id: OTHER_USER_ID })],
  });
  const handler = await loadHandler("instagram-business-oauth/index.ts", current);
  const result = await callJson(
    handler,
    "https://synthetic.invalid/functions/v1/instagram-business-oauth",
    { action: "get_pending_selection", selection_id: PENDING_ID },
  );
  assertEquals(result.status, 403);
  assertEquals(result.body.error_code, "PROTECTED_OAUTH_REFERENCE_FOREIGN");
  assertEquals(rpcNames(current), []);
});

routeTest("a failed pending read is a typed failure, never a legacy fallback", async () => {
  const current = probe({
    setting: "legacy",
    failingTables: ["oauth_pending_instagram_selections"],
  });
  const handler = await loadHandler("instagram-business-oauth/index.ts", current);
  const result = await callJson(
    handler,
    "https://synthetic.invalid/functions/v1/instagram-business-oauth",
    { action: "get_pending_selection", selection_id: PENDING_ID },
  );
  assertEquals(result.status, 503);
  assertEquals(result.body.error_code, "PROTECTED_OAUTH_READ_FAILED");
  assertEquals(rpcNames(current), []);
  assertEquals(current.mutations, []);
});

routeTest("a missing pending row is a not-found refusal", async () => {
  const current = probe({ setting: "protected" });
  const handler = await loadHandler("instagram-business-oauth/index.ts", current);
  const result = await callJson(
    handler,
    "https://synthetic.invalid/functions/v1/instagram-business-oauth",
    { action: "get_pending_selection", selection_id: PENDING_ID },
  );
  assertEquals(result.status, 404);
  assertEquals(rpcNames(current), []);
});

// ---------------------------------------------------------------------------
// Picker, commit and close
// ---------------------------------------------------------------------------

routeTest("the protected picker read returns only the safe projection", async () => {
  const current = probe({
    setting: "protected",
    instagramRows: [protectedPendingRow()],
  });
  const handler = await loadHandler("instagram-business-oauth/index.ts", current);
  const result = await callJson(
    handler,
    "https://synthetic.invalid/functions/v1/instagram-business-oauth",
    { action: "get_pending_selection", selection_id: PENDING_ID },
  );
  const body = JSON.stringify(result.body);
  assertEquals(body.includes(PROVIDER_TOKEN), false);
  assertEquals(body.includes(CLAIM_TOKEN), false);
  assertEquals(body.includes(RAW_DRIVER_TEXT), false);
  assertEquals(result.body.committed_selection_keys, []);
  assertEquals(result.body.ig_accounts[0].selection_key, "facebook_page:page:page-1");
});

routeTest("the protected commit uses the attempt id and the opaque selection key", async () => {
  const current = probe({
    setting: "protected",
    instagramRows: [protectedPendingRow()],
    attemptRows: [{
      id: ATTEMPT_ID,
      user_id: USER_ID,
      meta_oauth_attempt_id: ATTEMPT_ID,
      flow: "facebook_page",
    }],
  });
  const handler = await loadHandler("facebook-oauth/index.ts", current);
  const result = await callJson(
    handler,
    "https://synthetic.invalid/functions/v1/facebook-oauth",
    {
      action: "store_page",
      selection_id: PENDING_ID,
      attempt_id: ATTEMPT_ID,
      selection_key: "facebook_page:page:page-1",
    },
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.protected, true);
  const commit = current.rpcCalls.find((call) => call.name === "commit_meta_oauth_selection");
  assertEquals(commit !== undefined, true);
  const payload = commit!.args.p_payload as Record<string, unknown>;
  assertEquals(payload.attempt_id, ATTEMPT_ID);
  assertEquals(payload.selection_key, "facebook_page:page:page-1");
  // The protected path never relinks the account to the profile itself and
  // never writes a social account row.
  assertEquals(current.mutations, []);
});

routeTest("a protected commit that belongs to another flow is refused", async () => {
  const current = probe({
    setting: "protected",
    instagramRows: [protectedPendingRow()],
    attemptRows: [{
      id: ATTEMPT_ID,
      user_id: USER_ID,
      meta_oauth_attempt_id: ATTEMPT_ID,
      flow: "instagram_direct",
    }],
  });
  const handler = await loadHandler("facebook-oauth/index.ts", current);
  const result = await callJson(
    handler,
    "https://synthetic.invalid/functions/v1/facebook-oauth",
    {
      action: "store_page",
      selection_id: PENDING_ID,
      attempt_id: ATTEMPT_ID,
      selection_key: "facebook_page:page:page-1",
    },
  );
  assertEquals(result.status, 409);
  assertEquals(result.body.error_code, "PROTECTED_OAUTH_CONFLICT");
  assertEquals(rpcNames(current).includes("commit_meta_oauth_selection"), false);
});

routeTest("an existing receipt replays instead of committing twice", async () => {
  const current = probe({
    setting: "protected",
    instagramRows: [],
    attemptRows: [{
      id: ATTEMPT_ID,
      user_id: USER_ID,
      meta_oauth_attempt_id: ATTEMPT_ID,
      flow: "facebook_page",
    }],
    receiptRows: [{
      id: "receipt-1",
      user_id: USER_ID,
      attempt_id: ATTEMPT_ID,
      selection_key: "facebook_page:page:page-1",
    }],
    // Named fixture correction: the operational token row lets the test see
    // the reassertion. The response no longer carries replayed or reasserted.
    socialRows: [{
      id: ACCOUNT_ID,
      user_id: USER_ID,
      platform: "facebook",
      platform_user_id: "page-1",
      access_token: PAGE_TOKEN,
    }],
  });
  metaProvider(current);
  const handler = await loadHandler("facebook-oauth/index.ts", current);
  const result = await callJson(
    handler,
    "https://synthetic.invalid/functions/v1/facebook-oauth",
    {
      action: "store_page",
      attempt_id: ATTEMPT_ID,
      selection_key: "facebook_page:page:page-1",
    },
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.success, true);
  assertEquals(result.body.replayed, undefined);
  assertEquals(result.body.subscription.reasserted, undefined);
  assertEquals(result.body.subscription.status, "asserted");
  assertEquals(result.body.subscription.policy, "reassert_after_valid_receipt");
  const commits = current.rpcCalls.filter((call) => call.name === "commit_meta_oauth_selection");
  assertEquals(commits.length, 1);
  assertEquals(providerUrls(current).some((url) => url.includes("/oauth/access_token")), false);
  assertEquals(providerUrls(current).some((url) => url.includes("subscribed_apps")), true);
});

routeTest("closing an unexpired protected picker retains it and claims no deletion", async () => {
  const current = probe({
    setting: "protected",
    instagramRows: [protectedPendingRow()],
  });
  const handler = await loadHandler("instagram-business-oauth/index.ts", current);
  const result = await callJson(
    handler,
    "https://synthetic.invalid/functions/v1/instagram-business-oauth",
    { action: "clear_pending_selection", selection_id: PENDING_ID },
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.removed, false);
  assertEquals(result.body.retained_until_expiry, true);
  assertEquals(current.mutations, []);
});

routeTest("a legacy close still deletes the legacy stash", async () => {
  const current = probe({
    setting: "legacy",
    instagramRows: [{
      id: PENDING_ID,
      user_id: USER_ID,
      meta_oauth_attempt_id: null,
      expires_at: new Date(Date.now() + 60000).toISOString(),
    }],
  });
  const handler = await loadHandler("instagram-business-oauth/index.ts", current);
  const result = await callJson(
    handler,
    "https://synthetic.invalid/functions/v1/instagram-business-oauth",
    { action: "clear_pending_selection", selection_id: PENDING_ID },
  );
  assertEquals(result.status, 200);
  assertEquals(
    current.mutations.some((mutation) =>
      mutation.table === "oauth_pending_instagram_selections" && mutation.op === "delete"
    ),
    true,
  );
});

routeTest("a legacy selection is refused by the protected lifecycle", async () => {
  const current = probe({
    setting: "protected",
    instagramRows: [{
      id: PENDING_ID,
      user_id: USER_ID,
      meta_oauth_attempt_id: null,
      expires_at: new Date(Date.now() + 60000).toISOString(),
    }],
  });
  const handler = await loadHandler("instagram-business-oauth/index.ts", current);
  const result = await callJson(
    handler,
    "https://synthetic.invalid/functions/v1/instagram-business-oauth",
    {
      action: "store_ig_account",
      selection_id: PENDING_ID,
      ig_user_id: "ig-1",
    },
  );
  assertEquals(result.status, 403);
  assertEquals(result.body.error_code, "PROTECTED_OAUTH_REFUSED");
  assertEquals(providerUrls(current), []);
  assertEquals(current.mutations, []);
});

// ---------------------------------------------------------------------------
// Post-commit subscription
// ---------------------------------------------------------------------------

routeTest("the post-commit subscription is asserted after the commit", async () => {
  const current = probe({
    setting: "protected",
    instagramRows: [protectedPendingRow()],
    attemptRows: [{
      id: ATTEMPT_ID,
      user_id: USER_ID,
      meta_oauth_attempt_id: ATTEMPT_ID,
      flow: "facebook_page",
    }],
    socialRows: [{
      id: ACCOUNT_ID,
      user_id: USER_ID,
      platform: "facebook",
      platform_user_id: "page-1",
      access_token: PAGE_TOKEN,
    }],
  });
  current.providerFetch = (url) => {
    if (url.includes("subscribed_apps")) return { status: 200, body: { success: true } };
    return { status: 200, body: { data: [] } };
  };
  const handler = await loadHandler("facebook-oauth/index.ts", current);
  const result = await callJson(
    handler,
    "https://synthetic.invalid/functions/v1/facebook-oauth",
    {
      action: "store_page",
      selection_id: PENDING_ID,
      attempt_id: ATTEMPT_ID,
      selection_key: "facebook_page:page:page-1",
    },
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.subscription.status, "asserted");
  assertEquals(result.body.subscription.policy, "reassert_after_valid_receipt");
  const subscription = providerUrls(current).filter((url) => url.includes("subscribed_apps"));
  assertEquals(subscription.length, 1);
  // The subscription reads the operational authority, never a browser field.
  assertEquals(subscription[0].includes(PAGE_TOKEN), true);
});

routeTest("a failed post-commit subscription is a warning and not a rollback", async () => {
  const current = probe({
    setting: "protected",
    instagramRows: [protectedPendingRow()],
    attemptRows: [{
      id: ATTEMPT_ID,
      user_id: USER_ID,
      meta_oauth_attempt_id: ATTEMPT_ID,
      flow: "facebook_page",
    }],
    socialRows: [{
      id: ACCOUNT_ID,
      user_id: USER_ID,
      platform: "facebook",
      platform_user_id: "page-1",
      access_token: PAGE_TOKEN,
    }],
  });
  current.providerFetch = (url) => {
    if (url.includes("subscribed_apps")) {
      return { status: 500, body: { error: { message: RAW_DRIVER_TEXT } } };
    }
    return { status: 200, body: { data: [] } };
  };
  const handler = await loadHandler("facebook-oauth/index.ts", current);
  const result = await callJson(
    handler,
    "https://synthetic.invalid/functions/v1/facebook-oauth",
    {
      action: "store_page",
      selection_id: PENDING_ID,
      attempt_id: ATTEMPT_ID,
      selection_key: "facebook_page:page:page-1",
    },
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.success, true);
  assertEquals(result.body.subscription.status, "failed");
  assertEquals(JSON.stringify(result.body).includes(RAW_DRIVER_TEXT), false);
});

routeTest("no provider token, claim token or driver text reaches a browser response", async () => {
  const current = probe({
    setting: "protected",
    instagramRows: [protectedPendingRow()],
    attemptRows: [{
      id: ATTEMPT_ID,
      user_id: USER_ID,
      meta_oauth_attempt_id: ATTEMPT_ID,
      flow: "instagram_page_linked",
    }],
  });
  const handler = await loadHandler("instagram-business-oauth/index.ts", current);
  const result = await callJson(
    handler,
    "https://synthetic.invalid/functions/v1/instagram-business-oauth",
    { action: "get_pending_selection", selection_id: PENDING_ID },
  );
  const body = JSON.stringify(result.body);
  assertEquals(body.includes(PROVIDER_TOKEN), false);
  assertEquals(body.includes(CLAIM_TOKEN), false);
  assertEquals(body.includes(PAGE_TOKEN), false);
  assertEquals(body.includes(RAW_DRIVER_TEXT), false);
});

// ---------------------------------------------------------------------------
// Correction regressions
// ---------------------------------------------------------------------------

async function withCapturedLogs(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalLog = console.log;
  const record = (...args: unknown[]) => {
    lines.push(args.map((arg) => {
      if (typeof arg === "string") return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return "unprintable";
      }
    }).join(" "));
  };
  console.error = record;
  console.warn = record;
  console.log = record;
  try {
    await fn();
    return lines.join("\n");
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
    console.log = originalLog;
  }
}

const CALLBACKS = [
  {
    entry: "facebook-oauth/index.ts",
    url: "https://synthetic.invalid/functions/v1/facebook-oauth",
    state: { platform: "facebook", flow: "pages", sqlFlow: "facebook_page" },
  },
  {
    entry: "instagram-oauth/index.ts",
    url: "https://synthetic.invalid/functions/v1/instagram-oauth",
    state: { platform: "instagram", flow: "direct", sqlFlow: "instagram_direct" },
  },
  {
    entry: "instagram-business-oauth/index.ts",
    url: "https://synthetic.invalid/functions/v1/instagram-business-oauth",
    state: { platform: "instagram", flow: "facebook_business", sqlFlow: "instagram_page_linked" },
  },
] as const;

routeTest("an unreadable mode refuses a signed callback before claim or provider", async () => {
  for (const setting of ["throw", "driver-error", "malformed"] as const) {
    for (const callback of CALLBACKS) {
      const current = probe({ setting });
      metaProvider(current);
      const handler = await loadHandler(callback.entry, current);
      const state = await protectedState(callback.state);
      const logs = await withCapturedLogs(async () => {
        const response = await handler(new Request(
          `${callback.url}?code=code-1&state=${encodeURIComponent(state)}`,
          { method: "GET" },
        ));
        assertEquals(response.status, 302);
        const location = response.headers.get("location") ?? "";
        assertEquals(location.includes("credential_configuration_unavailable"), true);
        assertEquals(location.includes(RAW_DRIVER_TEXT), false);
      });
      assertEquals(rpcNames(current), []);
      assertEquals(providerUrls(current), []);
      assertEquals(logs.includes(RAW_DRIVER_TEXT), false);
    }
  }
});

routeTest("a claim that disagrees with the request never calls the provider", async () => {
  for (const claim of [
    claimResult({ attempt_id: OTHER_USER_ID, flow: "facebook_page" }),
    claimResult({ flow: "instagram_direct" }),
  ]) {
    const current = probe({ setting: "protected" });
    current.rpcOverrides.claim_meta_oauth_callback = claim;
    metaProvider(current);
    const handler = await loadHandler("facebook-oauth/index.ts", current);
    const state = await protectedState({ platform: "facebook", flow: "pages", sqlFlow: "facebook_page" });
    const logs = await withCapturedLogs(async () => {
      const response = await handler(new Request(
        `https://synthetic.invalid/functions/v1/facebook-oauth?code=code-1&state=${encodeURIComponent(state)}`,
        { method: "GET" },
      ));
      const location = response.headers.get("location") ?? "";
      assertEquals(location.includes("PROTECTED_OAUTH_READ_FAILED"), true);
      assertEquals(location.includes("does not match"), false);
      assertEquals(location.includes(`select=${PENDING_ID}`), false);
    });
    assertEquals(providerUrls(current), []);
    assertEquals(rpcNames(current).includes("complete_meta_oauth_callback"), false);
    assertEquals(logs.includes(RAW_DRIVER_TEXT), false);
    assertEquals(logs.includes("does not match"), false);
  }
});

routeTest("a completion that disagrees with the request never commits", async () => {
  for (const complete of [
    completeResult({ attempt_id: OTHER_USER_ID }),
    completeResult({ flow: "instagram_direct" }),
  ]) {
    const current = probe({ setting: "protected" });
    current.rpcOverrides.complete_meta_oauth_callback = complete;
    metaProvider(current);
    const handler = await loadHandler("facebook-oauth/index.ts", current);
    const state = await protectedState({ platform: "facebook", flow: "pages", sqlFlow: "facebook_page" });
    const response = await handler(new Request(
      `https://synthetic.invalid/functions/v1/facebook-oauth?code=code-1&state=${encodeURIComponent(state)}`,
      { method: "GET" },
    ));
    const location = response.headers.get("location") ?? "";
    assertEquals(location.includes("PROTECTED_OAUTH_READ_FAILED"), true);
    assertEquals(location.includes(`select=${PENDING_ID}`), false);
    assertEquals(rpcNames(current).includes("claim_meta_oauth_callback"), true);
    assertEquals(rpcNames(current).includes("commit_meta_oauth_selection"), false);
  }
});

routeTest("a receipt that disagrees with the selection never reports success", async () => {
  const current = probe({
    setting: "protected",
    instagramRows: [protectedPendingRow()],
    attemptRows: [{
      id: ATTEMPT_ID,
      user_id: USER_ID,
      flow: "facebook_page",
    }],
  });
  current.rpcOverrides.commit_meta_oauth_selection = receiptResult({
    selection_key: "facebook_page:page:other",
  });
  const handler = await loadHandler("facebook-oauth/index.ts", current);
  const result = await callJson(
    handler,
    "https://synthetic.invalid/functions/v1/facebook-oauth",
    {
      action: "store_page",
      selection_id: PENDING_ID,
      attempt_id: ATTEMPT_ID,
      selection_key: "facebook_page:page:page-1",
    },
  );
  assertEquals(result.status, 503);
  assertEquals(result.body.error_code, "PROTECTED_OAUTH_READ_FAILED");
  assertEquals(result.body.success, undefined);
  assertEquals(providerUrls(current), []);
  assertEquals(JSON.stringify(result.body).includes("does not match"), false);
});

routeTest("a failed or malformed direct readiness read does not commit", async () => {
  const failed = probe({
    setting: "protected",
    failingTables: ["oauth_pending_instagram_selections"],
    attemptRows: [{ id: ATTEMPT_ID, user_id: USER_ID, flow: "instagram_direct" }],
  });
  metaProvider(failed);
  const failedHandler = await loadHandler("instagram-oauth/index.ts", failed);
  const state = await protectedState({ platform: "instagram", flow: "direct", sqlFlow: "instagram_direct" });
  const failedResponse = await failedHandler(new Request(
    `https://synthetic.invalid/functions/v1/instagram-oauth?code=code-1&state=${encodeURIComponent(state)}`,
    { method: "GET" },
  ));
  const failedLocation = failedResponse.headers.get("location") ?? "";
  assertEquals(failedLocation.includes("PROTECTED_OAUTH_READ_FAILED"), true);
  assertEquals(failedLocation.includes("connected=instagram"), false);
  assertEquals(rpcNames(failed).includes("complete_meta_oauth_callback"), true);
  assertEquals(rpcNames(failed).includes("commit_meta_oauth_selection"), false);
  assertEquals(failedLocation.includes(RAW_DRIVER_TEXT), false);

  const malformedRow = protectedPendingRow();
  delete malformedRow.ig_candidates_json;
  const malformed = probe({
    setting: "protected",
    instagramRows: [malformedRow],
    attemptRows: [{ id: ATTEMPT_ID, user_id: USER_ID, flow: "instagram_direct" }],
  });
  metaProvider(malformed);
  const malformedHandler = await loadHandler("instagram-oauth/index.ts", malformed);
  const malformedResponse = await malformedHandler(new Request(
    `https://synthetic.invalid/functions/v1/instagram-oauth?code=code-1&state=${encodeURIComponent(state)}`,
    { method: "GET" },
  ));
  const malformedLocation = malformedResponse.headers.get("location") ?? "";
  assertEquals(malformedLocation.includes("PROTECTED_OAUTH_READ_FAILED"), true);
  assertEquals(rpcNames(malformed).includes("commit_meta_oauth_selection"), false);

  const missing = probe({
    setting: "protected",
    attemptRows: [{ id: ATTEMPT_ID, user_id: USER_ID, flow: "instagram_direct" }],
  });
  metaProvider(missing);
  const missingHandler = await loadHandler("instagram-oauth/index.ts", missing);
  const missingResponse = await missingHandler(new Request(
    `https://synthetic.invalid/functions/v1/instagram-oauth?code=code-1&state=${encodeURIComponent(state)}`,
    { method: "GET" },
  ));
  const missingLocation = missingResponse.headers.get("location") ?? "";
  assertEquals(missingLocation.includes("direct_identity_unverified"), true);
  assertEquals(rpcNames(missing).includes("commit_meta_oauth_selection"), false);
});

routeTest("a direct profile HTTP 500 is not an identity", async () => {
  const current = probe({ setting: "protected" });
  current.providerFetch = (url) => {
    if (url.includes("api.instagram.com/oauth/access_token")) {
      return { status: 200, body: { access_token: PROVIDER_TOKEN, expires_in: 3600 } };
    }
    if (url.includes("ig_exchange_token")) {
      return { status: 200, body: { access_token: PROVIDER_TOKEN, expires_in: 5184000 } };
    }
    if (url.includes("/me?")) {
      return {
        status: 500,
        body: { id: "ig-canonical", user_id: "ig-messaging", account_type: "BUSINESS" },
      };
    }
    return { status: 200, body: { data: [] } };
  };
  const handler = await loadHandler("instagram-oauth/index.ts", current);
  const state = await protectedState({ platform: "instagram", flow: "direct", sqlFlow: "instagram_direct" });
  const logs = await withCapturedLogs(async () => {
    const response = await handler(new Request(
      `https://synthetic.invalid/functions/v1/instagram-oauth?code=code-1&state=${encodeURIComponent(state)}`,
      { method: "GET" },
    ));
    const location = response.headers.get("location") ?? "";
    assertEquals(location.includes("code_exchange_failed"), true);
    assertEquals(location.includes("connected=instagram"), false);
    assertEquals(location.includes(PROVIDER_TOKEN), false);
  });
  assertEquals(rpcNames(current).includes("complete_meta_oauth_callback"), false);
  assertEquals(rpcNames(current).includes("commit_meta_oauth_selection"), false);
  assertEquals(logs.includes(PROVIDER_TOKEN), false);
});

routeTest("a thrown provider error does not reach the log or the redirect", async () => {
  const current = probe({ setting: "protected" });
  current.providerFetch = () => {
    throw new Error(`provider blew up ${PROVIDER_TOKEN} https://graph.facebook.com/me?access_token=${PROVIDER_TOKEN}`);
  };
  const handler = await loadHandler("facebook-oauth/index.ts", current);
  const state = await protectedState({ platform: "facebook", flow: "pages", sqlFlow: "facebook_page" });
  const logs = await withCapturedLogs(async () => {
    const response = await handler(new Request(
      `https://synthetic.invalid/functions/v1/facebook-oauth?code=code-1&state=${encodeURIComponent(state)}`,
      { method: "GET" },
    ));
    const location = response.headers.get("location") ?? "";
    assertEquals(location.includes("code_exchange_failed"), true);
    assertEquals(location.includes(PROVIDER_TOKEN), false);
    assertEquals(location.includes(`select=${PENDING_ID}`), false);
  });
  assertEquals(logs.includes(PROVIDER_TOKEN), false);
  assertEquals(rpcNames(current).includes("complete_meta_oauth_callback"), false);
});

routeTest("a failed long-lived exchange keeps the short token lifetime", async () => {
  const current = probe({ setting: "protected" });
  current.providerFetch = (url) => {
    if (url.includes("grant_type=fb_exchange_token")) {
      return { status: 500, body: { error: { message: RAW_DRIVER_TEXT }, access_token: "ignored" } };
    }
    if (url.includes("/oauth/access_token")) {
      return { status: 200, body: { access_token: "short-lived-token", expires_in: 3600 } };
    }
    if (url.includes("/me?fields=id")) return { status: 200, body: { id: "fb-user-1" } };
    if (url.includes("/me/accounts")) {
      return {
        status: 200,
        body: { data: [{ id: "page-1", name: "Shop", access_token: PAGE_TOKEN }] },
      };
    }
    return { status: 200, body: { data: [] } };
  };
  const handler = await loadHandler("facebook-oauth/index.ts", current);
  const state = await protectedState({ platform: "facebook", flow: "pages", sqlFlow: "facebook_page" });
  const logs = await withCapturedLogs(async () => {
    await handler(new Request(
      `https://synthetic.invalid/functions/v1/facebook-oauth?code=code-1&state=${encodeURIComponent(state)}`,
      { method: "GET" },
    ));
  });
  const complete = current.rpcCalls.find((call) => call.name === "complete_meta_oauth_callback");
  const stash = (complete!.args.p_payload as Record<string, unknown>).stash as Record<string, unknown>;
  assertEquals(stash.user_token, "short-lived-token");
  assertEquals(stash.user_token_expires_in, 3600);
  assertEquals(logs.includes(RAW_DRIVER_TEXT), false);
  assertEquals(logs.includes("short-lived-token"), false);
});

routeTest("a long-lived response without a lifetime omits the expiry", async () => {
  const current = probe({ setting: "protected" });
  current.providerFetch = (url) => {
    if (url.includes("grant_type=fb_exchange_token")) {
      return { status: 200, body: { access_token: "long-lived-token" } };
    }
    if (url.includes("/oauth/access_token")) {
      return { status: 200, body: { access_token: "short-lived-token", expires_in: 3600 } };
    }
    if (url.includes("/me?fields=id")) return { status: 200, body: { id: "fb-user-1" } };
    if (url.includes("/me/accounts")) {
      return {
        status: 200,
        body: { data: [{ id: "page-1", name: "Shop", access_token: PAGE_TOKEN }] },
      };
    }
    return { status: 200, body: { data: [] } };
  };
  const handler = await loadHandler("facebook-oauth/index.ts", current);
  const state = await protectedState({ platform: "facebook", flow: "pages", sqlFlow: "facebook_page" });
  await handler(new Request(
    `https://synthetic.invalid/functions/v1/facebook-oauth?code=code-1&state=${encodeURIComponent(state)}`,
    { method: "GET" },
  ));
  const complete = current.rpcCalls.find((call) => call.name === "complete_meta_oauth_callback");
  const stash = (complete!.args.p_payload as Record<string, unknown>).stash as Record<string, unknown>;
  assertEquals(stash.user_token, "long-lived-token");
  assertEquals(Object.prototype.hasOwnProperty.call(stash, "user_token_expires_in"), false);
  assertEquals(stash.user_token_expires_in, undefined);
});

routeTest("a consumed page-linked stash replays from the attempt and key", async () => {
  for (const selectionId of [undefined, PENDING_ID]) {
    const current = probe({
      setting: "protected",
      attemptRows: [{
        id: ATTEMPT_ID,
        user_id: USER_ID,
        flow: "instagram_page_linked",
      }],
    });
    const handler = await loadHandler("instagram-business-oauth/index.ts", current);
    const result = await callJson(
      handler,
      "https://synthetic.invalid/functions/v1/instagram-business-oauth",
      {
        action: "store_ig_account",
        attempt_id: ATTEMPT_ID,
        selection_key: "instagram_page_linked:ig:ig-1",
        ...(selectionId ? { selection_id: selectionId } : {}),
      },
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.success, true);
    assertEquals(result.body.replayed, undefined);
    assertEquals(result.body.subscription.status, "skipped");
    assertEquals(result.body.subscription.policy, "reassert_after_valid_receipt");
    assertEquals(rpcNames(current).filter((name) => name === "commit_meta_oauth_selection").length, 1);
    assertEquals(providerUrls(current), []);
  }
});

routeTest("an unknown protected attempt is refused before commit", async () => {
  const current = probe({
    setting: "protected",
    attemptRows: [{
      id: ATTEMPT_ID,
      user_id: OTHER_USER_ID,
      flow: "instagram_page_linked",
    }],
  });
  const handler = await loadHandler("instagram-business-oauth/index.ts", current);
  const result = await callJson(
    handler,
    "https://synthetic.invalid/functions/v1/instagram-business-oauth",
    {
      action: "store_ig_account",
      attempt_id: ATTEMPT_ID,
      selection_key: "instagram_page_linked:ig:ig-1",
    },
  );
  assertEquals(result.status, 404);
  assertEquals(result.body.error_code, "PROTECTED_OAUTH_REFERENCE_MISSING");
  assertEquals(rpcNames(current).includes("commit_meta_oauth_selection"), false);
  assertEquals(providerUrls(current), []);
});

routeTest("a conflicting attempt reference is refused before the provider", async () => {
  const current = probe({
    setting: "protected",
    instagramRows: [protectedPendingRow()],
  });
  const handler = await loadHandler("instagram-business-oauth/index.ts", current);
  const result = await callJson(
    handler,
    "https://synthetic.invalid/functions/v1/instagram-business-oauth",
    {
      action: "store_ig_account",
      selection_id: PENDING_ID,
      attempt_id: OTHER_USER_ID,
      selection_key: "instagram_page_linked:ig:ig-1",
    },
  );
  assertEquals(result.status, 409);
  assertEquals(result.body.error_code, "PROTECTED_OAUTH_CONFLICT");
  assertEquals(providerUrls(current), []);
  assertEquals(rpcNames(current), []);
});

routeTest("legacy page selection requires page_id and then continues", async () => {
  const blocked = probe({ setting: "legacy" });
  const blockedHandler = await loadHandler("facebook-oauth/index.ts", blocked);
  const missing = await callJson(
    blockedHandler,
    "https://synthetic.invalid/functions/v1/facebook-oauth",
    { action: "store_page", selection_id: PENDING_ID },
  );
  assertEquals(missing.status, 400);
  assertEquals(missing.body.error, "Invalid request body");
  assertEquals(providerUrls(blocked), []);

  const current = probe({
    setting: "legacy",
    facebookRows: [{
      id: PENDING_ID,
      user_id: USER_ID,
      meta_oauth_attempt_id: null,
      expires_at: new Date(Date.now() + 60000).toISOString(),
      provider_token: PROVIDER_TOKEN,
      social_profile_id: null,
      target_platform: "facebook",
      pages_json: [],
      ig_standalone_json: [],
    }],
  });
  metaProvider(current);
  const handler = await loadHandler("facebook-oauth/index.ts", current);
  const result = await callJson(
    handler,
    "https://synthetic.invalid/functions/v1/facebook-oauth",
    {
      action: "store_page",
      page_id: "page-1",
      selection_id: PENDING_ID,
    },
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.success, true);
  assertEquals(result.body.error, undefined);
  assertEquals(providerUrls(current).some((url) => url.includes("/me/accounts")), true);
});

function protectedPageProbe(overrides: Partial<Probe> = {}): Probe {
  return probe({
    setting: "protected",
    attemptRows: [{ id: ATTEMPT_ID, user_id: USER_ID, flow: "facebook_page" }],
    ...overrides,
  });
}

routeTest("a receipt without a usable account id fails before the token read", async () => {
  for (const dropAccount of [false, true]) {
    const full = receiptResult();
    const { social_account_id: _omitted, ...withoutAccount } = full;
    const receipt = dropAccount ? withoutAccount : { ...full, social_account_id: null };
    const current = protectedPageProbe({
      rpcOverrides: { commit_meta_oauth_selection: receipt },
      socialRows: [{
        id: ACCOUNT_ID,
        user_id: USER_ID,
        platform: "facebook",
        platform_user_id: "page-1",
        access_token: PAGE_TOKEN,
      }],
    });
    const handler = await loadHandler("facebook-oauth/index.ts", current);
    const result = await callJson(handler, "https://synthetic.invalid/functions/v1/facebook-oauth", {
      action: "store_page",
      attempt_id: ATTEMPT_ID,
      selection_key: "facebook_page:page:page-1",
    });
    assertEquals(result.status, 503);
    assertEquals(result.body.success, undefined);
    assertEquals(result.body.error_code, "PROTECTED_OAUTH_READ_FAILED");
    assertEquals(result.body.subscription, undefined);
    assertEquals(providerUrls(current), []);
    assertEquals(current.tableReads.includes("social_accounts"), false);
    assertEquals(current.mutations, []);
    assertEquals(rpcNames(current).includes("commit_meta_oauth_selection"), true);
    assertEquals(JSON.stringify(result.body).includes(PAGE_TOKEN), false);
  }
});

routeTest("a receipt whose platform disagrees with its flow fails before success", async () => {
  const current = protectedPageProbe({
    rpcOverrides: { commit_meta_oauth_selection: receiptResult({ platform: "instagram" }) },
    socialRows: [{
      id: ACCOUNT_ID,
      user_id: USER_ID,
      platform: "facebook",
      platform_user_id: "page-1",
      access_token: PAGE_TOKEN,
    }],
  });
  const handler = await loadHandler("facebook-oauth/index.ts", current);
  const result = await callJson(handler, "https://synthetic.invalid/functions/v1/facebook-oauth", {
    action: "store_page",
    attempt_id: ATTEMPT_ID,
    selection_key: "facebook_page:page:page-1",
  });
  assertEquals(result.status, 503);
  assertEquals(result.body.success, undefined);
  assertEquals(result.body.error_code, "PROTECTED_OAUTH_READ_FAILED");
  assertEquals(providerUrls(current), []);
  assertEquals(current.tableReads.includes("social_accounts"), false);
  assertEquals(current.mutations, []);
  assertEquals(JSON.stringify(result.body).includes("instagram"), false);
});

routeTest("each protected flow accepts its canonical receipt", async () => {
  const page = protectedPageProbe({
    socialRows: [{
      id: ACCOUNT_ID,
      user_id: USER_ID,
      platform: "facebook",
      platform_user_id: "page-1",
      access_token: PAGE_TOKEN,
    }],
  });
  page.providerFetch = (url) => url.includes("subscribed_apps")
    ? { status: 200, body: { success: true } }
    : { status: 200, body: { data: [] } };
  const pageHandler = await loadHandler("facebook-oauth/index.ts", page);
  const pageResult = await callJson(pageHandler, "https://synthetic.invalid/functions/v1/facebook-oauth", {
    action: "store_page",
    attempt_id: ATTEMPT_ID,
    selection_key: "facebook_page:page:page-1",
  });
  assertEquals(pageResult.status, 200);
  assertEquals(pageResult.body.success, true);
  assertEquals(pageResult.body.subscription.status, "asserted");
  assertEquals(pageResult.body.subscription.policy, "reassert_after_valid_receipt");

  const linked = probe({
    setting: "protected",
    attemptRows: [{ id: ATTEMPT_ID, user_id: USER_ID, flow: "instagram_page_linked" }],
  });
  const linkedHandler = await loadHandler("instagram-business-oauth/index.ts", linked);
  const linkedResult = await callJson(linkedHandler, "https://synthetic.invalid/functions/v1/instagram-business-oauth", {
    action: "store_ig_account",
    attempt_id: ATTEMPT_ID,
    selection_key: "instagram_page_linked:ig:ig-1",
  });
  assertEquals(linkedResult.status, 200);
  assertEquals(linkedResult.body.success, true);
  assertEquals(linkedResult.body.subscription.status, "skipped");
  assertEquals(linkedResult.body.subscription.policy, "reassert_after_valid_receipt");
  assertEquals(providerUrls(linked), []);

  const direct = probe({
    setting: "protected",
    instagramRows: [protectedPendingRow({
      ig_candidates_json: [{ ig_user_id: "ig-canonical", ig_igid: "ig-messaging" }],
    })],
    attemptRows: [{ id: ATTEMPT_ID, user_id: USER_ID, flow: "instagram_direct" }],
    socialRows: [{
      id: ACCOUNT_ID,
      user_id: USER_ID,
      platform: "instagram",
      platform_user_id: "ig-canonical",
      access_token: PAGE_TOKEN,
    }],
  });
  metaProvider(direct);
  const directHandler = await loadHandler("instagram-oauth/index.ts", direct);
  const state = await protectedState({ platform: "instagram", flow: "direct", sqlFlow: "instagram_direct" });
  const directResponse = await directHandler(new Request(
    `https://synthetic.invalid/functions/v1/instagram-oauth?code=code-1&state=${encodeURIComponent(state)}`,
    { method: "GET" },
  ));
  const directLocation = directResponse.headers.get("location") ?? "";
  assertEquals(directResponse.status, 302);
  assertEquals(directLocation.includes("connected=instagram"), true);
  assertEquals(directLocation.includes("warning="), false);
  assertEquals(directLocation.includes(PAGE_TOKEN), false);
});

routeTest("an explicit unsuccessful subscription stays connected with a warning", async () => {
  const page = protectedPageProbe({
    socialRows: [{
      id: ACCOUNT_ID,
      user_id: USER_ID,
      platform: "facebook",
      platform_user_id: "page-1",
      access_token: PAGE_TOKEN,
    }],
  });
  page.providerFetch = (url) => url.includes("subscribed_apps")
    ? { status: 200, body: { success: false, error: { message: RAW_DRIVER_TEXT } } }
    : { status: 200, body: { data: [] } };
  const pageHandler = await loadHandler("facebook-oauth/index.ts", page);
  const pageResult = await callJson(pageHandler, "https://synthetic.invalid/functions/v1/facebook-oauth", {
    action: "store_page",
    attempt_id: ATTEMPT_ID,
    selection_key: "facebook_page:page:page-1",
  });
  assertEquals(pageResult.status, 200);
  assertEquals(pageResult.body.success, true);
  assertEquals(pageResult.body.subscription.status, "failed");
  assertEquals(pageResult.body.subscription.policy, "reassert_after_valid_receipt");
  assertEquals(typeof pageResult.body.subscription.warning, "string");
  assertEquals(JSON.stringify(pageResult.body).includes(RAW_DRIVER_TEXT), false);
  assertEquals(JSON.stringify(pageResult.body).includes(PAGE_TOKEN), false);
  assertEquals(page.mutations, []);

  const direct = probe({
    setting: "protected",
    instagramRows: [protectedPendingRow({
      ig_candidates_json: [{ ig_user_id: "ig-canonical", ig_igid: "ig-messaging" }],
    })],
    attemptRows: [{ id: ATTEMPT_ID, user_id: USER_ID, flow: "instagram_direct" }],
    socialRows: [{
      id: ACCOUNT_ID,
      user_id: USER_ID,
      platform: "instagram",
      platform_user_id: "ig-canonical",
      access_token: PAGE_TOKEN,
    }],
  });
  metaProvider(direct);
  const original = direct.providerFetch;
  direct.providerFetch = (url) => url.includes("subscribed_apps")
    ? { status: 200, body: { success: false } }
    : original(url);
  const directHandler = await loadHandler("instagram-oauth/index.ts", direct);
  const state = await protectedState({ platform: "instagram", flow: "direct", sqlFlow: "instagram_direct" });
  const response = await directHandler(new Request(
    `https://synthetic.invalid/functions/v1/instagram-oauth?code=code-1&state=${encodeURIComponent(state)}`,
    { method: "GET" },
  ));
  const location = response.headers.get("location") ?? "";
  assertEquals(response.status, 302);
  assertEquals(location.includes("connected=instagram"), true);
  assertEquals(location.includes("warning=subscription_unconfirmed"), true);
  assertEquals(location.includes(PAGE_TOKEN), false);
  assertEquals(location.includes("success"), false);
  assertEquals(direct.mutations, []);
});

routeTest("a direct identity with a control character never completes or commits", async () => {
  for (const profile of [
    { id: "provider\u0000id", user_id: "ig-messaging" },
    { id: "provider-id-123", user_id: "provider\rid" },
  ]) {
    const current = probe({ setting: "protected" });
    current.providerFetch = (url) => {
      if (url.includes("api.instagram.com/oauth/access_token")) {
        return { status: 200, body: { access_token: PROVIDER_TOKEN, expires_in: 60 } };
      }
      if (url.includes("ig_exchange_token")) {
        return { status: 200, body: { access_token: PROVIDER_TOKEN } };
      }
      if (url.includes("/me?")) {
        return { status: 200, body: { ...profile, username: "shop", account_type: "BUSINESS" } };
      }
      return { status: 200, body: { data: [] } };
    };
    const handler = await loadHandler("instagram-oauth/index.ts", current);
    const state = await protectedState({ platform: "instagram", flow: "direct", sqlFlow: "instagram_direct" });
    const logs = await withCapturedLogs(async () => {
      const response = await handler(new Request(
        `https://synthetic.invalid/functions/v1/instagram-oauth?code=code-1&state=${encodeURIComponent(state)}`,
        { method: "GET" },
      ));
      const location = response.headers.get("location") ?? "";
      assertEquals(location.includes("PROTECTED_OAUTH_IDENTITY_UNVERIFIED"), true);
      assertEquals(location.includes("connected=instagram"), false);
      assertEquals(location.includes(PROVIDER_TOKEN), false);
      assertEquals(location.includes("provider"), false);
    });
    assertEquals(rpcNames(current).includes("complete_meta_oauth_callback"), false);
    assertEquals(rpcNames(current).includes("commit_meta_oauth_selection"), false);
    assertEquals(logs.includes(PROVIDER_TOKEN), false);
    assertEquals(logs.includes("\\u0000"), false);
  }
});
