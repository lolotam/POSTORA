import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { InstagramAccountCapabilityPort } from "../_shared/facebookUserCredentialStore.ts";
import {
  evaluateAuthorityAge,
  isWithinProtectedRefreshCooldown,
  PROTECTED_REFRESH_MIN_AUTHORITY_AGE_MS,
  PROTECTED_REFRESH_REASONS,
  refreshProtectedDirectAccount,
  type ProtectedDirectAccount,
  type ProtectedDirectDeps,
} from "./protectedMetaRefresh.ts";
import type {
  MetaRefreshBeginResult,
  MetaRefreshDirectWriteResult,
  MetaRefreshFailureResult,
  MetaRefreshStore,
} from "./metaRefreshStore.ts";
import type {
  DirectRefreshProviderOutcome,
  MetaRefreshTransport,
  ProtectedAlertResult,
} from "./metaRefreshProvider.ts";

const OWNER_ID = "0f100001-0000-4000-8000-000000000001";
const ACCOUNT_ID = "0f1a0001-0000-4000-8000-000000000011";
const CAPTURE_ID = "726f97c3-305f-4674-a89d-79c4463b506a";
const NOW = new Date("2026-10-28T12:14:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

const ACCOUNT: ProtectedDirectAccount = {
  id: ACCOUNT_ID,
  userId: OWNER_ID,
  platform: "instagram",
  platformUsername: "ig_direct_1",
  platformUserId: "ig-direct-1",
  lastRefreshAttemptAt: null,
};

function capability(overrides: Record<string, unknown> = {}) {
  return {
    socialAccountId: ACCOUNT_ID,
    capabilityPresent: true,
    loginKind: "direct" as const,
    permissionReadState: "unknown" as const,
    scopesAuthoritative: false,
    grantedScopes: [],
    scopesReadAt: null,
    lastReadFailedAt: null,
    lastReadErrorCode: null,
    credentialGeneration: 3,
    credentialUpdatedAt: new Date(NOW.getTime() - 48 * HOUR_MS).toISOString(),
    generationReason: "credential_refreshed",
    reconnectedAt: null,
    hasProtectedCredential: false,
    updatedAt: null,
    ...overrides,
  };
}

function beginResult(overrides: Record<string, unknown> = {}): MetaRefreshBeginResult {
  const capturedAt = new Date(NOW.getTime() - 1_000).toISOString();
  const expiresAt = new Date(NOW.getTime() + 29 * 60 * 1000).toISOString();
  return {
    captureId: CAPTURE_ID,
    captureVersion: 1,
    capturedAt: Date.parse(capturedAt),
    expiresAt: Date.parse(expiresAt),
    operation: "direct_token",
    attemptMarker: Date.parse(capturedAt),
    capture: {
      captureVersion: 1,
      capturedAt: Date.parse(capturedAt),
      expiresAt: Date.parse(expiresAt),
      userId: OWNER_ID,
      operation: "direct_token",
      targets: [
        {
          socialAccountId: ACCOUNT_ID,
          platform: "instagram",
          platformUserId: "ig-direct-1",
          bindingPresent: false,
          bindingCredentialId: null,
          bindingConnectionVersion: null,
          fenceState: "never_created",
          fenceConnectionVersion: 0,
          credentialRevision: null,
          providerUserId: null,
          capabilityPresent: true,
          capabilityGeneration: 3,
          capabilityLoginKind: "direct",
          capabilityPermissionReadState: "unknown",
          tokenExpiresAt: Date.parse("2027-01-01T00:00:00.000Z"),
          refreshTokenPresent: true,
          failureCount: 0,
          needsReauth: false,
          lastRefreshAttemptAt: Date.parse(capturedAt),
        },
      ],
      credential: null,
      members: null,
    },
    tokens: [
      {
        scope: "account",
        socialAccountId: ACCOUNT_ID,
        credentialId: null,
        credentialRevision: null,
        token: "captured-direct-token",
        tokenExpiresAt: Date.parse("2027-01-01T00:00:00.000Z"),
        refreshToken: "captured-refresh-token",
      },
    ],
    ...overrides,
  } as MetaRefreshBeginResult;
}

function directWriteResult(
  overrides: Record<string, unknown> = {},
): MetaRefreshDirectWriteResult {
  return {
    captureId: CAPTURE_ID,
    operation: "direct_token",
    applied: true,
    credentialGeneration: 4,
    account: {
      found: true,
      socialAccountId: ACCOUNT_ID,
      platform: "instagram",
      platformUserId: "ig-direct-1",
      loginKind: "direct",
      credentialGeneration: 4,
      bindingCredentialId: null,
      bindingConnectionVersion: null,
      credentialRevision: null,
      tokenExpiresAt: Date.parse("2026-10-29T12:14:00.000Z"),
      refreshTokenPresent: true,
      failureCount: 0,
      needsReauth: false,
      isActive: true,
    },
    ...overrides,
  } as MetaRefreshDirectWriteResult;
}

function failureResult(
  overrides: Record<string, unknown> = {},
): MetaRefreshFailureResult {
  return {
    captureId: CAPTURE_ID,
    applied: true,
    errorCategory: "provider_invalid_grant",
    failureCount: 1,
    escalated: true,
    alertMarkerWritten: true,
    transitioned: true,
    enqueued: 1,
    accountFound: true,
    account: {
      found: true,
      socialAccountId: ACCOUNT_ID,
      platform: "instagram",
      platformUserId: "ig-direct-1",
      loginKind: "direct",
      credentialGeneration: 4,
      bindingCredentialId: null,
      bindingConnectionVersion: null,
      credentialRevision: null,
      tokenExpiresAt: Date.parse("2027-01-01T00:00:00.000Z"),
      refreshTokenPresent: true,
      failureCount: 1,
      needsReauth: true,
      isActive: true,
    },
    ...overrides,
  } as MetaRefreshFailureResult;
}

interface Probe {
  capabilityCalls: number;
  beginCalls: number;
  providerCalls: string[];
  writeCalls: Array<Record<string, unknown>>;
  failureCalls: Array<Record<string, unknown>>;
  alertCalls: Array<Record<string, unknown>>;
}

function harness(options: {
  capability?: Record<string, unknown>;
  capabilityThrows?: boolean;
  begin?: MetaRefreshBeginResult;
  beginThrows?: unknown;
  provider?: DirectRefreshProviderOutcome;
  providerThrows?: boolean;
  write?: MetaRefreshDirectWriteResult;
  writeThrows?: unknown;
  failure?: MetaRefreshFailureResult;
  failureThrows?: unknown;
  alert?: ProtectedAlertResult;
} = {}): { deps: ProtectedDirectDeps; probe: Probe } {
  const probe: Probe = {
    capabilityCalls: 0,
    beginCalls: 0,
    providerCalls: [],
    writeCalls: [],
    failureCalls: [],
    alertCalls: [],
  };

  const capabilities: InstagramAccountCapabilityPort = {
    async readCapability() {
      probe.capabilityCalls += 1;
      if (options.capabilityThrows) throw new Error("capability read failed");
      return capability(options.capability ?? {});
    },
  };

  const store: MetaRefreshStore = {
    async beginDirect() {
      probe.beginCalls += 1;
      if (options.beginThrows) throw options.beginThrows;
      return options.begin ?? beginResult();
    },
    async writeDirectSuccess(input) {
      probe.writeCalls.push(input as unknown as Record<string, unknown>);
      if (options.writeThrows) throw options.writeThrows;
      return options.write ?? directWriteResult();
    },
    async recordFailure(input) {
      probe.failureCalls.push(input as unknown as Record<string, unknown>);
      if (options.failureThrows) throw options.failureThrows;
      return options.failure ?? failureResult();
    },
  };

  const transport: MetaRefreshTransport = {
    async refreshDirectToken(input) {
      probe.providerCalls.push(input.capturedToken);
      if (options.providerThrows) throw new Error("transport failed");
      return options.provider ?? {
        kind: "success",
        accessToken: "fresh-token",
        tokenExpiresAt: "2026-10-29T12:14:00.000Z",
        refreshToken: null,
      };
    },
    async sendFailureAlert(input) {
      probe.alertCalls.push(input as unknown as Record<string, unknown>);
      return options.alert ?? { outcome: "accepted", reason: "alert_accepted" };
    },
  };

  return {
    deps: { store, capabilities, transport, now: () => NOW },
    probe,
  };
}

async function run(
  options: Parameters<typeof harness>[0] = {},
  overrides: {
    account?: Partial<ProtectedDirectAccount>;
    trigger?: "scheduled" | "manual";
    bypassCooldown?: boolean;
  } = {},
) {
  const { deps, probe } = harness(options);
  const outcome = await refreshProtectedDirectAccount({
    account: { ...ACCOUNT, ...(overrides.account ?? {}) },
    trigger: overrides.trigger ?? "scheduled",
    bypassCooldown: overrides.bypassCooldown ?? false,
    deps,
  });
  return { outcome, probe };
}

// ---------------------------------------------------------------------------
// The conservative age admission
// ---------------------------------------------------------------------------

Deno.test("the age admission refuses an unproven or a recent authority", () => {
  assertEquals(evaluateAuthorityAge(null, NOW).kind, "unproven");
  assertEquals(evaluateAuthorityAge(undefined, NOW).kind, "unproven");
  assertEquals(evaluateAuthorityAge("not-a-timestamp", NOW).kind, "unproven");
  assertEquals(evaluateAuthorityAge("2026-10-28", NOW).kind, "unproven");
  assertEquals(evaluateAuthorityAge("infinity", NOW).kind, "unproven");
  assertEquals(
    evaluateAuthorityAge(new Date(NOW.getTime() + HOUR_MS).toISOString(), NOW).kind,
    "unproven",
  );

  const justUnder = new Date(NOW.getTime() - PROTECTED_REFRESH_MIN_AUTHORITY_AGE_MS + 1).toISOString();
  const exactly = new Date(NOW.getTime() - PROTECTED_REFRESH_MIN_AUTHORITY_AGE_MS).toISOString();
  const justOver = new Date(NOW.getTime() - PROTECTED_REFRESH_MIN_AUTHORITY_AGE_MS - 1).toISOString();

  assertEquals(evaluateAuthorityAge(justUnder, NOW).kind, "recent");
  assertEquals(evaluateAuthorityAge(exactly, NOW).kind, "eligible");
  assertEquals(evaluateAuthorityAge(justOver, NOW).kind, "eligible");
});

Deno.test("an unproven age defers before any capture, provider call or write", async () => {
  const { outcome, probe } = await run({
    capability: { credentialUpdatedAt: null },
  });
  assertEquals(outcome.kind, "deferred");
  if (outcome.kind !== "deferred") return;
  assertEquals(outcome.reason, PROTECTED_REFRESH_REASONS.tokenAgeUnproven);
  assertEquals(probe.beginCalls, 0);
  assertEquals(probe.providerCalls.length, 0);
  assertEquals(probe.failureCalls.length, 0);
  assertEquals(probe.alertCalls.length, 0);
});

Deno.test("a recent authority defers, and a manual force does not bypass it", async () => {
  const recent = new Date(NOW.getTime() - HOUR_MS).toISOString();
  const { outcome, probe } = await run(
    { capability: { credentialUpdatedAt: recent } },
    { trigger: "manual", bypassCooldown: true },
  );
  assertEquals(outcome.kind, "deferred");
  if (outcome.kind !== "deferred") return;
  assertEquals(outcome.reason, PROTECTED_REFRESH_REASONS.authorityRecent);
  assertEquals(probe.beginCalls, 0);
  assertEquals(probe.providerCalls.length, 0);
});

Deno.test("a health-only change advances the timestamp and delays the next refresh", async () => {
  // A failure advances the generation and the authority timestamp. The next
  // refresh therefore waits for the conservative window again.
  const afterHealthChange = new Date(NOW.getTime() - 60 * 1000).toISOString();
  const { outcome, probe } = await run({
    capability: { credentialUpdatedAt: afterHealthChange, generationReason: "credential_refresh_failed" },
  });
  assertEquals(outcome.kind, "deferred");
  if (outcome.kind !== "deferred") return;
  assertEquals(outcome.reason, PROTECTED_REFRESH_REASONS.authorityRecent);
  assertEquals(probe.beginCalls, 0);
});

// ---------------------------------------------------------------------------
// The cooldown
// ---------------------------------------------------------------------------

Deno.test("the scheduled cooldown is a genuine last attempt guard", async () => {
  const { outcome, probe } = await run({}, {
    account: { lastRefreshAttemptAt: new Date(NOW.getTime() - 60 * 1000).toISOString() },
  });
  assertEquals(outcome.kind, "deferred");
  if (outcome.kind !== "deferred") return;
  assertEquals(outcome.reason, PROTECTED_REFRESH_REASONS.refreshCooldown);
  assertEquals(probe.beginCalls, 0);
});

Deno.test("a manual force bypasses the cooldown", async () => {
  const { outcome, probe } = await run({}, {
    account: { lastRefreshAttemptAt: new Date(NOW.getTime() - 60 * 1000).toISOString() },
    trigger: "manual",
    bypassCooldown: true,
  });
  assertEquals(outcome.kind, "refreshed");
  assertEquals(probe.beginCalls, 1);
});

Deno.test("a malformed attempt marker does not block", () => {
  assertEquals(isWithinProtectedRefreshCooldown(null, NOW), false);
  assertEquals(isWithinProtectedRefreshCooldown("not-a-timestamp", NOW), false);
  assertEquals(
    isWithinProtectedRefreshCooldown(new Date(NOW.getTime() - 60_000).toISOString(), NOW),
    true,
  );
  assertEquals(
    isWithinProtectedRefreshCooldown(new Date(NOW.getTime() - 10 * 60_000).toISOString(), NOW),
    false,
  );
});

// ---------------------------------------------------------------------------
// The unsupported branches
// ---------------------------------------------------------------------------

Deno.test("a page-linked account is refused before any capture", async () => {
  const { outcome, probe } = await run({
    capability: { loginKind: "page_linked" },
  });
  assertEquals(outcome.kind, "unsupported");
  assertEquals(probe.beginCalls, 0);
  assertEquals(probe.providerCalls.length, 0);
  assertEquals(probe.writeCalls.length, 0);
  assertEquals(probe.failureCalls.length, 0);
});

Deno.test("an account without a capability row is refused before any capture", async () => {
  const { outcome, probe } = await run({
    capability: { capabilityPresent: false, loginKind: null },
  });
  assertEquals(outcome.kind, "unsupported");
  assertEquals(probe.beginCalls, 0);
});

Deno.test("a facebook account never reaches the direct branch", async () => {
  const { outcome, probe } = await run({}, {
    account: { platform: "facebook" },
  });
  assertEquals(outcome.kind, "unsupported");
  assertEquals(probe.capabilityCalls, 0);
  assertEquals(probe.beginCalls, 0);
});

Deno.test("a failed capability read fails closed", async () => {
  const { outcome, probe } = await run({ capabilityThrows: true });
  assertEquals(outcome.kind, "local_failure");
  if (outcome.kind !== "local_failure") return;
  assertEquals(outcome.reason, PROTECTED_REFRESH_REASONS.capabilityReadFailed);
  assertEquals(probe.beginCalls, 0);
  assertEquals(probe.providerCalls.length, 0);
});

// ---------------------------------------------------------------------------
// The capture
// ---------------------------------------------------------------------------

Deno.test("a moved generation stops the attempt before the provider", async () => {
  const moved = beginResult();
  moved.capture.targets[0].capabilityGeneration = 4;
  const { outcome, probe } = await run({ begin: moved });
  assertEquals(outcome.kind, "local_failure");
  if (outcome.kind !== "local_failure") return;
  assertEquals(outcome.reason, PROTECTED_REFRESH_REASONS.captureContextMismatch);
  assertEquals(probe.providerCalls.length, 0);
  assertEquals(probe.failureCalls.length, 0);
  assertEquals(probe.alertCalls.length, 0);
});

Deno.test("a capture of another account stops the attempt before the provider", async () => {
  const other = beginResult();
  other.capture.targets[0].socialAccountId = "0f1a0009-0000-4000-8000-000000000019";
  other.tokens[0].socialAccountId = "0f1a0009-0000-4000-8000-000000000019";
  const { outcome, probe } = await run({ begin: other });
  assertEquals(outcome.kind, "local_failure");
  assertEquals(probe.providerCalls.length, 0);
});

Deno.test("only the captured token reaches the provider", async () => {
  const { outcome, probe } = await run();
  assertEquals(outcome.kind, "refreshed");
  assertEquals(probe.providerCalls, ["captured-direct-token"]);
});

// ---------------------------------------------------------------------------
// The commit
// ---------------------------------------------------------------------------

Deno.test("a success consumes the capture with the direct writer only", async () => {
  const { outcome, probe } = await run();
  assertEquals(outcome.kind, "refreshed");
  assertEquals(probe.writeCalls.length, 1);
  assertEquals(probe.failureCalls.length, 0);
  assertEquals(probe.alertCalls.length, 0);
  assertEquals(probe.writeCalls[0].captureId, CAPTURE_ID);
  assertEquals(probe.writeCalls[0].accessToken, "fresh-token");
  assertEquals(probe.writeCalls[0].tokenExpiresAt, "2026-10-29T12:14:00.000Z");
});

Deno.test("a provider refresh token is only sent when the provider returned one", async () => {
  const withoutToken = await run({
    provider: {
      kind: "success",
      accessToken: "fresh-token",
      tokenExpiresAt: "2026-10-29T12:14:00.000Z",
      refreshToken: null,
    },
  });
  assertEquals(Object.hasOwn(withoutToken.probe.writeCalls[0], "refreshToken"), false);

  const withToken = await run({
    provider: {
      kind: "success",
      accessToken: "fresh-token",
      tokenExpiresAt: "2026-10-29T12:14:00.000Z",
      refreshToken: "provider-refresh",
    },
  });
  assertEquals(withToken.probe.writeCalls[0].refreshToken, "provider-refresh");
});

Deno.test("a classified provider failure is consumed exactly once", async () => {
  const { outcome, probe } = await run({
    provider: { kind: "classified_failure", category: "provider_invalid_grant" },
  });
  assertEquals(outcome.kind, "committed_failure");
  if (outcome.kind !== "committed_failure") return;
  assertEquals(outcome.category, "provider_invalid_grant");
  assertEquals(probe.failureCalls.length, 1);
  assertEquals(probe.failureCalls[0].captureId, CAPTURE_ID);
  assertEquals(probe.failureCalls[0].socialAccountId, ACCOUNT_ID);
  assertEquals(probe.failureCalls[0].errorCategory, "provider_invalid_grant");
  assertEquals(probe.writeCalls.length, 0);
  assertEquals(probe.alertCalls.length, 1);
});

Deno.test("a failure without an alert marker sends no notification", async () => {
  const { outcome, probe } = await run({
    provider: { kind: "classified_failure", category: "provider_transient" },
    failure: failureResult({
      errorCategory: "provider_transient",
      escalated: false,
      alertMarkerWritten: false,
      transitioned: false,
      enqueued: 0,
      failureCount: 0,
      account: {
        ...failureResult().account,
        failureCount: 0,
        needsReauth: false,
      },
    }),
  });
  assertEquals(outcome.kind, "committed_failure");
  assertEquals(probe.alertCalls.length, 0);
});

Deno.test("the notification carries the committed counter, not a prediction", async () => {
  const { probe } = await run({
    provider: { kind: "classified_failure", category: "provider_permission_denied" },
    failure: failureResult({
      errorCategory: "provider_permission_denied",
      escalated: false,
      alertMarkerWritten: true,
      transitioned: false,
      enqueued: 0,
      failureCount: 2,
      account: {
        ...failureResult().account,
        failureCount: 2,
      },
    }),
  });
  assertEquals(probe.alertCalls.length, 1);
  assertEquals(probe.alertCalls[0].failureCount, 2);
  assertEquals(probe.alertCalls[0].needsReauth, true);
  assertEquals(probe.alertCalls[0].errorCategory, "provider_permission_denied");
});

Deno.test("an unclassifiable provider failure keeps the capture and changes nothing", async () => {
  const { outcome, probe } = await run({
    provider: { kind: "unclassified_failure" },
  });
  assertEquals(outcome.kind, "deferred");
  if (outcome.kind !== "deferred") return;
  assertEquals(outcome.reason, PROTECTED_REFRESH_REASONS.providerUnclassified);
  assertEquals(probe.failureCalls.length, 0);
  assertEquals(probe.writeCalls.length, 0);
  assertEquals(probe.alertCalls.length, 0);
});

Deno.test("a thrown success writer is indeterminate, never a second consume", async () => {
  const { outcome, probe } = await run({ writeThrows: new Error("connection reset") });
  assertEquals(outcome.kind, "indeterminate");
  assertEquals(probe.failureCalls.length, 0);
  assertEquals(probe.alertCalls.length, 0);
});

Deno.test("a thrown failure writer is indeterminate and never consumes twice", async () => {
  const { outcome, probe } = await run({
    provider: { kind: "classified_failure", category: "provider_invalid_grant" },
    failureThrows: new Error("connection reset"),
  });
  assertEquals(outcome.kind, "indeterminate");
  assertEquals(probe.failureCalls.length, 1);
  assertEquals(probe.alertCalls.length, 0);
});

Deno.test("a refused success writer is a refusal, not an indeterminate outcome", async () => {
  const { MetaRefreshStoreError } = await import("./metaRefreshStore.ts");
  const { outcome, probe } = await run({
    writeThrows: new MetaRefreshStoreError("stale", "stale capture", "MAR04"),
  });
  assertEquals(outcome.kind, "local_failure");
  if (outcome.kind !== "local_failure") return;
  assertEquals(outcome.reason, "refresh_stale_capture");
  assertEquals(probe.failureCalls.length, 0);
});

Deno.test("a success that clears needs_reauth is refused", async () => {
  const write = directWriteResult();
  write.account.needsReauth = false;
  const begin = beginResult();
  begin.capture.targets[0].needsReauth = true;
  const { outcome } = await run({ begin, write });
  assertEquals(outcome.kind, "indeterminate");
});

Deno.test("a committed failure that does not describe the account is refused", async () => {
  const failure = failureResult();
  failure.account.socialAccountId = "0f1a0009-0000-4000-8000-000000000019";
  const { outcome, probe } = await run({
    provider: { kind: "classified_failure", category: "provider_invalid_grant" },
    failure,
  });
  assertEquals(outcome.kind, "indeterminate");
  assertEquals(probe.alertCalls.length, 0);
});

Deno.test("a failed notification never repeats the failure write", async () => {
  const { outcome, probe } = await run({
    provider: { kind: "classified_failure", category: "provider_invalid_grant" },
    alert: { outcome: "not_attempted", reason: "alert_delivery_failed" },
  });
  assertEquals(outcome.kind, "committed_failure");
  assertEquals(probe.failureCalls.length, 1);
  assertEquals(probe.alertCalls.length, 1);
  if (outcome.kind !== "committed_failure") return;
  assertEquals(outcome.alert?.outcome, "not_attempted");
});

Deno.test("a success receipt that is not this direct account is indeterminate", async () => {
  const cases: Array<(write: MetaRefreshDirectWriteResult) => void> = [
    (write) => {
      if (write.account.found) write.account.platformUserId = "different-provider-identity";
    },
    (write) => {
      if (write.account.found) write.account.isActive = false;
    },
    (write) => {
      write.credentialGeneration = 6;
      if (write.account.found) write.account.credentialGeneration = 6;
    },
    (write) => {
      if (write.account.found) {
        write.account.tokenExpiresAt = Date.parse("2030-01-01T00:00:00.000Z");
      }
    },
    (write) => {
      if (write.account.found) write.account.needsReauth = true;
    },
  ];
  for (const mutate of cases) {
    const write = directWriteResult();
    mutate(write);
    const { outcome, probe } = await run({ write });
    assertEquals(outcome.kind, "indeterminate");
    assertEquals(probe.writeCalls.length, 1);
    assertEquals(probe.failureCalls.length, 0);
    assertEquals(probe.alertCalls.length, 0);
  }
});

Deno.test("a failure that sets needs_reauth stays a committed failure", async () => {
  const { outcome, probe } = await run({
    provider: { kind: "classified_failure", category: "provider_invalid_grant" },
  });
  assertEquals(outcome.kind, "committed_failure");
  if (outcome.kind !== "committed_failure") return;
  assertEquals(outcome.needsReauth, true);
  assertEquals(probe.failureCalls.length, 1);
  assertEquals(probe.alertCalls.length, 1);
});

Deno.test("a failure that clears needs_reauth does not alert", async () => {
  const begin = beginResult();
  begin.capture.targets[0].needsReauth = true;
  const failure = failureResult();
  if (failure.account.found) failure.account.needsReauth = false;
  const { outcome, probe } = await run({
    begin,
    provider: { kind: "classified_failure", category: "provider_invalid_grant" },
    failure,
  });
  assertEquals(outcome.kind, "indeterminate");
  assertEquals(probe.failureCalls.length, 1);
  assertEquals(probe.alertCalls.length, 0);
});

Deno.test("a failure whose counter disagrees with the account does not alert", async () => {
  const failure = failureResult();
  failure.failureCount = 9;
  const { outcome, probe } = await run({
    provider: { kind: "classified_failure", category: "provider_invalid_grant" },
    failure,
  });
  assertEquals(outcome.kind, "indeterminate");
  assertEquals(probe.failureCalls.length, 1);
  assertEquals(probe.alertCalls.length, 0);
});
