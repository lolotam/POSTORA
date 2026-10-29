import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertDirectCaptureAgrees,
  createMetaRefreshStore,
  isIndeterminateStoreOutcome,
  isMetaRefreshStoreError,
  META_REFRESH_ERROR_CATEGORIES,
  MetaRefreshStoreError,
  parseMetaRefreshBeginResult,
  parseMetaRefreshDirectWriteResult,
  parseMetaRefreshFailureResult,
  readFiniteTimestamp,
  type MetaRefreshStore,
} from "./metaRefreshStore.ts";

// ---------------------------------------------------------------------------
// Fixtures.
//
// These are the real shapes the accepted SQL returns. They were captured from
// an unmodified `begin_meta_account_refresh`, `write_direct_instagram_account`
// and `record_meta_refresh_failure` running against the accepted migration,
// not written by hand for this suite.
// ---------------------------------------------------------------------------

const OWNER_ID = "0f100001-0000-4000-8000-000000000001";
const ACCOUNT_ID = "0f1a0001-0000-4000-8000-000000000011";
const CAPTURE_ID = "726f97c3-305f-4674-a89d-79c4463b506a";
const CAPTURED_AT = "2026-10-28T12:13:38.574526+00:00";
const EXPIRES_AT = "2026-10-28T12:43:38.574526+00:00";

const CAPTURED_TOKEN = "direct-token-1";

function beginWire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tokens: [
      {
        scope: "account",
        token: CAPTURED_TOKEN,
        credential_id: null,
        refresh_token: "direct-refresh-1",
        token_expires_at: "2027-01-01T00:00:00+00:00",
        social_account_id: ACCOUNT_ID,
        credential_revision: null,
      },
    ],
    capture: {
      members: null,
      targets: [
        {
          platform: "instagram",
          fence_state: "never_created",
          needs_reauth: false,
          failure_count: 0,
          binding_present: false,
          platform_user_id: "ig-direct-1",
          provider_user_id: null,
          token_expires_at: "2027-01-01T00:00:00+00:00",
          social_account_id: ACCOUNT_ID,
          capability_present: true,
          credential_revision: null,
          binding_credential_id: null,
          capability_generation: 3,
          capability_login_kind: "direct",
          refresh_token_present: true,
          last_refresh_attempt_at: CAPTURED_AT,
          fence_connection_version: 0,
          binding_connection_version: null,
          capability_permission_read_state: "unknown",
        },
      ],
      user_id: OWNER_ID,
      operation: "direct_token",
      credential: null,
      expires_at: EXPIRES_AT,
      captured_at: CAPTURED_AT,
      capture_version: 1,
    },
    operation: "direct_token",
    capture_id: CAPTURE_ID,
    expires_at: EXPIRES_AT,
    captured_at: CAPTURED_AT,
    attempt_marker: CAPTURED_AT,
    capture_version: 1,
    ...overrides,
  };
}

function directWriteWire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    account: {
      found: true,
      platform: "instagram",
      is_active: true,
      login_kind: "direct",
      needs_reauth: false,
      failure_count: 0,
      platform_user_id: "ig-direct-1",
      token_expires_at: "2026-10-28T13:13:38.578591+00:00",
      social_account_id: ACCOUNT_ID,
      credential_revision: null,
      binding_credential_id: null,
      credential_generation: 4,
      refresh_token_present: true,
      binding_connection_version: null,
    },
    applied: true,
    operation: "direct_token",
    capture_id: CAPTURE_ID,
    credential_generation: 4,
    ...overrides,
  };
}

function failureWire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    account: {
      found: true,
      platform: "instagram",
      is_active: true,
      login_kind: "direct",
      needs_reauth: true,
      failure_count: 1,
      platform_user_id: "ig-direct-1",
      token_expires_at: "2027-01-01T00:00:00+00:00",
      social_account_id: ACCOUNT_ID,
      credential_revision: null,
      binding_credential_id: null,
      credential_generation: 4,
      refresh_token_present: true,
      binding_connection_version: null,
    },
    applied: true,
    enqueued: 1,
    escalated: true,
    capture_id: CAPTURE_ID,
    transitioned: true,
    account_found: true,
    failure_count: 1,
    error_category: "provider_auth_revoked",
    alert_marker_written: true,
    ...overrides,
  };
}

function expectation(overrides: Record<string, unknown> = {}) {
  return {
    userId: OWNER_ID,
    socialAccountId: ACCOUNT_ID,
    platform: "instagram",
    platformUserId: "ig-direct-1",
    expectedCapabilityGeneration: 3,
    now: new Date("2026-10-28T12:14:00.000Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

Deno.test("the real begin wire parses into the captured shape", () => {
  const parsed = parseMetaRefreshBeginResult("begin_meta_account_refresh", beginWire());
  assertEquals(parsed.captureId, CAPTURE_ID);
  assertEquals(parsed.captureVersion, 1);
  assertEquals(parsed.operation, "direct_token");
  assertEquals(parsed.tokens.length, 1);
  assertEquals(parsed.tokens[0].token, CAPTURED_TOKEN);
  assertEquals(parsed.tokens[0].refreshToken, "direct-refresh-1");
  assertEquals(parsed.capture.targets.length, 1);
  assertEquals(parsed.capture.targets[0].capabilityLoginKind, "direct");
  assertEquals(parsed.capture.targets[0].bindingPresent, false);
  assertEquals(parsed.capture.targets[0].capabilityGeneration, 3);
  assertEquals(parsed.capture.credential, null);
  assertEquals(parsed.capture.members, null);
});

Deno.test("the real direct write and failure wires parse into the committed shape", () => {
  const write = parseMetaRefreshDirectWriteResult("write_direct_instagram_account", directWriteWire());
  assertEquals(write.applied, true);
  assertEquals(write.operation, "direct_token");
  assertEquals(write.credentialGeneration, 4);
  assertEquals(write.account.found, true);
  assertEquals(write.account.needsReauth, false);

  const failure = parseMetaRefreshFailureResult("record_meta_refresh_failure", failureWire());
  assertEquals(failure.applied, true);
  assertEquals(failure.errorCategory, "provider_auth_revoked");
  assertEquals(failure.failureCount, 1);
  assertEquals(failure.escalated, true);
  assertEquals(failure.alertMarkerWritten, true);
  assertEquals(failure.transitioned, true);
  assertEquals(failure.enqueued, 1);
  assertEquals(failure.accountFound, true);
  assertEquals(failure.account.needsReauth, true);
});

Deno.test("a raw envelope without an own error is not a success", async () => {
  const inherited = Object.create({ error: { message: "leaked" } }) as Record<string, unknown>;
  inherited.data = beginWire();
  inherited.error = null;

  const missingError = { data: beginWire() } as Record<string, unknown>;
  const undefinedError = { data: beginWire(), error: undefined } as Record<string, unknown>;
  const nullData = { data: null, error: null } as Record<string, unknown>;
  const inheritedError = { data: beginWire(), error: { message: "boom" } } as Record<string, unknown>;

  for (const envelope of [inherited, missingError, undefinedError, nullData, inheritedError]) {
    const store = createMetaRefreshStore(async () => envelope);
    let thrown: unknown = null;
    try {
      await store.beginDirect({
        userId: OWNER_ID,
        socialAccountId: ACCOUNT_ID,
      });
    } catch (error) {
      thrown = error;
    }
    assertEquals(thrown instanceof MetaRefreshStoreError, true);
  }
});

Deno.test("the store refuses a payload it cannot prove", async () => {
  const store = createMetaRefreshStore(async (name) => {
    if (name === "begin_meta_account_refresh") {
      return { data: beginWire({ capture_version: 2 }), error: null };
    }
    return { data: null, error: null };
  });
  let thrown: unknown = null;
  try {
    await store.beginDirect({ userId: OWNER_ID, socialAccountId: ACCOUNT_ID });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof MetaRefreshStoreError, true);
  assertEquals(isMetaRefreshStoreError(thrown) && thrown.code, "invalid_contract");
});

Deno.test("a driver error is classified without keeping the driver text", async () => {
  const cases: Array<[string, string]> = [
    ["MAR01", "invalid_payload"],
    ["MAR02", "refused"],
    ["MAR03", "refused"],
    ["MAR04", "stale"],
    ["MAR05", "contended"],
    ["MAR06", "refused"],
    ["MAR07", "expired"],
    ["57014", "cancelled"],
    ["P0001", "refused"],
    ["PGRST202", "schema_unavailable"],
  ];
  for (const [sqlstate, expected] of cases) {
    const store = createMetaRefreshStore(async () => ({
      data: null,
      error: { message: "secret token leaked in the driver message", code: sqlstate },
    }));
    let thrown: unknown = null;
    try {
      await store.beginDirect({ userId: OWNER_ID, socialAccountId: ACCOUNT_ID });
    } catch (error) {
      thrown = error;
    }
    assertEquals(thrown instanceof MetaRefreshStoreError, true);
    if (!isMetaRefreshStoreError(thrown)) continue;
    assertEquals(thrown.code, expected);
    assertEquals(thrown.message.includes("secret token leaked"), false);
    assertEquals(thrown.sqlstate, sqlstate);
  }
});

Deno.test("an unknown SQLSTATE is a read failure, not a refusal", async () => {
  const store = createMetaRefreshStore(async () => ({
    data: null,
    error: { message: "connection reset", code: "08006" },
  }));
  let thrown: unknown = null;
  try {
    await store.beginDirect({ userId: OWNER_ID, socialAccountId: ACCOUNT_ID });
  } catch (error) {
    thrown = error;
  }
  assertEquals(isMetaRefreshStoreError(thrown) && thrown.code, "read_failed");
  assertEquals(
    isMetaRefreshStoreError(thrown) && isIndeterminateStoreOutcome(thrown),
    true,
  );
});

Deno.test("the store sends the exact accepted payloads", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const store = createMetaRefreshStore(async (name, args) => {
    calls.push({ name, args });
    if (name === "begin_meta_account_refresh") return { data: beginWire(), error: null };
    if (name === "write_direct_instagram_account") return { data: directWriteWire(), error: null };
    return { data: failureWire(), error: null };
  });

  await store.beginDirect({ userId: OWNER_ID, socialAccountId: ACCOUNT_ID });
  await store.writeDirectSuccess({
    userId: OWNER_ID,
    captureId: CAPTURE_ID,
    accessToken: "fresh-token",
    tokenExpiresAt: "2026-10-28T13:13:38.578591Z",
  });
  await store.recordFailure({
    userId: OWNER_ID,
    captureId: CAPTURE_ID,
    socialAccountId: ACCOUNT_ID,
    errorCategory: "provider_transient",
  });

  assertEquals(calls[0].name, "begin_meta_account_refresh");
  assertEquals(calls[0].args.p_user_id, OWNER_ID);
  assertEquals(calls[0].args.p_payload, {
    accounts: [{ social_account_id: ACCOUNT_ID, operation: "direct_token" }],
  });

  assertEquals(calls[1].name, "write_direct_instagram_account");
  assertEquals(calls[1].args.p_payload, {
    capture_id: CAPTURE_ID,
    operation: "direct_token",
    fields: {
      access_token: "fresh-token",
      token_expires_at: "2026-10-28T13:13:38.578591Z",
    },
  });

  assertEquals(calls[2].name, "record_meta_refresh_failure");
  assertEquals(calls[2].args.p_payload, {
    capture_id: CAPTURE_ID,
    social_account_id: ACCOUNT_ID,
    error_category: "provider_transient",
  });
});

Deno.test("an explicit refresh token is sent and an omitted one is not", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const store = createMetaRefreshStore(async (name, args) => {
    calls.push(args.p_payload as Record<string, unknown>);
    return { data: directWriteWire(), error: null };
  });

  await store.writeDirectSuccess({
    userId: OWNER_ID,
    captureId: CAPTURE_ID,
    accessToken: "fresh-token",
    tokenExpiresAt: "2026-10-28T13:13:38.578591Z",
  });
  await store.writeDirectSuccess({
    userId: OWNER_ID,
    captureId: CAPTURE_ID,
    accessToken: "fresh-token",
    tokenExpiresAt: "2026-10-28T13:13:38.578591Z",
    refreshToken: "provider-refresh-token",
  });

  const firstFields = (calls[0].fields as Record<string, unknown>);
  assertEquals(Object.hasOwn(firstFields, "refresh_token"), false);
  const secondFields = (calls[1].fields as Record<string, unknown>);
  assertEquals(secondFields.refresh_token, "provider-refresh-token");
});

Deno.test("the capture must agree with the request that produced it", () => {
  const parsed = parseMetaRefreshBeginResult("begin_meta_account_refresh", beginWire());
  assertDirectCaptureAgrees(parsed, expectation());

  const wrongOwner = { ...expectation(), userId: "0f100009-0000-4000-8000-000000000009" };
  assertThrows(() => assertDirectCaptureAgrees(parsed, wrongOwner));

  const wrongAccount = { ...expectation(), socialAccountId: "0f1a0009-0000-4000-8000-000000000019" };
  assertThrows(() => assertDirectCaptureAgrees(parsed, wrongAccount));

  const wrongGeneration = { ...expectation(), expectedCapabilityGeneration: 4 };
  assertThrows(() => assertDirectCaptureAgrees(parsed, wrongGeneration));

  const wrongIdentity = { ...expectation(), platformUserId: "ig-other" };
  assertThrows(() => assertDirectCaptureAgrees(parsed, wrongIdentity));

  const expired = { ...expectation(), now: new Date("2026-10-28T12:44:00.000Z") };
  assertThrows(() => assertDirectCaptureAgrees(parsed, expired));
});

Deno.test("a capture of another operation is refused", () => {
  const pageWire = beginWire();
  (pageWire.capture as Record<string, unknown>).operation = "page_token";
  pageWire.operation = "page_token";
  const parsed = parseMetaRefreshBeginResult("begin_meta_account_refresh", pageWire);
  assertThrows(() => assertDirectCaptureAgrees(parsed, expectation()));
});

Deno.test("a page-linked capture is refused", () => {
  const pageWire = beginWire();
  const target = (pageWire.capture as Record<string, unknown>).targets as Array<
    Record<string, unknown>
  >;
  target[0].capability_login_kind = "page_linked";
  target[0].binding_present = true;
  const parsed = parseMetaRefreshBeginResult("begin_meta_account_refresh", pageWire);
  assertThrows(() => assertDirectCaptureAgrees(parsed, expectation()));
});

Deno.test("a shared user capture is refused", () => {
  const userWire = beginWire();
  userWire.operation = "facebook_user_token";
  (userWire.capture as Record<string, unknown>).operation = "facebook_user_token";
  userWire.tokens = [
    {
      scope: "credential",
      token: "user-secret",
      credential_id: "0f1c0001-0000-4000-8000-000000000031",
      credential_revision: 1,
      refresh_token: null,
      token_expires_at: "2027-02-01T00:00:00+00:00",
      social_account_id: null,
    },
  ];
  const parsed = parseMetaRefreshBeginResult("begin_meta_account_refresh", userWire);
  assertThrows(() => assertDirectCaptureAgrees(parsed, expectation()));
});

Deno.test("a capture with two targets or two tokens is refused", () => {
  const twoTargets = beginWire();
  const targets = (twoTargets.capture as Record<string, unknown>).targets as Array<
    Record<string, unknown>
  >;
  targets.push({ ...targets[0] });
  const parsedTargets = parseMetaRefreshBeginResult(
    "begin_meta_account_refresh",
    twoTargets,
  );
  assertThrows(() => assertDirectCaptureAgrees(parsedTargets, expectation()));

  const twoTokens = beginWire();
  const tokens = twoTokens.tokens as Array<Record<string, unknown>>;
  tokens.push({ ...tokens[0] });
  const parsedTokens = parseMetaRefreshBeginResult(
    "begin_meta_account_refresh",
    twoTokens,
  );
  assertThrows(() => assertDirectCaptureAgrees(parsedTokens, expectation()));
});

Deno.test("a token with a credential scope is refused", () => {
  const scoped = beginWire();
  (scoped.tokens as Array<Record<string, unknown>>)[0].scope = "credential";
  (scoped.tokens as Array<Record<string, unknown>>)[0].credential_id =
    "0f1c0001-0000-4000-8000-000000000031";
  const parsed = parseMetaRefreshBeginResult("begin_meta_account_refresh", scoped);
  assertThrows(() => assertDirectCaptureAgrees(parsed, expectation()));
});

Deno.test("a malformed timestamp is not a timestamp", () => {
  assertEquals(readFiniteTimestamp("2026-10-28T12:13:38.574526+00:00") !== null, true);
  assertEquals(readFiniteTimestamp("2026-10-28T12:13:38.574526Z") !== null, true);
  assertEquals(readFiniteTimestamp("2026-10-28T12:13:38"), null);
  assertEquals(readFiniteTimestamp("2026-10-28"), null);
  assertEquals(readFiniteTimestamp("infinity"), null);
  assertEquals(readFiniteTimestamp(""), null);
  assertEquals(readFiniteTimestamp(null), null);
  assertEquals(readFiniteTimestamp(undefined), null);
  assertEquals(readFiniteTimestamp(1234), null);
});

Deno.test("a malformed account state is refused", () => {
  assertThrows(() =>
    parseMetaRefreshDirectWriteResult(
      "write_direct_instagram_account",
      directWriteWire({ applied: false }),
    )
  );
  assertThrows(() =>
    parseMetaRefreshDirectWriteResult(
      "write_direct_instagram_account",
      directWriteWire({ operation: "facebook_user_token" }),
    )
  );
  assertThrows(() =>
    parseMetaRefreshDirectWriteResult(
      "write_direct_instagram_account",
      directWriteWire({ credential_generation: "four" }),
    )
  );
  assertThrows(() =>
    parseMetaRefreshFailureResult(
      "record_meta_refresh_failure",
      failureWire({ error_category: "invented_category" }),
    )
  );
  assertThrows(() =>
    parseMetaRefreshFailureResult(
      "record_meta_refresh_failure",
      failureWire({ alert_marker_written: "yes" }),
    )
  );
});

Deno.test("the accepted category vocabulary is closed", () => {
  assertEquals(META_REFRESH_ERROR_CATEGORIES.length, 11);
  for (const category of META_REFRESH_ERROR_CATEGORIES) {
    const wire = failureWire({ error_category: category });
    const parsed = parseMetaRefreshFailureResult("record_meta_refresh_failure", wire);
    assertEquals(parsed.errorCategory, category);
  }
});

Deno.test("the store never keeps a captured token beyond the capture", async () => {
  const store: MetaRefreshStore = createMetaRefreshStore(async () => ({
    data: beginWire(),
    error: null,
  }));
  const begin = await store.beginDirect({
    userId: OWNER_ID,
    socialAccountId: ACCOUNT_ID,
  });
  // The token is reachable only through the capture result. It is a plain
  // string, so the only way to lose it is to stop holding the result.
  assertEquals(begin.tokens[0].token, CAPTURED_TOKEN);
  assertEquals(JSON.stringify(begin.capture).includes(CAPTURED_TOKEN), false);
});

Deno.test("a missing nullable column is not an explicit null", () => {
  const missingBinding = directWriteWire();
  delete (missingBinding.account as Record<string, unknown>).binding_credential_id;
  assertThrows(() =>
    parseMetaRefreshDirectWriteResult("write_direct_instagram_account", missingBinding)
  );

  const missingIdentity = directWriteWire();
  delete (missingIdentity.account as Record<string, unknown>).platform_user_id;
  assertThrows(() =>
    parseMetaRefreshDirectWriteResult("write_direct_instagram_account", missingIdentity)
  );

  const explicitNull = directWriteWire();
  (explicitNull.account as Record<string, unknown>).platform_user_id = null;
  (explicitNull.account as Record<string, unknown>).binding_credential_id = null;
  const parsed = parseMetaRefreshDirectWriteResult(
    "write_direct_instagram_account",
    explicitNull,
  );
  assertEquals(parsed.account.found, true);
  if (!parsed.account.found) return;
  assertEquals(parsed.account.platformUserId, null);
  assertEquals(parsed.account.bindingCredentialId, null);
});

Deno.test("a direct capture with contradictory binding material is refused", () => {
  const binding = beginWire();
  const target = ((binding.capture as Record<string, unknown>).targets as Array<
    Record<string, unknown>
  >)[0];
  target.binding_credential_id = "0f1c0001-0000-4000-8000-000000000031";
  assertThrows(() =>
    assertDirectCaptureAgrees(
      parseMetaRefreshBeginResult("begin_meta_account_refresh", binding),
      expectation(),
    )
  );

  const credential = beginWire();
  (credential.capture as Record<string, unknown>).credential = { credential_id: "x" };
  assertThrows(() =>
    assertDirectCaptureAgrees(
      parseMetaRefreshBeginResult("begin_meta_account_refresh", credential),
      expectation(),
    )
  );

  const members = beginWire();
  (members.capture as Record<string, unknown>).members = [{ social_account_id: ACCOUNT_ID }];
  assertThrows(() =>
    assertDirectCaptureAgrees(
      parseMetaRefreshBeginResult("begin_meta_account_refresh", members),
      expectation(),
    )
  );
});

Deno.test("a capture that omits members or credential is malformed", () => {
  const missingMembers = beginWire();
  delete (missingMembers.capture as Record<string, unknown>).members;
  assertThrows(() => parseMetaRefreshBeginResult("begin_meta_account_refresh", missingMembers));

  const missingCredential = beginWire();
  delete (missingCredential.capture as Record<string, unknown>).credential;
  assertThrows(() =>
    parseMetaRefreshBeginResult("begin_meta_account_refresh", missingCredential)
  );
});
