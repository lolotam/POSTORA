/**
 * The actual registered refresh-tokens route.
 *
 * This suite loads the real `supabase/functions/refresh-tokens/index.ts`,
 * lets it register its handler through `Deno.serve`, and then drives real
 * requests through it. It is not a copy of the dispatch: a broken copy of the
 * route fails this suite.
 *
 * Only the infrastructure ports are stubbed. The authorization, the settings
 * resolution, the credential gate, the adapters, the orchestration and the
 * response mapping are the production code.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
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

const BUNDLE_DIR = Deno.makeTempDirSync({ prefix: "postora-refresh-handler-" });

const CRON_SECRET = "synthetic-cron-secret-for-the-refresh-suite";
const SERVICE_ROLE_KEY = "synthetic-service-role-key";
const OWNER_ID = "0f100001-0000-4000-8000-000000000001";
const OTHER_OWNER_ID = "0f100002-0000-4000-8000-000000000002";
const DIRECT_ACCOUNT_ID = "0f1a0001-0000-4000-8000-000000000011";
const PAGE_ACCOUNT_ID = "0f1a0002-0000-4000-8000-000000000012";
const TIKTOK_ACCOUNT_ID = "0f1a0003-0000-4000-8000-000000000013";
const CAPTURED_TOKEN = "captured-direct-token-must-not-leak";
const FRESH_TOKEN = "fresh-direct-token-must-not-leak";
const LEGACY_TOKEN = "legacy-token-must-not-leak";
const CAPTURED_USER_TOKEN = "captured-user-secret-must-not-leak";
const DERIVED_PAGE_TOKEN = "derived-page-token-must-not-leak";
const PROVIDER_USER_ID = "fb-user-9001";
const PAGE_ID = "page-7001";
const INSTAGRAM_ID = "ig-page-7001";
const CREDENTIAL_ID = "9a2c0001-0000-4000-8000-000000000021";
const BINDING_CONNECTION_VERSION = 4;
const PAGE_CAPTURE_ID = "726f97c3-305f-4674-a89d-79c4463b506a";

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
  capabilityMode: "ok" | "throw" | "malformed" | "missing";
  capabilityUpdatedAt: string | null;
  capabilityGeneration: number;
  beginMode: "ok" | "throw" | "malformed" | "wrong-account" | "wrong-generation";
  writeMode:
    | "ok"
    | "throw"
    | "malformed"
    | "stale"
    | "needs-reauth-cleared"
    | "inactive"
    | "wrong-provider"
    | "missing-binding"
    | "jumped-generation"
    | "reauth-set";
  failureMode: "ok" | "throw" | "malformed";
  providerMode:
    | "success"
    | "revoked"
    | "permission"
    | "rate-limited"
    | "server-error"
    | "timeout"
    | "malformed"
    | "unclassified"
    | "unknown-object"
    | "dirty-token"
    | "refresh-object"
    | "slow-expired";
  alertMode: "confirmed" | "unconfirmed" | "error";
  isAdmin: boolean;
  roleMode:
    | "admin"
    | "none"
    | "error"
    | "malformed"
    | "inherited"
    | "undefined-error"
    | "false-error"
    | "missing-error"
    | "inherited-error";
  profileMode: "ok" | "mismatch";
  handler: ((req: Request) => Response | Promise<Response>) | null;
  http: Array<{ url: string; body: string | undefined }>;
  rpc: string[];
  rpcArgs: Array<{ name: string; args: Record<string, unknown> }>;
  mutations: Array<{ table: string; op: string; payload: unknown }>;
  history: Array<Record<string, unknown>>;
  logs: string[];
  legacyCalls: string[];
  /** The protected binding rows the narrow binding reader may see. */
  bindings: Array<Record<string, unknown>>;
  /** The account the last Page capture was taken for. */
  pageCaptureAccountId: string | null;
}

function account(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: DIRECT_ACCOUNT_ID,
    user_id: OWNER_ID,
    platform: "instagram",
    platform_user_id: "ig-direct-1",
    platform_username: "ig_direct_1",
    access_token: LEGACY_TOKEN,
    refresh_token: null,
    token_expires_at: "2020-01-01T00:00:00.000Z",
    is_active: true,
    needs_reauth: false,
    failure_count: 0,
    last_refresh_error: null,
    last_alert_sent_at: null,
    alerts_snoozed: false,
    last_refresh_attempt_at: null,
    ig_auth_type: "business_login",
    loginKind: "direct",
    account_metadata: { access_token: LEGACY_TOKEN },
    auth_provider: null,
    workspace_id: null,
    ...overrides,
  };
}

function probe(overrides: Partial<Probe> = {}): Probe {
  return {
    setting: "protected",
    accounts: [account()],
    capabilityMode: "ok",
    capabilityUpdatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    capabilityGeneration: 3,
    beginMode: "ok",
    writeMode: "ok",
    failureMode: "ok",
    providerMode: "success",
    alertMode: "confirmed",
    isAdmin: true,
    roleMode: "admin",
    profileMode: "ok",
    handler: null,
    http: [],
    rpc: [],
    rpcArgs: [],
    mutations: [],
    history: [],
    logs: [],
    legacyCalls: [],
    bindings: [],
    pageCaptureAccountId: null,
    ...overrides,
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

function capabilityRow(current: Probe, accountId: string): Record<string, unknown> {
  if (current.capabilityMode === "malformed") return { found: true, login_kind: "direct" };
  if (current.capabilityMode === "missing") return { found: false };
  const row = current.accounts.find((candidate) => candidate.id === accountId);
  const kind = row?.loginKind ?? "direct";
  return {
    platform: "instagram",
    login_kind: kind,
    updated_at: new Date().toISOString(),
    granted_scopes: [],
    reconnected_at: null,
    scopes_read_at: null,
    generation_reason: "credential_refreshed",
    social_account_id: accountId,
    capability_present: true,
    last_read_failed_at: null,
    last_read_error_code: null,
    scopes_authoritative: false,
    credential_generation: current.capabilityGeneration,
    credential_updated_at: current.capabilityUpdatedAt,
    permission_read_state: "unknown",
    has_protected_credential: false,
  };
}

function beginWire(current: Probe, row: AccountRow): Record<string, unknown> {
  const capturedAt = new Date();
  const expiresAt = new Date(capturedAt.getTime() + 30 * 60 * 1000);
  const capturedIso = capturedAt.toISOString();
  const expiresIso = expiresAt.toISOString();
  const accountId = current.beginMode === "wrong-account" ? PAGE_ACCOUNT_ID : row.id;
  const generation = current.beginMode === "wrong-generation"
    ? current.capabilityGeneration + 1
    : current.capabilityGeneration;
  return {
    capture_id: "726f97c3-305f-4674-a89d-79c4463b506a",
    capture_version: 1,
    captured_at: capturedIso,
    expires_at: expiresIso,
    operation: "direct_token",
    attempt_marker: capturedIso,
    capture: {
      capture_version: 1,
      captured_at: capturedIso,
      expires_at: expiresIso,
      user_id: row.user_id,
      operation: "direct_token",
      credential: null,
      members: null,
      targets: [
        {
          social_account_id: accountId,
          platform: "instagram",
          platform_user_id: row.platform_user_id,
          binding_present: false,
          binding_credential_id: null,
          binding_connection_version: null,
          fence_state: "never_created",
          fence_connection_version: 0,
          credential_revision: null,
          provider_user_id: null,
          capability_present: true,
          capability_generation: generation,
          capability_login_kind: "direct",
          capability_permission_read_state: "unknown",
          token_expires_at: row.token_expires_at
            ? new Date(row.token_expires_at).toISOString()
            : null,
          refresh_token_present: false,
          failure_count: 0,
          needs_reauth: row.needs_reauth,
          last_refresh_attempt_at: capturedIso,
        },
      ],
    },
    tokens: [
      {
        scope: "account",
        social_account_id: accountId,
        credential_id: null,
        credential_revision: null,
        token: CAPTURED_TOKEN,
        token_expires_at: row.token_expires_at ? new Date(row.token_expires_at).toISOString() : null,
        refresh_token: null,
      },
    ],
  };
}

function accountState(row: AccountRow, overrides: Record<string, unknown> = {}) {
  return {
    found: true,
    social_account_id: row.id,
    platform: row.platform,
    platform_user_id: row.platform_user_id,
    login_kind: "direct",
    credential_generation: 4,
    binding_credential_id: null,
    binding_connection_version: null,
    credential_revision: null,
    token_expires_at: row.token_expires_at,
    refresh_token_present: false,
    failure_count: 0,
    needs_reauth: row.needs_reauth,
    is_active: true,
    ...overrides,
  };
}

/**
 * The captured Page reconciliation capture.
 *
 * This is the real shape of an accepted `facebook_user_token` capture: one
 * credential-scoped token entry, a validated credential object and the
 * captured membership of that one grant.
 */
function pageBeginWire(current: Probe, row: AccountRow): Record<string, unknown> {
  const capturedAt = new Date();
  const expiresAt = new Date(capturedAt.getTime() + 30 * 60 * 1000);
  const capturedIso = capturedAt.toISOString();
  const expiresIso = expiresAt.toISOString();
  const generation = current.capabilityGeneration;
  return {
    capture_id: PAGE_CAPTURE_ID,
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
          capability_generation: generation,
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
          capability_present: true,
          capability_generation: generation,
          capability_login_kind: "page_linked",
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

/** The exact eight-key receipt of the accepted Page reconciliation writer. */
function pageWriteReceipt(current: Probe, args: Record<string, unknown>) {
  const payload = args.p_payload as { capture_id: string };
  const row = current.accounts.find((candidate) => candidate.id === current.pageCaptureAccountId) ??
    current.accounts[0];
  const generation = current.capabilityGeneration + 1;
  return {
    data: {
      capture_id: String(payload.capture_id),
      operation: "page_reconciliation",
      applied: true,
      credential_id: CREDENTIAL_ID,
      credential_revision: 7,
      credential_generation: generation,
      expiry_state: "unknown",
      account: {
        found: true,
        social_account_id: row.id,
        platform: row.platform,
        platform_user_id: row.platform_user_id,
        login_kind: "page_linked",
        credential_generation: generation,
        binding_credential_id: CREDENTIAL_ID,
        binding_connection_version: BINDING_CONNECTION_VERSION,
        credential_revision: 7,
        token_expires_at: null,
        refresh_token_present: true,
        failure_count: 0,
        needs_reauth: row.needs_reauth,
        is_active: true,
      },
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
        } else {
          current.mutations.push({ table: this.table, op: this.op, payload });
        }
        return { data: null, error: null };
      }
      if (this.op === "update" || this.op === "upsert" || this.op === "delete") {
        current.mutations.push({
          table: this.table,
          op: this.op,
          payload: this.filters.payload,
        });
        // PostgREST answers an update that selected columns with the rows it
        // changed.
        return { data: [{ id: String(this.filters.id ?? "") }], error: null };
      }

      if (this.table === "app_settings") return settingsRow(current, String(this.filters.key ?? ""));
      if (this.table === "user_roles") {
        if (current.roleMode === "error") {
          return { data: null, error: { message: "role read failed" } };
        }
        if (current.roleMode === "malformed") return { data: { role: 7 }, error: null };
        if (current.roleMode === "inherited") {
          return { data: Object.create({ role: "admin" }), error: null };
        }
        if (current.roleMode === "undefined-error") {
          return { data: { role: "admin" }, error: undefined };
        }
        if (current.roleMode === "false-error") {
          return { data: { role: "admin" }, error: false };
        }
        if (current.roleMode === "missing-error") {
          return { data: { role: "admin" } } as { data: unknown; error: unknown };
        }
        if (current.roleMode === "inherited-error") {
          const envelope = Object.create({ error: null }) as { data?: unknown };
          envelope.data = { role: "admin" };
          return envelope as { data: unknown; error: unknown };
        }
        return {
          data: current.roleMode === "admin" ? { role: "admin" } : null,
          error: null,
        };
      }
      if (this.table === "profiles") {
        const id = current.profileMode === "mismatch"
          ? "not-the-owner"
          : String(this.filters.id ?? "");
        return {
          data: { id, email: "owner@example.invalid" },
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
        if (this.filters.user_id !== undefined && row.user_id !== this.filters.user_id) return false;
        if (this.filters.platform !== undefined && row.platform !== this.filters.platform) return false;
        if (this.filters.is_active !== undefined && row.is_active !== this.filters.is_active) return false;
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

function settingsRow(current: Probe, key: string) {
  if (current.setting === "throw") throw new Error(`settings read failed ${LEGACY_TOKEN}`);
  if (current.setting === "driver-error") {
    return { data: null, error: { message: `settings outage ${LEGACY_TOKEN}` } };
  }
  if (current.setting === "malformed") return { data: { unexpected: true }, error: null };
  if (current.setting === "absent" || key !== "credential_facebook_user_mode") {
    return { data: null, error: null };
  }
  return { data: { value: current.setting }, error: null };
}

function directWriteReceipt(current: Probe, args: Record<string, unknown>) {
  const payload = args.p_payload as {
    capture_id: string;
    fields?: { token_expires_at?: unknown };
  };
  const row = current.accounts[0];
  const writtenExpiry = payload.fields?.token_expires_at;
  const state = accountState(row, {
    ...(current.writeMode === "needs-reauth-cleared" ? { needs_reauth: false } : {}),
    ...(current.writeMode === "reauth-set" ? { needs_reauth: true } : {}),
    ...(typeof writtenExpiry === "string" ? { token_expires_at: writtenExpiry } : {}),
  }) as Record<string, unknown>;
  let generation = 4;
  if (current.writeMode === "inactive") state.is_active = false;
  if (current.writeMode === "wrong-provider") {
    state.platform_user_id = "different-provider-identity";
  }
  if (current.writeMode === "missing-binding") delete state.binding_credential_id;
  if (current.writeMode === "jumped-generation") {
    generation = 6;
    state.credential_generation = 6;
  }
  return {
    data: {
      capture_id: String(payload.capture_id),
      operation: "direct_token",
      applied: true,
      credential_generation: generation,
      account: state,
    },
    error: null,
  };
}

function rpcResult(current: Probe, name: string, args: Record<string, unknown>) {
  if (name === "read_instagram_account_capability") {
    if (current.capabilityMode === "throw") {
      return { data: null, error: { message: `capability outage ${LEGACY_TOKEN}` } };
    }
    if (current.capabilityMode === "missing") {
      return { data: null, error: { message: "not owned", code: "P0001" } };
    }
    const accountId = String(args.p_social_account_id ?? "");
    const row = current.accounts.find((candidate) => candidate.id === accountId);
    return { data: capabilityRow(current, accountId), error: null };
  }

  if (name === "begin_meta_account_refresh") {
    if (current.beginMode === "throw") {
      return { data: null, error: { message: `begin refused ${LEGACY_TOKEN}`, code: "MAR03" } };
    }
    if (current.beginMode === "malformed") return { data: { capture_version: 2 }, error: null };
    const accountId = String(
      (args.p_payload as { accounts: Array<{ social_account_id: string }> }).accounts[0]
        .social_account_id,
    );
    const operation = String(
      (args.p_payload as { accounts: Array<{ operation: string }> }).accounts[0].operation,
    );
    const row = current.accounts.find((candidate) => candidate.id === accountId) ??
      current.accounts[0];
    if (operation === "facebook_user_token") {
      current.pageCaptureAccountId = row.id;
      return { data: pageBeginWire(current, row), error: null };
    }
    return { data: beginWire(current, row), error: null };
  }

  if (name === "write_meta_page_reconciliation_success") {
    if (current.writeMode === "throw") {
      return { data: null, error: { message: `write refused ${LEGACY_TOKEN}`, code: "MAR04" } };
    }
    if (current.writeMode === "malformed") return { data: { applied: false }, error: null };
    return pageWriteReceipt(current, args);
  }

  if (name === "write_direct_instagram_account") {
    if (current.writeMode === "throw") {
      return { data: null, error: { message: `write refused ${LEGACY_TOKEN}`, code: "MAR04" } };
    }
    if (current.writeMode === "malformed") return { data: { applied: false }, error: null };
    return directWriteReceipt(current, args);
  }

  if (name === "record_meta_refresh_failure") {
    if (current.failureMode === "throw") {
      return { data: null, error: { message: `failure refused ${LEGACY_TOKEN}`, code: "MAR04" } };
    }
    if (current.failureMode === "malformed") return { data: { applied: true }, error: null };
    const row = current.accounts[0];
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
        account: accountState(row, {
          needs_reauth: permanent,
          failure_count: permanent ? 1 : 0,
        }),
      },
      error: null,
    };
  }

  // The legacy failure handler. It must never be reached for a protected
  // account.
  return { data: { transitioned: false, enqueued: 0, account_found: true }, error: null };
}

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
    ${avatarNames.map((name) => `export async function ${name}() { return null; }`).join("\n")}
    ${refreshNames.map((name) => `export async function ${name}() {
      P().legacyCalls.push(${JSON.stringify(name)});
      return { ok: true, access_token: ${JSON.stringify(FRESH_TOKEN)}, expires_in: 3600 };
    }`).join("\n")}
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
  bundles.set(entry, outfile);
  return outfile;
}

async function loadHandler(current: Probe) {
  const client = installClient(current);
  const globals = globalThis as { __postoraProbe?: unknown; __postoraRouteClient?: unknown };
  globals.__postoraProbe = current;
  globals.__postoraRouteClient = client;
  for (const [key, value] of Object.entries(ENV)) Deno.env.set(key, value);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? init.body : undefined;
    current.http.push({ url, body });
    if (current.providerMode === "slow-expired" && url.includes("graph.instagram.com")) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return new Response(
        JSON.stringify({
          access_token: FRESH_TOKEN,
          token_type: "bearer",
          expires_in: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
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

  const outfile = await bundle("refresh-tokens/index.ts");
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

  // The Graph provider of the Page reconciliation branch.
  if (url.includes("graph.facebook.com")) {
    if (current.providerMode === "timeout") {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
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
    if (current.providerMode === "rate-limited") {
      return new Response(JSON.stringify({}), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }
    if (current.providerMode === "server-error") {
      return new Response(JSON.stringify({}), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    if (current.providerMode === "unclassified") {
      return new Response(JSON.stringify({ unexpected: true }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/me/accounts")) {
      return new Response(
        JSON.stringify({ data: [{ id: PAGE_ID, access_token: DERIVED_PAGE_TOKEN }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/me?")) {
      return new Response(JSON.stringify({ id: PROVIDER_USER_ID }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        id: PAGE_ID,
        instagram_business_account: { id: INSTAGRAM_ID },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  if (current.providerMode === "timeout") {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
  if (current.providerMode === "revoked") {
    return new Response(
      JSON.stringify({ error: { type: "OAuthException", code: 190, message: "revoked" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  if (current.providerMode === "permission") {
    return new Response(
      JSON.stringify({ error: { type: "OAuthException", code: 200, message: "Permissions error" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  if (current.providerMode === "rate-limited") {
    return new Response(JSON.stringify({}), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  }
  if (current.providerMode === "server-error") {
    return new Response(JSON.stringify({}), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  if (current.providerMode === "unclassified") {
    return new Response(JSON.stringify({ unexpected: true }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  if (current.providerMode === "unknown-object") {
    return new Response(
      JSON.stringify({
        error: { type: "Unclassified", code: 777, message: "synthetic-secret" },
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  if (current.providerMode === "dirty-token") {
    return new Response(
      JSON.stringify({ access_token: " token ", token_type: "bearer", expires_in: 3600 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (current.providerMode === "refresh-object") {
    return new Response(
      JSON.stringify({
        access_token: FRESH_TOKEN,
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: { invalid: true },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (current.providerMode === "malformed") {
    return new Response(JSON.stringify({ access_token: "" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(
    JSON.stringify({
      access_token: FRESH_TOKEN,
      token_type: "bearer",
      expires_in: 5_184_000,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function cronHeaders(): HeadersInit {
  return { "x-cron-secret": CRON_SECRET };
}

function adminHeaders(): HeadersInit {
  return { Authorization: "Bearer synthetic-admin-jwt" };
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

// ---------------------------------------------------------------------------

routeTest("a manual force refresh of a direct account reaches the protected lifecycle", async () => {
  const current = probe();
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: DIRECT_ACCOUNT_ID, force: true },
    adminHeaders(),
  );

  assertEquals(result.status, 200);
  assertEquals(result.json.status, "refreshed");
  assertEquals(result.json.accountId, DIRECT_ACCOUNT_ID);

  // The provider received the captured token, not the account row token.
  const providerCalls = current.http.filter((entry) => entry.url.includes("graph.instagram.com"));
  assertEquals(providerCalls.length, 1);
  assertEquals(providerCalls[0].url.includes(CAPTURED_TOKEN), true);
  assertEquals(providerCalls[0].url.includes(LEGACY_TOKEN), false);

  // The accepted writer consumed the capture.
  assertEquals(current.rpc.includes("begin_meta_account_refresh"), true);
  assertEquals(current.rpc.includes("write_direct_instagram_account"), true);
  assertEquals(current.rpc.includes("record_meta_refresh_failure"), false);

  // The legacy failure handler and the legacy attempt marker are untouched.
  assertEquals(current.rpc.includes("partner_record_refresh_failure"), false);
  assertEquals(
    current.mutations.some((mutation) =>
      mutation.table === "social_accounts" && mutation.op === "update"
    ),
    false,
  );

  // The history row carries the committed result.
  assertEquals(current.history.length, 1);
  assertEquals(current.history[0].status, "refreshed");
});

routeTest("an ordinary owner is refused", async () => {
  const current = probe({ roleMode: "none" });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: DIRECT_ACCOUNT_ID, force: true },
    adminHeaders(),
  );
  assertEquals(result.status, 403);
  assertEquals(current.rpc.length, 0);
});

routeTest("an unreadable or malformed admin role fails closed", async () => {
  for (const roleMode of ["error", "malformed", "inherited"] as const) {
    const current = probe({ roleMode });
    const handler = await loadHandler(current);
    const result = await callJson(
      handler,
      { accountId: DIRECT_ACCOUNT_ID, force: true },
      adminHeaders(),
    );
    assertEquals(result.status, 403);
    assertEquals(current.rpc.length, 0);
  }
});

routeTest("the cron secret authorizes the sweep", async () => {
  const current = probe();
  const handler = await loadHandler(current);
  const result = await callJson(handler, {}, cronHeaders());
  assertEquals(result.status, 200);
  assertEquals(current.rpc.includes("begin_meta_account_refresh"), true);
});

routeTest("an unauthenticated request is refused", async () => {
  const current = probe();
  const handler = await loadHandler(current);
  const result = await callJson(handler, { accountId: DIRECT_ACCOUNT_ID, force: true }, {});
  assertEquals(result.status, 401);
});

routeTest("a failed settings read never selects the legacy path", async () => {
  const current = probe({ setting: "driver-error" });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: DIRECT_ACCOUNT_ID, force: true },
    adminHeaders(),
  );
  assertEquals(result.status, 503);
  assertEquals(result.json.error_code, "CREDENTIAL_CONFIGURATION_UNAVAILABLE");
  assertEquals(current.rpc.length, 0);
});

routeTest("a page-linked account reconciles its Page token", async () => {
  const current = probe({
    accounts: [
      account({
        id: PAGE_ACCOUNT_ID,
        platform_user_id: INSTAGRAM_ID,
        platform_username: "ig_page_1",
        ig_auth_type: "business_login",
        loginKind: "page_linked",
      }),
    ],
    bindings: [
      {
        social_account_id: PAGE_ACCOUNT_ID,
        user_id: OWNER_ID,
        platform: "instagram",
        credential_id: CREDENTIAL_ID,
        connection_version: BINDING_CONNECTION_VERSION,
        verified_facebook_user_id: PROVIDER_USER_ID,
        verified_facebook_page_id: PAGE_ID,
        verified_instagram_user_id: INSTAGRAM_ID,
      },
    ],
  });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: PAGE_ACCOUNT_ID, force: true },
    adminHeaders(),
  );

  assertEquals(result.status, 200);
  assertEquals(result.json.status, "refreshed");
  assertEquals(result.json.error_code, undefined);

  // The accepted Page writer consumed the capture. The direct writer and the
  // shared-User rotation writer are never used.
  assertEquals(current.rpc.includes("write_meta_page_reconciliation_success"), true);
  assertEquals(current.rpc.includes("write_direct_instagram_account"), false);
  assertEquals(current.rpc.includes("write_meta_account_refresh_success"), false);
  assertEquals(current.rpc.includes("record_meta_refresh_failure"), false);

  // The provider received the CAPTURED User grant, never the account row.
  const graphCalls = current.http.filter((entry) => entry.url.includes("graph.facebook.com"));
  assertEquals(graphCalls.length, 3);
  assertEquals(graphCalls.some((entry) => entry.url.includes(CAPTURED_USER_TOKEN)), true);
  assertEquals(graphCalls.some((entry) => entry.url.includes(LEGACY_TOKEN)), false);
  assertEquals(graphCalls.some((entry) => entry.url.includes(DERIVED_PAGE_TOKEN)), true);
});

routeTest("an Instagram account without a proven authority is still refused", async () => {
  const current = probe({
    accounts: [
      account({
        id: PAGE_ACCOUNT_ID,
        platform_user_id: INSTAGRAM_ID,
        platform_username: "ig_page_1",
        ig_auth_type: "business_login",
        loginKind: "page_linked",
      }),
    ],
    capabilityMode: "missing",
  });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: PAGE_ACCOUNT_ID, force: true },
    adminHeaders(),
  );

  assertEquals(result.status, 200);
  assertEquals(result.json.status, "failed");
  assertEquals(result.json.error, "protected_capability_read_failed");
  assertEquals(current.rpc.includes("begin_meta_account_refresh"), false);
  assertEquals(current.http.filter((entry) => entry.url.includes("graph.facebook.com")).length, 0);
});

routeTest("a bulk force refresh mixes a direct account and a Page account", async () => {
  const current = probe({
    accounts: [
      account(),
      account({
        id: PAGE_ACCOUNT_ID,
        platform_user_id: INSTAGRAM_ID,
        platform_username: "ig_page_1",
        loginKind: "page_linked",
      }),
    ],
    bindings: [
      {
        social_account_id: PAGE_ACCOUNT_ID,
        user_id: OWNER_ID,
        platform: "instagram",
        credential_id: CREDENTIAL_ID,
        connection_version: BINDING_CONNECTION_VERSION,
        verified_facebook_user_id: PROVIDER_USER_ID,
        verified_facebook_page_id: PAGE_ID,
        verified_instagram_user_id: INSTAGRAM_ID,
      },
    ],
  });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountIds: [DIRECT_ACCOUNT_ID, PAGE_ACCOUNT_ID], force: true },
    adminHeaders(),
  );

  assertEquals(result.status, 200);
  assertEquals(result.json.refreshed, 2);
  assertEquals(result.json.total, 2);
  assertEquals(current.rpc.includes("write_direct_instagram_account"), true);
  assertEquals(current.rpc.includes("write_meta_page_reconciliation_success"), true);
});

routeTest("a bulk force refresh of only Page accounts succeeds", async () => {
  const current = probe({
    accounts: [
      account({
        id: PAGE_ACCOUNT_ID,
        platform_user_id: INSTAGRAM_ID,
        platform_username: "ig_page_1",
        loginKind: "page_linked",
      }),
    ],
    bindings: [
      {
        social_account_id: PAGE_ACCOUNT_ID,
        user_id: OWNER_ID,
        platform: "instagram",
        credential_id: CREDENTIAL_ID,
        connection_version: BINDING_CONNECTION_VERSION,
        verified_facebook_user_id: PROVIDER_USER_ID,
        verified_facebook_page_id: PAGE_ID,
        verified_instagram_user_id: INSTAGRAM_ID,
      },
    ],
  });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountIds: [PAGE_ACCOUNT_ID], force: true },
    adminHeaders(),
  );
  assertEquals(result.status, 200);
  assertEquals(result.json.refreshed, 1);
  assertEquals(result.json.total, 1);
});

routeTest("the scheduled sweep refreshes the direct account", async () => {
  const current = probe();
  const handler = await loadHandler(current);
  const result = await callJson(handler, {}, cronHeaders());

  assertEquals(result.status, 200);
  assertEquals(result.json.refreshed, 1);
  assertEquals(current.rpc.includes("begin_meta_account_refresh"), true);
  assertEquals(current.rpc.includes("write_direct_instagram_account"), true);
  assertEquals(
    current.mutations.some((mutation) =>
      mutation.table === "social_accounts" && mutation.op === "update"
    ),
    false,
  );
});

routeTest("a revoked grant is recorded once and notified once", async () => {
  const current = probe({ providerMode: "revoked" });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: DIRECT_ACCOUNT_ID, force: true },
    adminHeaders(),
  );

  assertEquals(result.status, 200);
  assertEquals(result.json.status, "needs_reauth");
  assertEquals(result.json.error, "provider_invalid_grant");

  const failureCalls = current.rpcArgs.filter((entry) =>
    entry.name === "record_meta_refresh_failure"
  );
  assertEquals(failureCalls.length, 1);
  assertEquals(
    (failureCalls[0].args.p_payload as { error_category: string }).error_category,
    "provider_invalid_grant",
  );

  // The legacy failure handler never runs.
  assertEquals(current.rpc.includes("partner_record_refresh_failure"), false);

  // The notification is sent once, with the committed counter.
  const alerts = current.http.filter((entry) => entry.url.includes("send-token-failure-alert"));
  assertEquals(alerts.length, 1);
  const body = JSON.parse(alerts[0].body ?? "{}") as {
    failures: Array<{ errorMessage: string; failureCount: number }>;
  };
  assertEquals(body.failures.length, 1);
  assertEquals(body.failures[0].errorMessage, "provider_invalid_grant");
  assertEquals(body.failures[0].failureCount, 1);

  // The delivery outcome is its own operational event, not a refresh failure.
  assertEquals(
    current.logs.some((line) => line.includes("protected_refresh_alert")),
    true,
  );
});

routeTest("a notification that is not confirmed is logged as its own event", async () => {
  const current = probe({ providerMode: "revoked", alertMode: "unconfirmed" });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: DIRECT_ACCOUNT_ID, force: true },
    adminHeaders(),
  );
  assertEquals(result.status, 200);
  assertEquals(result.json.status, "needs_reauth");
  const alertLog = current.logs.find((line) => line.includes("protected_refresh_alert"));
  assertEquals(alertLog !== undefined, true);
  assertEquals(alertLog?.includes("unconfirmed"), true);
});

routeTest("a permission rejection counts instead of latching", async () => {
  const current = probe({ providerMode: "permission" });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: DIRECT_ACCOUNT_ID, force: true },
    adminHeaders(),
  );
  assertEquals(result.status, 200);
  assertEquals(result.json.status, "failed");
  assertEquals(result.json.error, "provider_permission_denied");
  const alerts = current.http.filter((entry) => entry.url.includes("send-token-failure-alert"));
  assertEquals(alerts.length, 0);
});

routeTest("a rate limit and a server error stay transient", async () => {
  for (const [mode, expected] of [
    ["rate-limited", "provider_rate_limited"],
    ["server-error", "provider_unavailable"],
  ] as const) {
    const current = probe({ providerMode: mode });
    const handler = await loadHandler(current);
    const result = await callJson(
      handler,
      { accountId: DIRECT_ACCOUNT_ID, force: true },
      adminHeaders(),
    );
    assertEquals(result.status, 200);
    assertEquals(result.json.error, expected);
  }
});

routeTest("a malformed provider success is a counted invalid response", async () => {
  const current = probe({ providerMode: "malformed" });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: DIRECT_ACCOUNT_ID, force: true },
    adminHeaders(),
  );
  assertEquals(result.status, 200);
  assertEquals(result.json.error, "provider_response_invalid");
  assertEquals(current.rpc.includes("record_meta_refresh_failure"), true);
});

routeTest("an unclassifiable failure keeps the capture and changes nothing", async () => {
  const current = probe({ providerMode: "unclassified" });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: DIRECT_ACCOUNT_ID, force: true },
    adminHeaders(),
  );
  assertEquals(result.status, 200);
  assertEquals(result.json.status, "skipped");
  assertEquals(result.json.error, "provider_unclassified");
  assertEquals(current.rpc.includes("record_meta_refresh_failure"), false);
  assertEquals(current.rpc.includes("write_direct_instagram_account"), false);
  assertEquals(current.http.filter((entry) => entry.url.includes("send-token-failure-alert")).length, 0);
});

routeTest("a stale capture is refused without a legacy write and without a retry", async () => {
  const current = probe({ writeMode: "throw" });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: DIRECT_ACCOUNT_ID, force: true },
    adminHeaders(),
  );

  assertEquals(result.status, 200);
  assertEquals(result.json.status, "failed");
  assertEquals(current.rpc.includes("record_meta_refresh_failure"), false);
  assertEquals(current.rpc.includes("partner_record_refresh_failure"), false);
  assertEquals(
    current.mutations.some((mutation) =>
      mutation.table === "social_accounts" && mutation.op === "update"
    ),
    false,
  );
  assertEquals(current.http.filter((entry) => entry.url.includes("graph.instagram.com")).length, 1);
});

routeTest("a capability read failure fails closed", async () => {
  const current = probe({ capabilityMode: "throw" });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: DIRECT_ACCOUNT_ID, force: true },
    adminHeaders(),
  );
  assertEquals(result.status, 200);
  assertEquals(result.json.status, "failed");
  assertEquals(result.json.error, "protected_capability_read_failed");
  assertEquals(current.rpc.includes("begin_meta_account_refresh"), false);
  assertEquals(current.http.filter((entry) => entry.url.includes("graph.instagram.com")).length, 0);
});

routeTest("an account without a valid authority timestamp defers", async () => {
  const current = probe({ capabilityUpdatedAt: null });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: DIRECT_ACCOUNT_ID, force: true },
    adminHeaders(),
  );
  assertEquals(result.status, 200);
  assertEquals(result.json.status, "skipped");
  assertEquals(result.json.error, "token_age_unproven");
  assertEquals(current.rpc.includes("begin_meta_account_refresh"), false);
});

routeTest("a recent authority defers even for a manual force", async () => {
  const current = probe({
    capabilityUpdatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: DIRECT_ACCOUNT_ID, force: true },
    adminHeaders(),
  );
  assertEquals(result.status, 200);
  assertEquals(result.json.status, "skipped");
  assertEquals(result.json.error, "authority_recent");
  assertEquals(current.rpc.includes("begin_meta_account_refresh"), false);
});

routeTest("a moved generation stops the attempt before the provider", async () => {
  const current = probe({ beginMode: "wrong-generation" });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: DIRECT_ACCOUNT_ID, force: true },
    adminHeaders(),
  );
  assertEquals(result.status, 200);
  assertEquals(result.json.error, "capture_context_mismatch");
  assertEquals(current.http.filter((entry) => entry.url.includes("graph.instagram.com")).length, 0);
  assertEquals(current.rpc.includes("record_meta_refresh_failure"), false);
});

routeTest("the legacy mode never touches the protected schema", async () => {
  const current = probe({ setting: "legacy" });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: DIRECT_ACCOUNT_ID, force: true },
    adminHeaders(),
  );

  assertEquals(result.status, 200);
  assertEquals(current.rpc.includes("read_instagram_account_capability"), false);
  assertEquals(current.rpc.includes("begin_meta_account_refresh"), false);
  assertEquals(current.rpc.includes("write_direct_instagram_account"), false);
  assertEquals(current.legacyCalls.includes("refreshInstagramBusinessToken"), true);
});

routeTest("an unrelated platform still refreshes in protected mode", async () => {
  const current = probe({
    accounts: [
      account({
        id: TIKTOK_ACCOUNT_ID,
        platform: "tiktok",
        platform_user_id: "tt-1",
        platform_username: "tt_1",
        access_token: "tiktok-token",
        refresh_token: "tiktok-refresh",
        ig_auth_type: null,
      }),
    ],
  });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: TIKTOK_ACCOUNT_ID, force: true },
    adminHeaders(),
  );

  assertEquals(result.status, 200);
  assertEquals(result.json.status, "refreshed");
  assertEquals(current.rpc.includes("read_instagram_account_capability"), false);
  assertEquals(current.legacyCalls.includes("refreshTikTokToken"), true);
});

routeTest("no token reaches a log line, a history row or the response", async () => {
  const current = probe({ providerMode: "revoked" });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: DIRECT_ACCOUNT_ID, force: true },
    adminHeaders(),
  );

  const logs = current.logs.join("\n");
  assertEquals(logs.includes(CAPTURED_TOKEN), false);
  assertEquals(logs.includes(FRESH_TOKEN), false);
  assertEquals(logs.includes(LEGACY_TOKEN), false);
  assertEquals(logs.includes("graph.instagram.com"), false);

  const history = JSON.stringify(current.history);
  assertEquals(history.includes(CAPTURED_TOKEN), false);
  assertEquals(history.includes(FRESH_TOKEN), false);
  assertEquals(history.includes(LEGACY_TOKEN), false);

  const body = JSON.stringify(result.json);
  assertEquals(body.includes(CAPTURED_TOKEN), false);
  assertEquals(body.includes(FRESH_TOKEN), false);
  assertEquals(body.includes(LEGACY_TOKEN), false);
});

routeTest("a protected account is not part of the global health population", async () => {
  const current = probe({ providerMode: "revoked" });
  const handler = await loadHandler(current);
  await callJson(handler, {}, cronHeaders());

  const healthAlerts = current.http.filter((entry) => {
    if (!entry.url.includes("send-token-failure-alert")) return false;
    return (entry.body ?? "").includes("healthAlert");
  });
  assertEquals(healthAlerts.length, 0);
});

routeTest("the response reports the committed state truthfully", async () => {
  const current = probe({ providerMode: "revoked" });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: DIRECT_ACCOUNT_ID, force: true },
    adminHeaders(),
  );
  assertEquals(result.json.status, "needs_reauth");
  assertEquals(result.json.error_code, "provider_invalid_grant");
});

routeTest("a role envelope that is not an explicit null error fails closed", async () => {
  for (const roleMode of [
    "undefined-error",
    "false-error",
    "missing-error",
    "inherited-error",
    "error",
  ] as const) {
    const current = probe({ roleMode });
    const handler = await loadHandler(current);
    const result = await callJson(
      handler,
      { accountId: DIRECT_ACCOUNT_ID, force: true },
      adminHeaders(),
    );
    assertEquals(result.status, 403);
    assertEquals(current.rpc.length, 0);
    assertEquals(current.http.length, 0);
    assertEquals(current.mutations.length, 0);
    assertEquals(current.history.length, 0);
    const logs = current.logs.join("\n");
    assertEquals(logs.includes('"message"'), false);
    assertEquals(logs.includes("admin_role_read_failed"), true);
  }
});

routeTest("an unknown provider error object does not count or alert", async () => {
  const current = probe({ providerMode: "unknown-object" });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: DIRECT_ACCOUNT_ID, force: true },
    adminHeaders(),
  );
  assertEquals(result.status, 200);
  assertEquals(result.json.status, "skipped");
  assertEquals(result.json.error, "provider_unclassified");
  assertEquals(current.rpc.includes("record_meta_refresh_failure"), false);
  assertEquals(current.rpc.includes("write_direct_instagram_account"), false);
  assertEquals(current.http.filter((entry) => entry.url.includes("graph.instagram.com")).length, 1);
  assertEquals(current.http.filter((entry) => entry.url.includes("send-token-failure-alert")).length, 0);
  assertEquals(JSON.stringify(current.rpc).includes("synthetic-secret"), false);
  assertEquals(current.logs.join("\n").includes("synthetic-secret"), false);
});

routeTest("dirty token material is an invalid response and is not written", async () => {
  for (const providerMode of ["dirty-token", "refresh-object"] as const) {
    const current = probe({ providerMode });
    const handler = await loadHandler(current);
    const result = await callJson(
      handler,
      { accountId: DIRECT_ACCOUNT_ID, force: true },
      adminHeaders(),
    );
    assertEquals(result.status, 200);
    assertEquals(result.json.error, "provider_response_invalid");
    const failures = current.rpc.filter((name) => name === "record_meta_refresh_failure");
    assertEquals(failures.length, 1);
    assertEquals(current.rpc.includes("write_direct_instagram_account"), false);
  }
});

routeTest("a body that arrives after the selected token expired is not written", async () => {
  const current = probe({ providerMode: "slow-expired" });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: DIRECT_ACCOUNT_ID, force: true },
    adminHeaders(),
  );
  assertEquals(result.status, 200);
  assertEquals(result.json.error, "provider_response_invalid");
  assertEquals(current.rpc.filter((name) => name === "record_meta_refresh_failure").length, 1);
  assertEquals(current.rpc.includes("write_direct_instagram_account"), false);
});

routeTest("a committed receipt that is not a direct refresh is not reported refreshed", async () => {
  for (const writeMode of [
    "wrong-provider",
    "inactive",
    "missing-binding",
    "jumped-generation",
    "reauth-set",
  ] as const) {
    const current = probe({ writeMode });
    const handler = await loadHandler(current);
    const result = await callJson(
      handler,
      { accountId: DIRECT_ACCOUNT_ID, force: true },
      adminHeaders(),
    );
    assertEquals(result.status, 200);
    assertEquals(result.json.status, "error");
    assertEquals(result.json.error, "refresh_commit_indeterminate");
    assertEquals(current.rpc.filter((name) => name === "write_direct_instagram_account").length, 1);
    assertEquals(current.rpc.includes("record_meta_refresh_failure"), false);
    assertEquals(
      current.http.filter((entry) => entry.url.includes("send-token-failure-alert")).length,
      0,
    );
  }
});

routeTest("a profile that is not the owner does not receive the failure email", async () => {
  const current = probe({ providerMode: "revoked", profileMode: "mismatch" });
  const handler = await loadHandler(current);
  const result = await callJson(
    handler,
    { accountId: DIRECT_ACCOUNT_ID, force: true },
    adminHeaders(),
  );
  assertEquals(result.json.status, "needs_reauth");
  assertEquals(current.rpc.filter((name) => name === "record_meta_refresh_failure").length, 1);
  assertEquals(
    current.http.filter((entry) => entry.url.includes("send-token-failure-alert")).length,
    0,
  );
});
