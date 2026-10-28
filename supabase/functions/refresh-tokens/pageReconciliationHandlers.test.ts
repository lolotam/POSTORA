/**
 * The actual registered refresh-tokens route, for the Page reconciliation.
 *
 * WHAT THIS SUITE IS
 *
 *   It loads the real `supabase/functions/refresh-tokens/index.ts`, lets it
 *   register its handler through `Deno.serve`, and drives real requests
 *   through it. It is NOT a copy of the dispatch: a broken copy of the route
 *   fails this suite.
 *
 *   Only the infrastructure ports are stubbed. The authorization, the settings
 *   resolution, the credential gate, the classification, the adapters, the
 *   orchestration and the response mapping are the production code.
 *
 * THE RELOCATION AND THE MUTATION
 *
 *   Three proofs are run against COPIES of the source tree. The repository
 *   source is never modified:
 *
 *     - the relocated positive: the same route, copied to another directory,
 *       still reconciles the Page token;
 *     - the broken routing copy: a copy whose route no longer wires the
 *       protected-Meta gate stops reconciling;
 *     - the broken provenance copy: a copy that stops using the CAPTURED User
 *       grant stops sending it to the provider;
 *     - the broken receipt copy: a copy that stops checking the receipt
 *       starts reporting a malformed receipt as a success.
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

const BUNDLE_DIR = Deno.makeTempDirSync({ prefix: "postora-page-reconcile-handler-" });
const COPY_DIR = Deno.makeTempDirSync({ prefix: "postora-page-reconcile-copy-" });

const CRON_SECRET = "synthetic-cron-secret-for-the-page-suite";
const SERVICE_ROLE_KEY = "synthetic-service-role-key";
const OWNER_ID = "0f100001-0000-4000-8000-000000000001";
const INSTAGRAM_ACCOUNT_ID = "0f1a0002-0000-4000-8000-000000000012";
const FACEBOOK_ACCOUNT_ID = "0f1a0004-0000-4000-8000-000000000014";
const CAPTURED_USER_TOKEN = "captured-user-secret-must-not-leak";
const DERIVED_PAGE_TOKEN = "derived-page-token-must-not-leak";
const LEGACY_TOKEN = "legacy-token-must-not-leak";
const PROVIDER_USER_ID = "fb-user-9001";
const PAGE_ID = "page-7001";
const INSTAGRAM_ID = "ig-page-7001";
const CREDENTIAL_ID = "9a2c0001-0000-4000-8000-000000000021";
const BINDING_CONNECTION_VERSION = 4;
const CAPTURE_ID = "726f97c3-305f-4674-a89d-79c4463b506a";

const ENV: Record<string, string> = {
  CRON_SECRET,
  SUPABASE_URL: "https://api.postora.invalid",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
};

interface AccountRow {
  id: string;
  user_id: string;
  platform: string;
  platform_user_id: string;
  platform_username: string;
  access_token: string;
  refresh_token: string | null;
  token_expires_at: string | null;
  is_active: boolean;
  needs_reauth: boolean;
  failure_count: number;
  last_refresh_error: string | null;
  last_alert_sent_at: string | null;
  alerts_snoozed: boolean;
  last_refresh_attempt_at: string | null;
  ig_auth_type: string | null;
  loginKind: "direct" | "page_linked";
  account_metadata: Record<string, unknown>;
  auth_provider: string | null;
  workspace_id: string | null;
}

interface Probe {
  setting: "protected" | "legacy" | "absent" | "throw" | "driver-error" | "malformed";
  accounts: AccountRow[];
  bindings: Array<Record<string, unknown>>;
  capabilityMode: "ok" | "throw" | "malformed" | "missing";
  capabilityGeneration: number;
  beginMode: "ok" | "throw" | "malformed";
  writeMode: "ok" | "throw" | "malformed" | "wrong-generation" | "stale-expiry";
  failureMode: "ok" | "throw" | "malformed";
  providerMode: "ok" | "revoked" | "permission" | "unclassified" | "missing-page";
  alertMode: "confirmed" | "unconfirmed" | "error";
  roleMode: "admin" | "none" | "error";
  handler: ((req: Request) => Response | Promise<Response>) | null;
  http: Array<{ url: string; body: string | undefined }>;
  rpc: string[];
  rpcArgs: Array<{ name: string; args: Record<string, unknown> }>;
  history: Array<Record<string, unknown>>;
  logs: string[];
  legacyCalls: string[];
  pageCaptureAccountId: string | null;
}

function account(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: INSTAGRAM_ACCOUNT_ID,
    user_id: OWNER_ID,
    platform: "instagram",
    platform_user_id: INSTAGRAM_ID,
    platform_username: "ig_page_1",
    access_token: LEGACY_TOKEN,
    refresh_token: null,
    token_expires_at: "2026-10-01T00:00:00.000Z",
    is_active: true,
    needs_reauth: false,
    failure_count: 0,
    last_refresh_error: null,
    last_alert_sent_at: null,
    alerts_snoozed: false,
    last_refresh_attempt_at: null,
    ig_auth_type: "business_login",
    loginKind: "page_linked",
    account_metadata: { access_token: LEGACY_TOKEN },
    auth_provider: null,
    workspace_id: null,
    ...overrides,
  };
}

function binding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    social_account_id: INSTAGRAM_ACCOUNT_ID,
    user_id: OWNER_ID,
    platform: "instagram",
    credential_id: CREDENTIAL_ID,
    connection_version: BINDING_CONNECTION_VERSION,
    verified_facebook_user_id: PROVIDER_USER_ID,
    verified_facebook_page_id: PAGE_ID,
    verified_instagram_user_id: INSTAGRAM_ID,
    ...overrides,
  };
}

function probe(overrides: Partial<Probe> = {}): Probe {
  return {
    setting: "protected",
    accounts: [account()],
    bindings: [binding()],
    capabilityMode: "ok",
    capabilityGeneration: 11,
    beginMode: "ok",
    writeMode: "ok",
    failureMode: "ok",
    providerMode: "ok",
    alertMode: "confirmed",
    roleMode: "admin",
    handler: null,
    http: [],
    rpc: [],
    rpcArgs: [],
    history: [],
    logs: [],
    legacyCalls: [],
    pageCaptureAccountId: null,
    ...overrides,
  };
}

function capabilityRow(current: Probe): Record<string, unknown> {
  if (current.capabilityMode === "malformed") return { found: true, login_kind: "page_linked" };
  if (current.capabilityMode === "missing") return { found: false };
  return {
    platform: "instagram",
    login_kind: "page_linked",
    updated_at: new Date().toISOString(),
    granted_scopes: [],
    reconnected_at: null,
    scopes_read_at: null,
    generation_reason: "credential_refreshed",
    social_account_id: INSTAGRAM_ACCOUNT_ID,
    capability_present: true,
    last_read_failed_at: null,
    last_read_error_code: null,
    scopes_authoritative: false,
    credential_generation: current.capabilityGeneration,
    credential_updated_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    permission_read_state: "unknown",
    has_protected_credential: true,
  };
}

function pageBeginWire(current: Probe, row: AccountRow): Record<string, unknown> {
  const capturedAt = new Date();
  const expiresAt = new Date(capturedAt.getTime() + 30 * 60 * 1000);
  const capturedIso = capturedAt.toISOString();
  const expiresIso = expiresAt.toISOString();
  const generation = current.capabilityGeneration;
  const isFacebook = row.platform === "facebook";
  return {
    capture_id: CAPTURE_ID,
    capture_version: 1,
    captured_at: capturedIso,
    expires_at: expiresIso,
    operation: "facebook_user_token",
    attempt_marker: capturedIso,
    capture: {
      capture_version: 1,
      captured_at: capturedIso,
      expires_at: expiresIso,
      user_id: row.user_id,
      operation: "facebook_user_token",
      credential: {
        credential_id: CREDENTIAL_ID,
        revision: 7,
        provider_user_id: PROVIDER_USER_ID,
        token_expires_at: "2026-12-01T00:00:00+00:00",
      },
      members: [
        {
          social_account_id: row.id,
          platform: row.platform,
          connection_version: BINDING_CONNECTION_VERSION,
          capability_generation: isFacebook ? null : generation,
          fence_connection_version: BINDING_CONNECTION_VERSION,
        },
      ],
      targets: [
        {
          social_account_id: row.id,
          platform: row.platform,
          platform_user_id: row.platform_user_id,
          binding_present: true,
          binding_credential_id: CREDENTIAL_ID,
          binding_connection_version: BINDING_CONNECTION_VERSION,
          fence_state: "present",
          fence_connection_version: BINDING_CONNECTION_VERSION,
          credential_revision: 7,
          provider_user_id: PROVIDER_USER_ID,
          capability_present: !isFacebook,
          capability_generation: isFacebook ? null : generation,
          capability_login_kind: isFacebook ? null : "page_linked",
          capability_permission_read_state: "unknown",
          token_expires_at: "2026-10-01T00:00:00+00:00",
          refresh_token_present: true,
          failure_count: 0,
          needs_reauth: row.needs_reauth,
          last_refresh_attempt_at: capturedIso,
        },
      ],
    },
    tokens: [
      {
        scope: "credential",
        social_account_id: null,
        credential_id: CREDENTIAL_ID,
        credential_revision: 7,
        token: CAPTURED_USER_TOKEN,
        token_expires_at: "2026-12-01T00:00:00+00:00",
        refresh_token: null,
      },
    ],
  };
}

function pageWriteReceipt(current: Probe, args: Record<string, unknown>) {
  const payload = args.p_payload as { capture_id: string };
  const row = current.accounts.find((candidate) => candidate.id === current.pageCaptureAccountId) ??
    current.accounts[0];
  const isFacebook = row.platform === "facebook";
  const generation = isFacebook ? null : current.capabilityGeneration + 1;
  const state: Record<string, unknown> = {
    found: true,
    social_account_id: row.id,
    platform: row.platform,
    platform_user_id: row.platform_user_id,
    login_kind: isFacebook ? null : "page_linked",
    credential_generation: generation,
    binding_credential_id: CREDENTIAL_ID,
    binding_connection_version: isFacebook
      ? BINDING_CONNECTION_VERSION + 1
      : BINDING_CONNECTION_VERSION,
    credential_revision: 7,
    token_expires_at: null,
    refresh_token_present: true,
    failure_count: 0,
    needs_reauth: row.needs_reauth,
    is_active: true,
  };
  if (current.writeMode === "wrong-generation") state.credential_generation = 99;
  if (current.writeMode === "stale-expiry") {
    state.token_expires_at = "2027-01-01T00:00:00+00:00";
  }
  return {
    data: {
      capture_id: String(payload.capture_id),
      operation: "page_reconciliation",
      applied: true,
      credential_id: CREDENTIAL_ID,
      credential_revision: 7,
      credential_generation: generation,
      expiry_state: "unknown",
      account: state,
    },
    error: null,
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
    orderColumn: string | null = null;
    orderAscending = true;
    nullsFirst = false;

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
    order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }) {
      this.orderColumn = column;
      this.orderAscending = options?.ascending ?? true;
      this.nullsFirst = options?.nullsFirst ?? false;
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
      return Promise.resolve()
        .then(() => this.execute())
        .then(ok, bad);
    }
    execute(): { data: unknown; error: unknown } {
      if (this.op === "insert") {
        const payload = this.filters.payload;
        if (this.table === "token_refresh_history") {
          const rows = Array.isArray(payload) ? payload : [payload];
          for (const row of rows) current.history.push(row as Record<string, unknown>);
        }
        return { data: null, error: null };
      }
      if (this.op === "update" || this.op === "upsert" || this.op === "delete") {
        return { data: [{ id: String(this.filters.id ?? "") }], error: null };
      }

      if (this.table === "app_settings") {
        if (current.setting === "throw") throw new Error("settings read failed");
        if (current.setting === "driver-error") {
          return { data: null, error: { message: "settings outage" } };
        }
        if (current.setting === "malformed") return { data: { unexpected: true }, error: null };
        const key = String(this.filters.key ?? "");
        // Only the credential mode is stored. The collection switch stays
        // absent, which means "off".
        if (current.setting === "absent" || key !== "credential_facebook_user_mode") {
          return { data: null, error: null };
        }
        return { data: { value: current.setting }, error: null };
      }

      if (this.table === "user_roles") {
        if (current.roleMode === "error") {
          return { data: null, error: { message: "role read failed" } };
        }
        return {
          data: current.roleMode === "admin" ? { role: "admin" } : null,
          error: null,
        };
      }

      if (this.table === "profiles") {
        return {
          data: { id: String(this.filters.id ?? ""), email: "owner@example.invalid" },
          error: null,
        };
      }

      if (this.table === "facebook_user_credential_bindings") {
        const rows = current.bindings.filter((row) => {
          if (
            this.filters.social_account_id !== undefined &&
            row.social_account_id !== this.filters.social_account_id
          ) return false;
          if (this.filters.user_id !== undefined && row.user_id !== this.filters.user_id) {
            return false;
          }
          if (
            this.filters.credential_id !== undefined &&
            row.credential_id !== this.filters.credential_id
          ) return false;
          if (
            this.filters.connection_version !== undefined &&
            row.connection_version !== this.filters.connection_version
          ) return false;
          return true;
        });
        return { data: this.one ? (rows[0] ?? null) : rows, error: null };
      }

      let rows = current.accounts.filter((row) => {
        if (this.filters.id !== undefined && row.id !== this.filters.id) return false;
        if (this.filters.user_id !== undefined && row.user_id !== this.filters.user_id) {
          return false;
        }
        if (this.filters.platform !== undefined && row.platform !== this.filters.platform) {
          return false;
        }
        if (this.filters.is_active !== undefined && row.is_active !== this.filters.is_active) {
          return false;
        }
        if (this.filters.key !== undefined) return false;
        if (this.filters.role !== undefined) return false;
        if (this.inFilter) {
          const value = this.inFilter.column === "id" ? row.id : row.platform;
          if (!this.inFilter.values.includes(value)) return false;
        }
        for (const group of this.orFilters) {
          if (!matchesOr(group, row)) return false;
        }
        return true;
      });

      if (this.orderColumn === "last_refresh_attempt_at") {
        rows = [...rows].sort((left, right) => {
          const a = left.last_refresh_attempt_at;
          const b = right.last_refresh_attempt_at;
          if (a === b) return 0;
          if (a === null) return this.nullsFirst ? -1 : 1;
          if (b === null) return this.nullsFirst ? 1 : -1;
          return this.orderAscending ? (a < b ? -1 : 1) : (a < b ? 1 : -1);
        });
      }

      return { data: this.one ? (rows[0] ?? null) : rows, error: null };
    }
  }

  return {
    from: (table: string) => new Query(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      current.rpc.push(name);
      current.rpcArgs.push({ name, args });
      return rpcResult(current, name, args);
    },
    auth: {
      getUser: async () => ({ data: { user: { id: OWNER_ID } }, error: null }),
      getClaims: async () => ({ data: { claims: { sub: OWNER_ID } }, error: null }),
    },
  };
}

function matchesOr(group: string, row: AccountRow): boolean {
  const parts = group.split(",").map((part) => part.trim());
  return parts.some((part) => {
    if (part === "needs_reauth.is.null") return row.needs_reauth === null;
    if (part === "needs_reauth.eq.false") return row.needs_reauth === false;
    if (part === "token_expires_at.not.is.null") return row.token_expires_at !== null;
    if (part === "auth_provider.eq.composio") return row.auth_provider === "composio";
    return true;
  });
}

function rpcResult(current: Probe, name: string, args: Record<string, unknown>) {
  if (name === "read_instagram_account_capability") {
    if (current.capabilityMode === "throw") {
      return { data: null, error: { message: "capability outage" } };
    }
    if (current.capabilityMode === "missing") {
      return { data: null, error: { message: "not owned", code: "P0001" } };
    }
    return { data: capabilityRow(current), error: null };
  }

  if (name === "begin_meta_account_refresh") {
    if (current.beginMode === "throw") {
      return { data: null, error: { message: "begin refused", code: "MAR03" } };
    }
    if (current.beginMode === "malformed") return { data: { capture_version: 2 }, error: null };
    const accounts = (args.p_payload as { accounts: Array<{ social_account_id: string; operation: string }> })
      .accounts;
    const accountId = String(accounts[0].social_account_id);
    const operation = String(accounts[0].operation);
    const row = current.accounts.find((candidate) => candidate.id === accountId) ??
      current.accounts[0];
    if (operation === "facebook_user_token") {
      current.pageCaptureAccountId = row.id;
      return { data: pageBeginWire(current, row), error: null };
    }
    return { data: null, error: { message: "unsupported operation", code: "MAR01" } };
  }

  if (name === "write_meta_page_reconciliation_success") {
    if (current.writeMode === "throw") {
      return { data: null, error: { message: "write refused", code: "MAR04" } };
    }
    if (current.writeMode === "malformed") return { data: { applied: false }, error: null };
    return pageWriteReceipt(current, args);
  }

  if (name === "record_meta_refresh_failure") {
    if (current.failureMode === "throw") {
      return { data: null, error: { message: "failure refused", code: "MAR04" } };
    }
    if (current.failureMode === "malformed") return { data: { applied: true }, error: null };
    const row = current.accounts.find((candidate) => candidate.id === current.pageCaptureAccountId) ??
      current.accounts[0];
    const category = String((args.p_payload as { error_category: string }).error_category);
    const permanent = category === "provider_invalid_grant";
    return {
      data: {
        capture_id: String((args.p_payload as { capture_id: string }).capture_id),
        applied: true,
        error_category: category,
        failure_count: permanent ? 1 : 0,
        escalated: permanent,
        alert_marker_written: permanent,
        transitioned: permanent,
        enqueued: permanent ? 1 : 0,
        account_found: true,
        account: {
          found: true,
          social_account_id: row.id,
          platform: row.platform,
          platform_user_id: row.platform_user_id,
          login_kind: row.platform === "instagram" ? "page_linked" : null,
          credential_generation: row.platform === "instagram"
            ? current.capabilityGeneration + 1
            : null,
          binding_credential_id: CREDENTIAL_ID,
          binding_connection_version: row.platform === "instagram"
            ? BINDING_CONNECTION_VERSION
            : BINDING_CONNECTION_VERSION + 1,
          credential_revision: 7,
          token_expires_at: "2026-10-01T00:00:00+00:00",
          refresh_token_present: true,
          failure_count: permanent ? 1 : 0,
          needs_reauth: permanent,
          is_active: true,
        },
      },
      error: null,
    };
  }

  return { data: null, error: null };
}

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
const originalServe = Deno.serve;
const originalError = console.error;
const originalLog = console.log;
const originalWarn = console.warn;

function restoreProcess(savedEnv: Map<string, string | undefined>) {
  globalThis.fetch = originalFetch;
  Deno.serve = originalServe;
  console.error = originalError;
  console.log = originalLog;
  console.warn = originalWarn;
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
  Deno.serve = originalServe;
  try {
    Deno.removeSync(BUNDLE_DIR, { recursive: true });
    Deno.removeSync(COPY_DIR, { recursive: true });
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
  const avatarNames = [
    "cacheAvatarToCdn",
    "fetchFacebookAvatarUrl",
    "fetchInstagramAvatarUrl",
    "fetchTikTokAvatarUrl",
    "fetchTwitterAvatarUrl",
    "fetchLinkedInAvatarUrl",
    "fetchPinterestAvatarUrl",
    "fetchYouTubeAvatarUrl",
    "fetchThreadsAvatarUrl",
    "fetchBlueskyAvatarUrl",
    "fetchRedditAvatarUrl",
  ];
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
  return `
    const P = () => globalThis.__postoraProbe;
    export const createClient = () => globalThis.__postoraRouteClient;
    export const composioClientFromEnv = () => null;
    ${avatarNames.map((entry) => `export async function ${entry}() { return null; }`).join("\n")}
    ${refreshNames.map((entry) => `export async function ${entry}() {
      P().legacyCalls.push(${JSON.stringify(entry)});
      return { ok: true, access_token: "legacy", expires_in: 3600 };
    }`).join("\n")}
  `;
}

const bundles = new Map<string, string>();
let importSeq = 0;

async function bundle(entry: string, functionsRoot: string): Promise<string> {
  const key = `${functionsRoot}::${entry}`;
  const cached = bundles.get(key);
  if (cached) return cached;
  await Deno.mkdir(BUNDLE_DIR, { recursive: true });
  const outfile = `${BUNDLE_DIR}/${key.replaceAll(/[\\/:]/g, "-")}.mjs`;
  await build({
    entryPoints: [join(functionsRoot, entry)],
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
            "avatar-cache.ts",
            "composioClient.ts",
            "social-auth.ts",
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
  bundles.set(key, outfile);
  return outfile;
}

function providerResponse(current: Probe, url: string): Response {
  if (url.includes("send-token-failure-alert")) {
    if (current.alertMode === "error") return new Response("failed", { status: 500 });
    if (current.alertMode === "unconfirmed") {
      return new Response(JSON.stringify({ message: "No admins to notify" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ success: true, userEmailsSent: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  if (url.includes("graph.facebook.com")) {
    if (current.providerMode === "revoked") {
      return new Response(
        JSON.stringify({ error: { type: "OAuthException", code: 190, message: "revoked" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    if (current.providerMode === "permission") {
      return new Response(
        JSON.stringify({ error: { type: "OAuthException", code: 200, message: "denied" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    if (current.providerMode === "unclassified") {
      return new Response(JSON.stringify({ unexpected: true }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/me/accounts")) {
      const entries = current.providerMode === "missing-page"
        ? [{ id: "page-other", access_token: "other-token" }]
        : [{ id: PAGE_ID, access_token: DERIVED_PAGE_TOKEN }];
      return new Response(JSON.stringify({ data: entries }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/me?")) {
      return new Response(JSON.stringify({ id: PROVIDER_USER_ID }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ id: PAGE_ID, instagram_business_account: { id: INSTAGRAM_ID } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  return new Response(JSON.stringify({}), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function loadHandler(current: Probe, functionsRoot = FUNCTIONS_ROOT) {
  const client = installClient(current);
  const globals = globalThis as { __postoraProbe?: unknown; __postoraRouteClient?: unknown };
  globals.__postoraProbe = current;
  globals.__postoraRouteClient = client;
  for (const [key, value] of Object.entries(ENV)) Deno.env.set(key, value);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? init.body : undefined;
    current.http.push({ url, body });
    return providerResponse(current, url);
  }) as typeof fetch;

  const capture = (...args: unknown[]) => {
    current.logs.push(
      args
        .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
        .join(" "),
    );
  };
  console.error = capture;
  console.log = capture;
  console.warn = capture;

  const outfile = await bundle("refresh-tokens/index.ts", functionsRoot);
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
  if (!current.handler) throw new Error("refresh-tokens did not register a request handler");
  return current.handler;
}

async function callJson(
  handler: (req: Request) => Response | Promise<Response>,
  body: unknown,
  headers: HeadersInit,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await handler(
    new Request("https://api.postora.invalid/functions/v1/refresh-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : {} };
}

function adminHeaders(): HeadersInit {
  return { Authorization: "Bearer synthetic-admin-jwt" };
}

function cronHeaders(): HeadersInit {
  return { "x-cron-secret": CRON_SECRET };
}

// ---------------------------------------------------------------------------
// The relocated source and the broken copies
// ---------------------------------------------------------------------------

let copySeq = 0;

/**
 * Copies one directory tree with the stable file APIs.
 *
 * The copy keeps the relative layout the route imports, so the bundle
 * resolves exactly like the original.
 */
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
 * Copies the source tree into an isolated directory and applies one mutation.
 *
 * The repository source is never touched. The copy keeps the relative layout
 * the route imports, so the bundle resolves exactly like the original.
 */
async function copyWithMutation(
  mutate: (functionsRoot: string) => void,
): Promise<string> {
  const target = `${COPY_DIR}/copy-${++copySeq}`;
  await Deno.mkdir(`${target}/supabase/functions`, { recursive: true });
  for (const folder of ["refresh-tokens", "_shared"]) {
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

routeTest("a manual force refresh of a Page-linked account reconciles its Page token", async () => {
  const current = probe();
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: INSTAGRAM_ACCOUNT_ID, force: true },
    adminHeaders(),
  );

  assertEquals(result.status, 200);
  assertEquals(result.json.status, "refreshed");
  assertEquals(result.json.accountId, INSTAGRAM_ACCOUNT_ID);

  assertEquals(current.rpc.includes("write_meta_page_reconciliation_success"), true);
  assertEquals(current.rpc.includes("write_direct_instagram_account"), false);
  assertEquals(current.rpc.includes("write_meta_account_refresh_success"), false);
  assertEquals(current.rpc.includes("record_meta_refresh_failure"), false);

  const write = current.rpcArgs.find(
    (entry) => entry.name === "write_meta_page_reconciliation_success",
  );
  assert(write !== undefined);
  const payload = write.args.p_payload as {
    operation: string;
    fields: Record<string, unknown>;
  };
  assertEquals(payload.operation, "page_reconciliation");
  assertEquals(payload.fields.access_token, DERIVED_PAGE_TOKEN);
  assertEquals(payload.fields.facebook_page_id, PAGE_ID);
  assertEquals(payload.fields.instagram_user_id, INSTAGRAM_ID);
  assertEquals(payload.fields.token_expires_at, null);

  // The provider received the captured User grant, never the account row.
  const graph = current.http.filter((entry) => entry.url.includes("graph.facebook.com"));
  assertEquals(graph.length, 3);
  assertEquals(graph.some((entry) => entry.url.includes(CAPTURED_USER_TOKEN)), true);
  assertEquals(graph.some((entry) => entry.url.includes(LEGACY_TOKEN)), false);

  // The history row carries the committed result.
  assertEquals(current.history.length, 1);
  assertEquals(current.history[0].status, "refreshed");
});

routeTest("a scheduled sweep reconciles a Page-linked account", async () => {
  const current = probe();
  const handler = await loadHandler(current);
  const result = await callJson(handler, {}, cronHeaders());

  assertEquals(result.status, 200);
  assertEquals(result.json.refreshed, 1);
  assertEquals(current.rpc.includes("write_meta_page_reconciliation_success"), true);
});

routeTest("a bulk force refresh reconciles a Page-linked account", async () => {
  const current = probe();
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountIds: [INSTAGRAM_ACCOUNT_ID], force: true },
    adminHeaders(),
  );

  assertEquals(result.status, 200);
  assertEquals(result.json.refreshed, 1);
  assertEquals(result.json.total, 1);
  assertEquals(current.rpc.includes("write_meta_page_reconciliation_success"), true);
});

routeTest("a Facebook Page reconciles with a null generation", async () => {
  const facebook = account({
    id: FACEBOOK_ACCOUNT_ID,
    platform: "facebook",
    platform_user_id: PAGE_ID,
    platform_username: "page_7001",
    ig_auth_type: null,
  });
  const current = probe({
    accounts: [facebook],
    bindings: [
      binding({
        social_account_id: FACEBOOK_ACCOUNT_ID,
        platform: "facebook",
        verified_facebook_page_id: null,
        verified_instagram_user_id: null,
      }),
    ],
  });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: FACEBOOK_ACCOUNT_ID, force: true },
    adminHeaders(),
  );

  assertEquals(result.status, 200);
  assertEquals(result.json.status, "refreshed");
  const write = current.rpcArgs.find(
    (entry) => entry.name === "write_meta_page_reconciliation_success",
  );
  assert(write !== undefined);
  const payload = write.args.p_payload as { fields: Record<string, unknown> };
  assertEquals(payload.fields.instagram_user_id, null);
  assertEquals(payload.fields.facebook_page_id, PAGE_ID);
});

routeTest("a provider failure is counted once and notified once", async () => {
  const current = probe({ providerMode: "revoked" });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: INSTAGRAM_ACCOUNT_ID, force: true },
    adminHeaders(),
  );

  assertEquals(result.status, 200);
  assertEquals(result.json.status, "needs_reauth");
  assertEquals(result.json.error, "provider_invalid_grant");
  assertEquals(
    current.rpc.filter((name) => name === "record_meta_refresh_failure").length,
    1,
  );
  const alerts = current.http.filter((entry) => entry.url.includes("send-token-failure-alert"));
  assertEquals(alerts.length, 1);
});

routeTest("an unknown provider failure never counts and never alerts", async () => {
  const current = probe({ providerMode: "unclassified" });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: INSTAGRAM_ACCOUNT_ID, force: true },
    adminHeaders(),
  );

  assertEquals(result.status, 200);
  assertEquals(result.json.status, "skipped");
  assertEquals(result.json.error, "provider_unclassified");
  assertEquals(current.rpc.includes("record_meta_refresh_failure"), false);
  assertEquals(current.http.filter((entry) => entry.url.includes("send-token-failure-alert")).length, 0);
});

routeTest("a missing protected Page defers without a failure", async () => {
  const current = probe({ providerMode: "missing-page" });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: INSTAGRAM_ACCOUNT_ID, force: true },
    adminHeaders(),
  );

  assertEquals(result.status, 200);
  assertEquals(result.json.status, "skipped");
  assertEquals(current.rpc.includes("record_meta_refresh_failure"), false);
});

routeTest("a malformed receipt is never reported as a refresh", async () => {
  const current = probe({ writeMode: "wrong-generation" });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: INSTAGRAM_ACCOUNT_ID, force: true },
    adminHeaders(),
  );

  assertEquals(result.status, 200);
  assertEquals(result.json.status, "error");
  assertEquals(result.json.error, "refresh_commit_indeterminate");
  assertEquals(current.rpc.filter((name) => name === "record_meta_refresh_failure").length, 0);
});

routeTest("a stale Page expiry is never reported as a refresh", async () => {
  const current = probe({ writeMode: "stale-expiry" });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: INSTAGRAM_ACCOUNT_ID, force: true },
    adminHeaders(),
  );

  assertEquals(result.status, 200);
  assertEquals(result.json.status, "error");
  assertEquals(result.json.error, "refresh_commit_indeterminate");
});

routeTest("the legacy mode never touches the protected schema", async () => {
  const current = probe({ setting: "legacy" });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: INSTAGRAM_ACCOUNT_ID, force: true },
    adminHeaders(),
  );

  assertEquals(result.status, 200);
  assertEquals(current.rpc.includes("read_instagram_account_capability"), false);
  assertEquals(current.rpc.includes("begin_meta_account_refresh"), false);
  assertEquals(current.rpc.includes("write_meta_page_reconciliation_success"), false);
});

routeTest("an ordinary owner is refused before any protected work", async () => {
  const current = probe({ roleMode: "none" });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: INSTAGRAM_ACCOUNT_ID, force: true },
    adminHeaders(),
  );

  assertEquals(result.status, 403);
  assertEquals(current.rpc.length, 0);
  assertEquals(current.http.length, 0);
});

routeTest("no token reaches a log line, a history row or the response", async () => {
  const current = probe({ providerMode: "revoked" });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: INSTAGRAM_ACCOUNT_ID, force: true },
    adminHeaders(),
  );

  const logs = current.logs.join("\n");
  assertEquals(logs.includes(CAPTURED_USER_TOKEN), false);
  assertEquals(logs.includes(DERIVED_PAGE_TOKEN), false);
  assertEquals(logs.includes(LEGACY_TOKEN), false);
  assertEquals(logs.includes("graph.facebook.com"), false);

  const history = JSON.stringify(current.history);
  assertEquals(history.includes(CAPTURED_USER_TOKEN), false);
  assertEquals(history.includes(DERIVED_PAGE_TOKEN), false);

  const body = JSON.stringify(result.json);
  assertEquals(body.includes(CAPTURED_USER_TOKEN), false);
  assertEquals(body.includes(DERIVED_PAGE_TOKEN), false);
});

// ---------------------------------------------------------------------------
// The relocation and the broken copies
// ---------------------------------------------------------------------------

routeTest("the relocated route still reconciles the Page token", async () => {
  const current = probe();
  const relocatedRoot = await copyWithMutation(() => {});
  const handler = await loadHandler(current, relocatedRoot);
  const result = await callJson(
    handler,
    { accountId: INSTAGRAM_ACCOUNT_ID, force: true },
    adminHeaders(),
  );

  assertEquals(result.status, 200);
  assertEquals(result.json.status, "refreshed");
  assertEquals(current.rpc.includes("write_meta_page_reconciliation_success"), true);
});

routeTest("a copy whose route no longer wires the protected gate stops reconciling", async () => {
  const brokenRoot = await copyWithMutation((root) => {
    replaceInFile(
      join(root, "refresh-tokens/index.ts"),
      "supportedMeta: async () => {",
      "legacySupportedMeta: async () => {",
    );
  });

  const current = probe();
  const handler = await loadHandler(current, brokenRoot);
  const result = await callJson(
    handler,
    { accountId: INSTAGRAM_ACCOUNT_ID, force: true },
    adminHeaders(),
  );

  // The route still answers, but it refuses the protected account instead of
  // reconciling it. The routing is load bearing.
  assertEquals(result.status, 503);
  assertEquals(result.json.error_code, "lifecycle_prerequisite_missing");
  assertEquals(current.rpc.includes("write_meta_page_reconciliation_success"), false);
  assertEquals(current.http.filter((entry) => entry.url.includes("graph.facebook.com")).length, 0);
});

routeTest("a copy that stops using the captured grant stops sending it", async () => {
  const brokenRoot = await copyWithMutation((root) => {
    replaceInFile(
      join(root, "refresh-tokens/protectedPageReconciliation.ts"),
      "capturedToken: capture.userToken,",
      "capturedToken: account.platformUserId ?? \"\",",
    );
  });

  const current = probe();
  const handler = await loadHandler(current, brokenRoot);
  await callJson(
    handler,
    { accountId: INSTAGRAM_ACCOUNT_ID, force: true },
    adminHeaders(),
  );

  const graph = current.http.filter((entry) => entry.url.includes("graph.facebook.com"));
  assertEquals(graph.length > 0, true);
  // The captured User secret never reaches the provider any more.
  assertEquals(graph.some((entry) => entry.url.includes(CAPTURED_USER_TOKEN)), false);
});

routeTest("a copy that stops checking the receipt starts reporting a bad receipt as a refresh", async () => {
  const brokenRoot = await copyWithMutation((root) => {
    replaceInFile(
      join(root, "refresh-tokens/protectedPageReconciliation.ts"),
      "if (!pageSuccessReceiptAgrees(write, capture, account)) {",
      "if (false) {",
    );
  });

  const current = probe({ writeMode: "wrong-generation" });
  const handler = await loadHandler(current, brokenRoot);
  const result = await callJson(
    handler,
    { accountId: INSTAGRAM_ACCOUNT_ID, force: true },
    adminHeaders(),
  );

  // The receipt check is load bearing: without it a wrong generation is
  // reported as a successful refresh.
  assertEquals(result.status, 200);
  assertEquals(result.json.status, "refreshed");
});
