import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createMetaPageReconciliationStore,
  type ProtectedBindingReader,
} from "./metaPageReconciliationStore.ts";
import { createMetaPageReconciliationProvider } from "./metaPageReconciliationProvider.ts";
import {
  PROTECTED_PAGE_REFRESH_REASONS,
  pageRefreshFailureDecision,
  refreshProtectedMetaAccount,
  type ProtectedMetaAccountDeps,
} from "./protectedPageReconciliation.ts";
import type { MetaRefreshErrorCategory } from "./metaRefreshStore.ts";
import { createMetaRefreshStore } from "./metaRefreshStore.ts";
import type { MetaRefreshTransport } from "./metaRefreshProvider.ts";
import { createInstagramAccountCapabilityStore } from "../_shared/facebookUserCredentialStore.ts";

// ---------------------------------------------------------------------------
// Fixtures.
//
// The store, the provider and the orchestration are the REAL production
// modules. Only the SQL driver, the Graph transport and the notification
// transport are stubbed.
// ---------------------------------------------------------------------------

const OWNER_ID = "0f100001-0000-4000-8000-000000000001";
const ACCOUNT_ID = "0f1a0002-0000-4000-8000-000000000012";
const CAPTURE_ID = "726f97c3-305f-4674-a89d-79c4463b506a";
const CREDENTIAL_ID = "9a2c0001-0000-4000-8000-000000000021";
const CAPTURED_AT = "2026-10-28T12:13:38.574526+00:00";
const EXPIRES_AT = "2026-10-28T12:43:38.574526+00:00";
const GRANT_EXPIRY = "2026-12-01T00:00:00+00:00";
const DIRECT_EXPIRY = "2026-10-28T13:00:00.000Z";
const USER_TOKEN = "captured-user-secret-must-not-leak";
const PAGE_TOKEN = "derived-page-token-must-not-leak";
const PROVIDER_USER_ID = "fb-user-9001";
const PAGE_ID = "page-7001";
const INSTAGRAM_ID = "ig-page-7001";
const SERVICE_NOW = Date.parse("2026-10-28T12:20:00.000Z");

function pageTarget(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    social_account_id: ACCOUNT_ID,
    platform: "instagram",
    platform_user_id: INSTAGRAM_ID,
    binding_present: true,
    binding_credential_id: CREDENTIAL_ID,
    binding_connection_version: 4,
    fence_state: "present",
    fence_connection_version: 4,
    credential_revision: 7,
    provider_user_id: PROVIDER_USER_ID,
    capability_present: true,
    capability_generation: 11,
    capability_login_kind: "page_linked",
    capability_permission_read_state: "unknown",
    token_expires_at: "2026-10-01T00:00:00+00:00",
    refresh_token_present: true,
    failure_count: 0,
    needs_reauth: false,
    last_refresh_attempt_at: CAPTURED_AT,
    ...overrides,
  };
}

function beginWire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capture_id: CAPTURE_ID,
    capture_version: 1,
    captured_at: CAPTURED_AT,
    expires_at: EXPIRES_AT,
    operation: "facebook_user_token",
    attempt_marker: CAPTURED_AT,
    capture: {
      capture_version: 1,
      captured_at: CAPTURED_AT,
      expires_at: EXPIRES_AT,
      user_id: OWNER_ID,
      operation: "facebook_user_token",
      credential: {
        credential_id: CREDENTIAL_ID,
        revision: 7,
        provider_user_id: PROVIDER_USER_ID,
        token_expires_at: GRANT_EXPIRY,
      },
      members: [
        {
          social_account_id: ACCOUNT_ID,
          platform: "instagram",
          connection_version: 4,
          capability_generation: 11,
          fence_connection_version: 4,
        },
      ],
      targets: [pageTarget()],
    },
    tokens: [
      {
        scope: "credential",
        social_account_id: null,
        credential_id: CREDENTIAL_ID,
        credential_revision: 7,
        token: USER_TOKEN,
        token_expires_at: GRANT_EXPIRY,
        refresh_token: null,
      },
    ],
    ...overrides,
  };
}

function accountState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    found: true,
    social_account_id: ACCOUNT_ID,
    platform: "instagram",
    platform_user_id: INSTAGRAM_ID,
    login_kind: "page_linked",
    credential_generation: 12,
    binding_credential_id: CREDENTIAL_ID,
    binding_connection_version: 4,
    credential_revision: 7,
    token_expires_at: null,
    refresh_token_present: true,
    failure_count: 0,
    needs_reauth: false,
    is_active: true,
    ...overrides,
  };
}

function writeReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capture_id: CAPTURE_ID,
    operation: "page_reconciliation",
    applied: true,
    credential_id: CREDENTIAL_ID,
    credential_revision: 7,
    credential_generation: 12,
    expiry_state: "unknown",
    account: accountState(),
    ...overrides,
  };
}

function failureReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capture_id: CAPTURE_ID,
    applied: true,
    error_category: "provider_invalid_grant",
    failure_count: 1,
    escalated: true,
    alert_marker_written: true,
    transitioned: true,
    enqueued: 1,
    account_found: true,
    account: accountState({
      needs_reauth: true,
      failure_count: 1,
      token_expires_at: "2026-10-01T00:00:00+00:00",
    }),
    ...overrides,
  };
}

function bindingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    social_account_id: ACCOUNT_ID,
    user_id: OWNER_ID,
    platform: "instagram",
    credential_id: CREDENTIAL_ID,
    connection_version: 4,
    verified_facebook_user_id: PROVIDER_USER_ID,
    verified_facebook_page_id: PAGE_ID,
    verified_instagram_user_id: INSTAGRAM_ID,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Harness {
  deps: ProtectedMetaAccountDeps;
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
  http: Array<{ url: string; init: RequestInit | undefined }>;
  alerts: unknown[];
  logs: string[];
  /** Restores the console the harness replaced. */
  restore: () => void;
}

interface HarnessOptions {
  begin?: Record<string, unknown>;
  binding?: Record<string, unknown> | null;
  write?: Record<string, unknown>;
  failure?: Record<string, unknown>;
  directWrite?: Record<string, unknown>;
  capability?: Record<string, unknown>;
  provider?:
    | "ok"
    | "revoked"
    | "unclassified"
    | "timeout"
    | "missing-page"
    | "wrong-instagram"
    | "unavailable"
    | "counted";
  beginNever?: boolean;
  writeNever?: boolean;
  accountBudgetMs?: number;
  dbCallTimeoutMs?: number;
  platform?: "instagram" | "facebook";
  now?: () => Date;
  onBindingRead?: () => void;
}

function harness(options: HarnessOptions = {}): Harness {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const http: Array<{ url: string; init: RequestInit | undefined }> = [];
  const alerts: unknown[] = [];
  const logs: string[] = [];

  const rpc = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    rpcCalls.push({ name, args });
    if (name === "begin_meta_account_refresh") {
      if (options.beginNever) return await new Promise(() => {});
      return { data: options.begin ?? beginWire(), error: null };
    }
    if (name === "write_meta_page_reconciliation_success") {
      if (options.writeNever) return await new Promise(() => {});
      return { data: options.write ?? writeReceipt(), error: null };
    }
    if (name === "record_meta_refresh_failure") {
      return { data: options.failure ?? failureReceipt(), error: null };
    }
    if (name === "write_direct_instagram_account") {
      return {
        data: options.directWrite ?? {
          capture_id: CAPTURE_ID,
          operation: "direct_token",
          applied: true,
          credential_generation: 12,
          account: accountState({
            login_kind: "direct",
            credential_generation: 12,
            binding_credential_id: null,
            binding_connection_version: null,
            credential_revision: null,
            token_expires_at: DIRECT_EXPIRY,
          }),
        },
        error: null,
      };
    }
    if (name === "read_instagram_account_capability") {
      return { data: capabilityRow, error: null };
    }
    return { data: null, error: null };
  };

  const bindings: ProtectedBindingReader = async () => {
    options.onBindingRead?.();
    if (options.binding === null) return { data: null, error: null };
    return { data: options.binding ?? bindingRow(), error: null };
  };

  const providerMode = options.provider ?? "ok";
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    http.push({ url, init });
    if (providerMode === "timeout") throw new DOMException("aborted", "AbortError");
    if (providerMode === "revoked") {
      return jsonResponse(
        { error: { type: "OAuthException", code: 190, message: "revoked" } },
        400,
      );
    }
    if (providerMode === "unclassified") {
      return jsonResponse({ error: { type: "Unknown", code: 9 } }, 400);
    }
    if (providerMode === "unavailable") {
      return jsonResponse({ error: { message: "unavailable", code: 2, is_transient: true } }, 503);
    }
    if (providerMode === "counted") {
      return jsonResponse({ error: { type: "OAuthException", code: 1, message: "counted" } }, 400);
    }
    if (url.includes("/me/accounts")) {
      const entries = providerMode === "missing-page"
        ? [{ id: "page-other", access_token: "other-token" }]
        : [{ id: PAGE_ID, access_token: PAGE_TOKEN }];
      return jsonResponse({ data: entries });
    }
    if (url.includes("/me?")) {
      return jsonResponse({ id: PROVIDER_USER_ID });
    }
    return jsonResponse({
      id: PAGE_ID,
      instagram_business_account: {
        id: providerMode === "wrong-instagram" ? "ig-other" : INSTAGRAM_ID,
      },
    });
  }) as typeof fetch;

  const transport: MetaRefreshTransport = {
    async refreshDirectToken() {
      return {
        kind: "success",
        accessToken: "direct-refreshed-token-must-not-leak",
        tokenExpiresAt: DIRECT_EXPIRY,
        refreshToken: null,
      };
    },
    async sendFailureAlert(input) {
      alerts.push(input);
      return { outcome: "accepted", reason: "alert_accepted" };
    },
  };

  const capabilityRow = options.capability ?? {
    social_account_id: ACCOUNT_ID,
    capability_present: true,
    login_kind: "page_linked",
    permission_read_state: "unknown",
    scopes_authoritative: false,
    granted_scopes: [],
    scopes_read_at: null,
    last_read_failed_at: null,
    last_read_error_code: null,
    credential_generation: 11,
    credential_updated_at: "2026-10-20T00:00:00.000Z",
    generation_reason: "credential_refreshed",
    reconnected_at: null,
    has_protected_credential: true,
    updated_at: null,
  };
  // The REAL capability store parses the row. The fake only answers the RPC.
  const capabilities = createInstagramAccountCapabilityStore(rpc);

  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args: unknown[]) => {
    logs.push(args.map((value) => String(value)).join(" "));
  };
  console.log = (...args: unknown[]) => {
    logs.push(args.map((value) => String(value)).join(" "));
  };
  const restore = () => {
    console.error = originalError;
    console.log = originalLog;
  };

  const now = options.now ?? (() => new Date(SERVICE_NOW));
  const deps: ProtectedMetaAccountDeps = {
    direct: {
      store: createMetaRefreshStore(rpc),
      capabilities,
      transport,
      now,
      accountBudgetMs: options.accountBudgetMs ?? 24_000,
    },
    page: {
      store: createMetaPageReconciliationStore(rpc, bindings),
      provider: createMetaPageReconciliationProvider({ fetcher }),
      transport,
      dbCallTimeoutMs: options.dbCallTimeoutMs ?? 200,
    },
    now,
  };

  return { deps, rpcCalls, http, alerts, logs, restore };
}


const ACCOUNT = {
  id: ACCOUNT_ID,
  userId: OWNER_ID,
  platform: "instagram",
  platformUsername: "ig_page_1",
  platformUserId: INSTAGRAM_ID,
  lastRefreshAttemptAt: null,
};

// ---------------------------------------------------------------------------
// The Page branch
// ---------------------------------------------------------------------------

Deno.test("a page-linked Instagram account reconciles its Page token", async () => {
  const current = harness();
  const outcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: current.deps,
  });
  assertEquals(outcome.kind, "refreshed", JSON.stringify(outcome));
  if (outcome.kind === "refreshed") assertEquals(outcome.generation, 12);

  const write = current.rpcCalls.find(
    (call) => call.name === "write_meta_page_reconciliation_success",
  );
  assert(write !== undefined);
  const payload = write.args.p_payload as {
    capture_id: string;
    operation: string;
    fields: Record<string, unknown>;
  };
  assertEquals(payload.capture_id, CAPTURE_ID);
  assertEquals(payload.operation, "page_reconciliation");
  assertEquals(payload.fields.access_token, PAGE_TOKEN);
  assertEquals(payload.fields.facebook_page_id, PAGE_ID);
  assertEquals(payload.fields.instagram_user_id, INSTAGRAM_ID);
  assertEquals(payload.fields.token_expires_at, null);
  assertEquals(Object.keys(payload.fields).length, 4);

  // The shared-User rotation writer is never used.
  assertEquals(
    current.rpcCalls.some((call) => call.name === "write_meta_account_refresh_success"),
    false,
  );
  // The direct writer is never used for a Page account.
  assertEquals(
    current.rpcCalls.some((call) => call.name === "write_direct_instagram_account"),
    false,
  );
  current.restore();
});

Deno.test("the provider only ever receives the captured User grant", async () => {
  const current = harness();
  await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: current.deps,
  });
  const identity = current.http.find((call) => call.url.includes("/me?"));
  const listing = current.http.find((call) => call.url.includes("/me/accounts"));
  assert(identity !== undefined);
  assert(listing !== undefined);
  assertEquals(identity.url.includes(encodeURIComponent(USER_TOKEN)), true);
  assertEquals(listing.url.includes(encodeURIComponent(USER_TOKEN)), true);
  // The derived Page token authorizes the exact Page proof only.
  const proof = current.http.find((call) => call.url.includes("instagram_business_account"));
  assert(proof !== undefined);
  assertEquals(proof.url.includes(encodeURIComponent(PAGE_TOKEN)), true);
  assertEquals(current.http.length, 3);
  current.restore();
});

Deno.test("a Facebook Page reconciles with a null generation and a null Instagram identity", async () => {
  const current = harness();
  const facebook = harness({
    begin: beginWire({
      capture: {
        ...(beginWire().capture as Record<string, unknown>),
        targets: [
          pageTarget({
            platform: "facebook",
            platform_user_id: PAGE_ID,
            capability_present: false,
            capability_generation: null,
            capability_login_kind: null,
          }),
        ],
        members: [
          {
            social_account_id: ACCOUNT_ID,
            platform: "facebook",
            connection_version: 4,
            capability_generation: null,
            fence_connection_version: 4,
          },
        ],
      },
    }),
    binding: bindingRow({
      platform: "facebook",
      verified_facebook_page_id: null,
      verified_instagram_user_id: null,
    }),
    write: {
      capture_id: CAPTURE_ID,
      operation: "page_reconciliation",
      applied: true,
      credential_id: CREDENTIAL_ID,
      credential_revision: 7,
      credential_generation: null,
      expiry_state: "unknown",
      account: accountState({
        platform: "facebook",
        platform_user_id: PAGE_ID,
        login_kind: null,
        credential_generation: null,
        binding_connection_version: 5,
      }),
    },
  });
  void current;

  const outcome = await refreshProtectedMetaAccount({
    account: { ...ACCOUNT, platform: "facebook", platformUserId: PAGE_ID },
    trigger: "manual",
    bypassCooldown: true,
    deps: facebook.deps,
  });
  assertEquals(outcome.kind, "refreshed", JSON.stringify(outcome));
  if (outcome.kind === "refreshed") assertEquals(outcome.generation, null);

  const write = facebook.rpcCalls.find(
    (call) => call.name === "write_meta_page_reconciliation_success",
  );
  assert(write !== undefined);
  const payload = write.args.p_payload as { fields: Record<string, unknown> };
  assertEquals(payload.fields.instagram_user_id, null);
  assertEquals(payload.fields.facebook_page_id, PAGE_ID);
  current.restore();
});

// ---------------------------------------------------------------------------
// The classification
// ---------------------------------------------------------------------------

Deno.test("a direct Instagram account goes to the accepted direct branch", async () => {
  const current = harness({
    capability: {
      social_account_id: ACCOUNT_ID,
      capability_present: true,
      login_kind: "direct",
      permission_read_state: "unknown",
      scopes_authoritative: false,
      granted_scopes: [],
      scopes_read_at: null,
      last_read_failed_at: null,
      last_read_error_code: null,
      credential_generation: 11,
      credential_updated_at: "2026-10-20T00:00:00.000Z",
      generation_reason: "credential_refreshed",
      reconnected_at: null,
      has_protected_credential: false,
      updated_at: null,
    },
    begin: beginWire({
      operation: "direct_token",
      capture: {
        ...(beginWire().capture as Record<string, unknown>),
        operation: "direct_token",
        credential: null,
        members: null,
        targets: [
          pageTarget({
            binding_present: false,
            binding_credential_id: null,
            binding_connection_version: null,
            credential_revision: null,
            provider_user_id: null,
            capability_login_kind: "direct",
          }),
        ],
      },
      tokens: [
        {
          scope: "account",
          social_account_id: ACCOUNT_ID,
          credential_id: null,
          credential_revision: null,
          token: USER_TOKEN,
          token_expires_at: "2026-10-01T00:00:00+00:00",
          refresh_token: null,
        },
      ],
    }),
    write: {
      capture_id: CAPTURE_ID,
      operation: "direct_token",
      applied: true,
      credential_generation: 12,
      account: accountState({
        login_kind: "direct",
        credential_generation: 12,
        binding_credential_id: null,
        binding_connection_version: null,
        credential_revision: null,
      }),
    },
  });

  const outcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: current.deps,
  });
  assertEquals(outcome.kind, "refreshed", JSON.stringify(outcome));
  // The accepted direct writer ran, not the Page writer.
  assertEquals(
    current.rpcCalls.some((call) => call.name === "write_direct_instagram_account"),
    true,
  );
  assertEquals(
    current.rpcCalls.some((call) => call.name === "write_meta_page_reconciliation_success"),
    false,
  );
  current.restore();
});

Deno.test("an absent or unknown Instagram authority refuses", async () => {
  const cases: Array<[boolean, string | null]> = [
    [false, null],
    [true, null],
    [false, "direct"],
  ];
  for (const [capabilityPresent, loginKind] of cases) {
    const current = harness({
      capability: {
        social_account_id: ACCOUNT_ID,
        capability_present: capabilityPresent,
        login_kind: loginKind,
        permission_read_state: "unknown",
        scopes_authoritative: false,
        granted_scopes: [],
        scopes_read_at: null,
        last_read_failed_at: null,
        last_read_error_code: null,
        credential_generation: 11,
        credential_updated_at: "2026-10-20T00:00:00.000Z",
        generation_reason: "credential_refreshed",
        reconnected_at: null,
        has_protected_credential: false,
        updated_at: null,
      },
    });
    const outcome = await refreshProtectedMetaAccount({
      account: ACCOUNT,
      trigger: "manual",
      bypassCooldown: true,
      deps: current.deps,
    });
    assertEquals(outcome.kind, "unsupported");
    if (outcome.kind === "unsupported") {
      assertEquals(outcome.reason, PROTECTED_PAGE_REFRESH_REASONS.authorityUnknown);
    }
    assertEquals(
      current.rpcCalls.some((call) => call.name === "begin_meta_account_refresh"),
      false,
    );
    assertEquals(current.http.length, 0);
    current.restore();
  }
});

// ---------------------------------------------------------------------------
// The refusals
// ---------------------------------------------------------------------------

Deno.test("a protected binding that disagrees with the capture refuses before the provider", async () => {
  const current = harness({
    binding: bindingRow({ verified_instagram_user_id: "ig-other" }),
  });
  const outcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: current.deps,
  });
  assertEquals(outcome.kind, "deferred");
  if (outcome.kind === "deferred") {
    assertEquals(outcome.reason, PROTECTED_PAGE_REFRESH_REASONS.bindingDisagreement);
  }
  assertEquals(current.http.length, 0);
  assertEquals(
    current.rpcCalls.some((call) => call.name === "write_meta_page_reconciliation_success"),
    false,
  );
  current.restore();
});

Deno.test("a missing protected binding refuses before the provider", async () => {
  const current = harness({ binding: null });
  const outcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: current.deps,
  });
  assertEquals(outcome.kind, "deferred");
  if (outcome.kind === "deferred") {
    assertEquals(outcome.reason, PROTECTED_PAGE_REFRESH_REASONS.bindingMissing);
  }
  assertEquals(current.http.length, 0);
  current.restore();
});

Deno.test("a known expired User grant defers and never counts a failure", async () => {
  const current = harness({
    begin: beginWire({
      capture: {
        ...(beginWire().capture as Record<string, unknown>),
        credential: {
          credential_id: CREDENTIAL_ID,
          revision: 7,
          provider_user_id: PROVIDER_USER_ID,
          token_expires_at: "2026-10-01T00:00:00+00:00",
        },
      },
      tokens: [
        {
          scope: "credential",
          social_account_id: null,
          credential_id: CREDENTIAL_ID,
          credential_revision: 7,
          token: USER_TOKEN,
          token_expires_at: "2026-10-01T00:00:00+00:00",
          refresh_token: null,
        },
      ],
    }),
  });
  const outcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: current.deps,
  });
  assertEquals(outcome.kind, "deferred");
  if (outcome.kind === "deferred") {
    assertEquals(outcome.reason, PROTECTED_PAGE_REFRESH_REASONS.userGrantExpired);
  }
  assertEquals(current.http.length, 0);
  assertEquals(
    current.rpcCalls.some((call) => call.name === "record_meta_refresh_failure"),
    false,
  );
  current.restore();
});

Deno.test("an unknown User expiry is not a refusal and not a proof of validity", async () => {
  const current = harness({
    begin: beginWire({
      capture: {
        ...(beginWire().capture as Record<string, unknown>),
        credential: {
          credential_id: CREDENTIAL_ID,
          revision: 7,
          provider_user_id: PROVIDER_USER_ID,
          token_expires_at: null,
        },
      },
      tokens: [
        {
          scope: "credential",
          social_account_id: null,
          credential_id: CREDENTIAL_ID,
          credential_revision: 7,
          token: USER_TOKEN,
          token_expires_at: null,
          refresh_token: null,
        },
      ],
    }),
  });
  const outcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: current.deps,
  });
  assertEquals(outcome.kind, "refreshed", JSON.stringify(outcome));
  current.restore();
});

Deno.test("a scheduled attempt inside the cooldown defers before the capture", async () => {
  const current = harness();
  const outcome = await refreshProtectedMetaAccount({
    account: {
      ...ACCOUNT,
      lastRefreshAttemptAt: new Date(SERVICE_NOW - 60_000).toISOString(),
    },
    trigger: "scheduled",
    bypassCooldown: false,
    deps: current.deps,
  });
  assertEquals(outcome.kind, "deferred");
  if (outcome.kind === "deferred") {
    assertEquals(outcome.reason, "refresh_cooldown");
  }
  assertEquals(
    current.rpcCalls.some((call) => call.name === "begin_meta_account_refresh"),
    false,
  );
  current.restore();
});

// ---------------------------------------------------------------------------
// The uncertainty
// ---------------------------------------------------------------------------

Deno.test("a capture that never answers is indeterminate and starts no provider work", async () => {
  const current = harness({ beginNever: true, dbCallTimeoutMs: 20 });
  const outcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: current.deps,
  });
  assertEquals(outcome.kind, "indeterminate");
  if (outcome.kind === "indeterminate") {
    assertEquals(outcome.reason, PROTECTED_PAGE_REFRESH_REASONS.captureIndeterminate);
  }
  assertEquals(current.http.length, 0);
  assertEquals(
    current.rpcCalls.filter((call) => call.name === "begin_meta_account_refresh").length,
    1,
  );
  current.restore();
});

Deno.test("a write that never answers is indeterminate and never consumes twice", async () => {
  const current = harness({ writeNever: true, dbCallTimeoutMs: 20 });
  const outcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: current.deps,
  });
  assertEquals(outcome.kind, "indeterminate");
  if (outcome.kind === "indeterminate") {
    assertEquals(outcome.reason, "refresh_commit_indeterminate");
  }
  assertEquals(
    current.rpcCalls.filter(
      (call) => call.name === "write_meta_page_reconciliation_success",
    ).length,
    1,
  );
  assertEquals(
    current.rpcCalls.some((call) => call.name === "record_meta_refresh_failure"),
    false,
  );
  assertEquals(current.alerts.length, 0);
  current.restore();
});

Deno.test("a receipt that does not describe the reconciliation is indeterminate", async () => {
  const current = harness({
    write: writeReceipt({ credential_generation: 99 }),
  });
  const outcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: current.deps,
  });
  assertEquals(outcome.kind, "indeterminate");
  assertEquals(
    current.rpcCalls.some((call) => call.name === "record_meta_refresh_failure"),
    false,
  );
  assertEquals(current.alerts.length, 0);
  current.restore();
});

Deno.test("a receipt with a stale Page expiry is indeterminate", async () => {
  const current = harness({
    write: writeReceipt({
      account: accountState({ token_expires_at: "2027-01-01T00:00:00+00:00" }),
    }),
  });
  const outcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: current.deps,
  });
  assertEquals(outcome.kind, "indeterminate");
  current.restore();
});

Deno.test("a receipt with a cleared needs_reauth is indeterminate", async () => {
  const current = harness({
    begin: beginWire({
      capture: {
        ...(beginWire().capture as Record<string, unknown>),
        targets: [pageTarget({ needs_reauth: true })],
      },
    }),
    write: writeReceipt({
      account: accountState({ needs_reauth: false }),
    }),
  });
  const outcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: current.deps,
  });
  assertEquals(outcome.kind, "indeterminate");
  current.restore();
});

// ---------------------------------------------------------------------------
// The failure policy
// ---------------------------------------------------------------------------

Deno.test("a recognized provider failure is counted once and alerted once", async () => {
  const current = harness({ provider: "revoked" });
  const outcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: current.deps,
  });
  assertEquals(outcome.kind, "committed_failure");
  if (outcome.kind === "committed_failure") {
    assertEquals(outcome.category, "provider_invalid_grant");
    assertEquals(outcome.failureCount, 1);
    assertEquals(outcome.needsReauth, true);
  }
  assertEquals(
    current.rpcCalls.filter((call) => call.name === "record_meta_refresh_failure").length,
    1,
  );
  assertEquals(
    current.rpcCalls.some((call) => call.name === "write_meta_page_reconciliation_success"),
    false,
  );
  assertEquals(current.alerts.length, 1);
  current.restore();
});

Deno.test("an unknown provider error never counts and never alerts", async () => {
  const current = harness({ provider: "unclassified" });
  const outcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: current.deps,
  });
  assertEquals(outcome.kind, "deferred");
  if (outcome.kind === "deferred") {
    assertEquals(outcome.reason, PROTECTED_PAGE_REFRESH_REASONS.providerUnclassified);
  }
  assertEquals(
    current.rpcCalls.some((call) => call.name === "record_meta_refresh_failure"),
    false,
  );
  assertEquals(current.alerts.length, 0);
  current.restore();
});

Deno.test("a transport failure never counts and never alerts", async () => {
  const current = harness({ provider: "timeout" });
  const outcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: current.deps,
  });
  assertEquals(outcome.kind, "deferred");
  assertEquals(
    current.rpcCalls.some((call) => call.name === "record_meta_refresh_failure"),
    false,
  );
  assertEquals(current.alerts.length, 0);
  current.restore();
});

Deno.test("a missing Page or a wrong Instagram identity defers without a failure", async () => {
  for (const provider of ["missing-page", "wrong-instagram"] as const) {
    const current = harness({ provider });
    const outcome = await refreshProtectedMetaAccount({
      account: ACCOUNT,
      trigger: "manual",
      bypassCooldown: true,
      deps: current.deps,
    });
    assertEquals(outcome.kind, "deferred");
    assertEquals(
      current.rpcCalls.some((call) => call.name === "record_meta_refresh_failure"),
      false,
    );
    assertEquals(current.alerts.length, 0);
    current.restore();
  }
});

// ---------------------------------------------------------------------------
// The budgets
// ---------------------------------------------------------------------------

Deno.test("an exhausted account budget starts no provider work", async () => {
  const current = harness({ accountBudgetMs: 1, dbCallTimeoutMs: 500 });
  const outcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: current.deps,
  });
  assertEquals(outcome.kind, "deferred");
  assertEquals(current.http.length, 0);
  assertEquals(
    current.rpcCalls.some((call) => call.name === "write_meta_page_reconciliation_success"),
    false,
  );
  current.restore();
});

Deno.test("no token reaches a log line or a history row", async () => {
  const current = harness({ provider: "revoked" });
  await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: current.deps,
  });
  const logs = current.logs.join("\n");
  assertEquals(logs.includes(USER_TOKEN), false);
  assertEquals(logs.includes(PAGE_TOKEN), false);
  assertEquals(logs.includes("graph.facebook.com"), false);
  current.restore();
});

// ---------------------------------------------------------------------------
// Correction boundaries. The original assertions above stay as they are.
// ---------------------------------------------------------------------------

function windowedBegin(capturedMs: number, expiresMs: number): Record<string, unknown> {
  const captured = new Date(capturedMs).toISOString();
  const expires = new Date(expiresMs).toISOString();
  const wire = beginWire();
  wire.captured_at = captured;
  wire.expires_at = expires;
  wire.attempt_marker = captured;
  const capture = wire.capture as Record<string, unknown>;
  capture.captured_at = captured;
  capture.expires_at = expires;
  (capture.targets as Array<Record<string, unknown>>)[0].last_refresh_attempt_at = captured;
  return wire;
}

Deno.test("success keeps needs_reauth false and true, and both flips are indeterminate", async () => {
  const retainedFalse = harness();
  const falseOutcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: retainedFalse.deps,
  });
  assertEquals(falseOutcome.kind, "refreshed");
  retainedFalse.restore();

  const retainedTrue = harness({
    begin: beginWire({
      capture: {
        ...(beginWire().capture as Record<string, unknown>),
        targets: [pageTarget({ needs_reauth: true })],
      },
    }),
    write: writeReceipt({ account: accountState({ needs_reauth: true }) }),
  });
  const trueOutcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: retainedTrue.deps,
  });
  assertEquals(trueOutcome.kind, "refreshed");
  assertEquals(retainedTrue.alerts.length, 0);
  retainedTrue.restore();

  const flipped = harness({
    write: writeReceipt({ account: accountState({ needs_reauth: true }) }),
  });
  const flippedOutcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: flipped.deps,
  });
  assertEquals(flippedOutcome.kind, "indeterminate");
  assertEquals(
    flipped.rpcCalls.filter((call) => call.name === "write_meta_page_reconciliation_success").length,
    1,
  );
  assertEquals(flipped.rpcCalls.some((call) => call.name === "record_meta_refresh_failure"), false);
  assertEquals(flipped.alerts.length, 0);
  flipped.restore();
});

Deno.test("a capture more than five seconds ahead is refused and a skew inside five seconds is live", async () => {
  const future = harness({
    begin: windowedBegin(SERVICE_NOW + 60 * 60 * 1000, SERVICE_NOW + 70 * 60 * 1000),
  });
  const futureOutcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: future.deps,
  });
  assertEquals(futureOutcome.kind, "deferred");
  if (futureOutcome.kind === "deferred") {
    assertEquals(futureOutcome.reason, PROTECTED_PAGE_REFRESH_REASONS.captureExpired);
  }
  assertEquals(future.http.length, 0);
  assertEquals(future.rpcCalls.some((call) => call.name === "write_meta_page_reconciliation_success"), false);
  assertEquals(future.rpcCalls.some((call) => call.name === "record_meta_refresh_failure"), false);
  future.restore();

  const beyond = harness({
    begin: windowedBegin(SERVICE_NOW + 5_001, SERVICE_NOW + 30 * 60 * 1000),
  });
  const beyondOutcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: beyond.deps,
  });
  assertEquals(beyondOutcome.kind, "deferred");
  assertEquals(beyond.http.length, 0);
  beyond.restore();

  const tolerated = harness({
    begin: windowedBegin(SERVICE_NOW + 5_000, SERVICE_NOW + 30 * 60 * 1000),
  });
  const toleratedOutcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: tolerated.deps,
  });
  assertEquals(toleratedOutcome.kind, "refreshed", JSON.stringify(toleratedOutcome));
  assertEquals(tolerated.http.length, 3);
  tolerated.restore();
});

Deno.test("capture and User expiry discovered after the binding read start no provider work", async () => {
  let captureNow = SERVICE_NOW;
  const captureExpired = harness({
    begin: windowedBegin(SERVICE_NOW - 1_000, SERVICE_NOW + 2_000),
    now: () => new Date(captureNow),
    onBindingRead: () => {
      captureNow += 5_000;
    },
  });
  const captureOutcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: captureExpired.deps,
  });
  assertEquals(captureOutcome.kind, "deferred");
  if (captureOutcome.kind === "deferred") {
    assertEquals(captureOutcome.reason, PROTECTED_PAGE_REFRESH_REASONS.captureExpired);
  }
  assertEquals(captureExpired.http.length, 0);
  assertEquals(captureExpired.alerts.length, 0);
  assertEquals(
    captureExpired.rpcCalls.some((call) => call.name === "record_meta_refresh_failure"),
    false,
  );
  captureExpired.restore();

  let grantNow = SERVICE_NOW;
  const grantWire = beginWire();
  (grantWire.capture as { credential: Record<string, unknown> }).credential.token_expires_at =
    new Date(SERVICE_NOW + 2_000).toISOString();
  (grantWire.tokens as Array<Record<string, unknown>>)[0].token_expires_at =
    new Date(SERVICE_NOW + 2_000).toISOString();
  const grantExpired = harness({
    begin: grantWire,
    now: () => new Date(grantNow),
    onBindingRead: () => {
      grantNow += 5_000;
    },
  });
  const grantOutcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: grantExpired.deps,
  });
  assertEquals(grantOutcome.kind, "deferred");
  if (grantOutcome.kind === "deferred") {
    assertEquals(grantOutcome.reason, PROTECTED_PAGE_REFRESH_REASONS.userGrantExpired);
  }
  assertEquals(grantExpired.http.length, 0);
  assertEquals(grantExpired.rpcCalls.some((call) => call.name === "record_meta_refresh_failure"), false);
  grantExpired.restore();
});

Deno.test("a budget that dies during the binding read starts no provider work", async () => {
  let now = SERVICE_NOW;
  const current = harness({
    now: () => new Date(now),
    onBindingRead: () => {
      now += 21_000;
    },
  });
  const outcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: current.deps,
  });
  assertEquals(outcome.kind, "deferred");
  if (outcome.kind === "deferred") {
    assertEquals(outcome.reason, PROTECTED_PAGE_REFRESH_REASONS.budgetExhausted);
  }
  assertEquals(current.http.length, 0);
  assertEquals(current.alerts.length, 0);
  current.restore();
});

function failureFor(input: {
  category: MetaRefreshErrorCategory;
  capturedCount: number;
  capturedNeedsReauth: boolean;
  marker: boolean;
  transitioned: boolean;
  enqueued: number;
  count?: number;
  escalated?: boolean;
  needsReauth?: boolean;
}): Record<string, unknown> {
  const decision = pageRefreshFailureDecision(input.category, input.capturedCount);
  assert(decision !== null);
  const count = input.count ?? decision.failureCount;
  const escalated = input.escalated ?? decision.escalated;
  const needsReauth = input.needsReauth ?? (input.capturedNeedsReauth || decision.escalated);
  return failureReceipt({
    error_category: input.category,
    failure_count: count,
    escalated,
    alert_marker_written: input.marker,
    transitioned: input.transitioned,
    enqueued: input.enqueued,
    account: accountState({
      failure_count: count,
      needs_reauth: needsReauth,
      token_expires_at: "2026-10-01T00:00:00+00:00",
    }),
  });
}

function beginWithHealth(failureCount: number, needsReauth: boolean): Record<string, unknown> {
  return beginWire({
    capture: {
      ...(beginWire().capture as Record<string, unknown>),
      targets: [pageTarget({ failure_count: failureCount, needs_reauth: needsReauth })],
    },
  });
}

Deno.test("failure receipts follow the captured policy, including a latch that was already true", async () => {
  const permanent = harness({
    provider: "revoked",
    begin: beginWithHealth(0, true),
    failure: failureFor({
      category: "provider_invalid_grant",
      capturedCount: 0,
      capturedNeedsReauth: true,
      marker: false,
      transitioned: false,
      enqueued: 0,
    }),
  });
  const permanentOutcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: permanent.deps,
  });
  assertEquals(permanentOutcome.kind, "committed_failure");
  if (permanentOutcome.kind === "committed_failure") {
    assertEquals(permanentOutcome.failureCount, 1);
    assertEquals(permanentOutcome.needsReauth, true);
    assertEquals(permanentOutcome.escalated, true);
    assertEquals(permanentOutcome.alert, null);
  }
  assertEquals(permanent.alerts.length, 0);
  assertEquals(
    permanent.rpcCalls.filter((call) => call.name === "record_meta_refresh_failure").length,
    1,
  );
  permanent.restore();

  const transient = harness({
    provider: "unavailable",
    failure: failureFor({
      category: "provider_unavailable",
      capturedCount: 0,
      capturedNeedsReauth: false,
      marker: false,
      transitioned: false,
      enqueued: 0,
    }),
  });
  const transientOutcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: transient.deps,
  });
  assertEquals(transientOutcome.kind, "committed_failure");
  if (transientOutcome.kind === "committed_failure") {
    assertEquals(transientOutcome.failureCount, 0);
    assertEquals(transientOutcome.escalated, false);
    assertEquals(transientOutcome.needsReauth, false);
    assertEquals(transientOutcome.alert, null);
  }
  assertEquals(transient.alerts.length, 0);
  transient.restore();

  const retained = harness({
    provider: "unavailable",
    begin: beginWithHealth(0, true),
    failure: failureFor({
      category: "provider_unavailable",
      capturedCount: 0,
      capturedNeedsReauth: true,
      marker: false,
      transitioned: false,
      enqueued: 0,
    }),
  });
  const retainedOutcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: retained.deps,
  });
  assertEquals(retainedOutcome.kind, "committed_failure");
  if (retainedOutcome.kind === "committed_failure") {
    assertEquals(retainedOutcome.needsReauth, true);
    assertEquals(retainedOutcome.escalated, false);
  }
  assertEquals(retained.alerts.length, 0);
  retained.restore();

  const threshold = harness({
    provider: "counted",
    begin: beginWithHealth(2, false),
    failure: failureFor({
      category: "provider_error",
      capturedCount: 2,
      capturedNeedsReauth: false,
      marker: true,
      transitioned: true,
      enqueued: 1,
    }),
  });
  const thresholdOutcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: threshold.deps,
  });
  assertEquals(thresholdOutcome.kind, "committed_failure");
  if (thresholdOutcome.kind === "committed_failure") {
    assertEquals(thresholdOutcome.failureCount, 3);
    assertEquals(thresholdOutcome.escalated, true);
    assertEquals(thresholdOutcome.needsReauth, true);
  }
  assertEquals(threshold.alerts.length, 1);
  threshold.restore();

  const below = harness({
    provider: "counted",
    begin: beginWithHealth(1, false),
    failure: failureFor({
      category: "provider_error",
      capturedCount: 1,
      capturedNeedsReauth: false,
      marker: false,
      transitioned: false,
      enqueued: 0,
    }),
  });
  const belowOutcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: below.deps,
  });
  assertEquals(belowOutcome.kind, "committed_failure");
  if (belowOutcome.kind === "committed_failure") {
    assertEquals(belowOutcome.failureCount, 2);
    assertEquals(belowOutcome.escalated, false);
    assertEquals(belowOutcome.needsReauth, false);
  }
  assertEquals(below.alerts.length, 0);
  below.restore();
});

Deno.test("a contradictory failure count or alert marker is indeterminate and sends no alert", async () => {
  const wrongCount = harness({
    provider: "revoked",
    failure: failureFor({
      category: "provider_invalid_grant",
      capturedCount: 0,
      capturedNeedsReauth: false,
      marker: true,
      transitioned: true,
      enqueued: 1,
      count: 0,
      escalated: true,
      needsReauth: true,
    }),
  });
  const countOutcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: wrongCount.deps,
  });
  assertEquals(countOutcome.kind, "indeterminate");
  assertEquals(
    wrongCount.rpcCalls.filter((call) => call.name === "record_meta_refresh_failure").length,
    1,
  );
  assertEquals(wrongCount.alerts.length, 0);
  wrongCount.restore();

  const wrongMarker = harness({
    provider: "unavailable",
    failure: failureFor({
      category: "provider_unavailable",
      capturedCount: 0,
      capturedNeedsReauth: false,
      marker: true,
      transitioned: false,
      enqueued: 0,
    }),
  });
  const markerOutcome = await refreshProtectedMetaAccount({
    account: ACCOUNT,
    trigger: "manual",
    bypassCooldown: true,
    deps: wrongMarker.deps,
  });
  assertEquals(markerOutcome.kind, "indeterminate");
  assertEquals(wrongMarker.alerts.length, 0);
  assertEquals(
    wrongMarker.rpcCalls.filter((call) => call.name === "record_meta_refresh_failure").length,
    1,
  );
  wrongMarker.restore();
});

Deno.test("every accepted failure category decides from the captured count", () => {
  const cases: Array<[MetaRefreshErrorCategory, number, number, boolean]> = [
    ["provider_transient", 0, 0, false],
    ["provider_rate_limited", 2, 2, false],
    ["provider_unavailable", 4, 4, false],
    ["local_internal_error", 1, 1, false],
    ["provider_auth_expired", 0, 1, true],
    ["provider_auth_revoked", 2, 3, true],
    ["provider_invalid_grant", 0, 1, true],
    ["local_no_refresh_material", 5, 6, true],
    ["provider_error", 1, 2, false],
    ["provider_error", 2, 3, true],
    ["provider_permission_denied", 0, 1, false],
    ["provider_permission_denied", 2, 3, true],
    ["provider_response_invalid", 2, 3, true],
  ];
  for (const [category, captured, count, escalated] of cases) {
    assertEquals(pageRefreshFailureDecision(category, captured), { failureCount: count, escalated });
  }
  assertEquals(pageRefreshFailureDecision("provider_error", -1), null);
});
