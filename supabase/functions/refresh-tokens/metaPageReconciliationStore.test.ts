import { assert, assertEquals, assertRejects, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createMetaPageReconciliationStore,
  isIndeterminatePageOutcome,
  isMetaPageReconciliationError,
  parseMetaPageBeginResult,
  parseMetaPageProtectedBinding,
  parseMetaPageWriteResult,
  type MetaPageReconciliationStore,
  type ProtectedBindingReader,
} from "./metaPageReconciliationStore.ts";

// ---------------------------------------------------------------------------
// Fixtures.
//
// These are the REAL shapes the accepted SQL returns. They were captured from
// an unmodified `begin_meta_account_refresh` and
// `write_meta_page_reconciliation_success` running against the accepted
// migration, not written by hand for this suite.
// ---------------------------------------------------------------------------

const OWNER_ID = "0f100001-0000-4000-8000-000000000001";
const OTHER_OWNER_ID = "0f100002-0000-4000-8000-000000000002";
const ACCOUNT_ID = "0f1a0002-0000-4000-8000-000000000012";
const SIBLING_ID = "0f1a0003-0000-4000-8000-000000000013";
const CAPTURE_ID = "726f97c3-305f-4674-a89d-79c4463b506a";
const CREDENTIAL_ID = "9a2c0001-0000-4000-8000-000000000021";
const CAPTURED_AT = "2026-10-28T12:13:38.574526+00:00";
const EXPIRES_AT = "2026-10-28T12:43:38.574526+00:00";
const GRANT_EXPIRY = "2026-12-01T00:00:00+00:00";
const CAPTURED_USER_TOKEN = "captured-user-secret-must-not-leak";
const DERIVED_PAGE_TOKEN = "derived-page-token-must-not-leak";
const PROVIDER_USER_ID = "fb-user-9001";
const PAGE_ID = "page-7001";
const INSTAGRAM_ID = "ig-page-7001";

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

function pageMember(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    social_account_id: ACCOUNT_ID,
    platform: "instagram",
    connection_version: 4,
    capability_generation: 11,
    fence_connection_version: 4,
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
      members: [pageMember()],
      targets: [pageTarget()],
    },
    tokens: [
      {
        scope: "credential",
        social_account_id: null,
        credential_id: CREDENTIAL_ID,
        credential_revision: 7,
        token: CAPTURED_USER_TOKEN,
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

interface RpcCall {
  name: string;
  args: Record<string, unknown>;
}

function rpcReturning(
  results: Record<string, unknown>,
  calls: RpcCall[] = [],
): (name: string, args: Record<string, unknown>) => Promise<unknown> {
  return async (name, args) => {
    calls.push({ name, args });
    return { data: results[name], error: null };
  };
}

function storeWith(
  rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  binding: ProtectedBindingReader = async () => ({ data: bindingRow(), error: null }),
): MetaPageReconciliationStore {
  return createMetaPageReconciliationStore(rpc, binding);
}

// ---------------------------------------------------------------------------
// The capture contract
// ---------------------------------------------------------------------------

Deno.test("a captured Page capture is parsed into its strict shape", async () => {
  const capture = parseMetaPageBeginResult(beginWire());
  assertEquals(capture.operation, "facebook_user_token");
  assertEquals(capture.userId, OWNER_ID);
  assertEquals(capture.target.socialAccountId, ACCOUNT_ID);
  assertEquals(capture.credential.credentialId, CREDENTIAL_ID);
  assertEquals(capture.credential.revision, 7);
  assertEquals(capture.credential.providerUserId, PROVIDER_USER_ID);
  assertEquals(capture.credential.tokenExpiresAt, Date.parse(GRANT_EXPIRY));
  assertEquals(capture.userToken, CAPTURED_USER_TOKEN);
  assertEquals(capture.userTokenExpiresAt, Date.parse(GRANT_EXPIRY));
  assertEquals(capture.members.length, 1);
  assertEquals(capture.members[0].socialAccountId, ACCOUNT_ID);
});

Deno.test("a capture with a wrong operation is refused", async () => {
  await assertRejects(async () =>
    parseMetaPageBeginResult(beginWire({ operation: "direct_token" }))
  );
  await assertRejects(async () => {
    const wire = beginWire();
    (wire.capture as Record<string, unknown>).operation = "direct_token";
    return parseMetaPageBeginResult(wire);
  });
});

Deno.test("a capture with more than one target or one token is refused", async () => {
  const twoTargets = beginWire();
  const capture = twoTargets.capture as Record<string, unknown>;
  capture.targets = [pageTarget(), pageTarget({ social_account_id: SIBLING_ID })];
  await assertRejects(async () => Promise.resolve(parseMetaPageBeginResult(twoTargets)));

  const twoTokens = beginWire();
  twoTokens.tokens = [
    (twoTokens.tokens as unknown[])[0],
    (twoTokens.tokens as unknown[])[0],
  ];
  await assertRejects(async () => Promise.resolve(parseMetaPageBeginResult(twoTokens)));
});

Deno.test("an account-scoped token entry is refused for a Page capture", async () => {
  const wire = beginWire();
  wire.tokens = [
    {
      scope: "account",
      social_account_id: ACCOUNT_ID,
      credential_id: CREDENTIAL_ID,
      credential_revision: 7,
      token: CAPTURED_USER_TOKEN,
      token_expires_at: GRANT_EXPIRY,
      refresh_token: null,
    },
  ];
  await assertRejects(async () => Promise.resolve(parseMetaPageBeginResult(wire)));
});

Deno.test("a credential token with a wrong credential, revision or expiry is refused", async () => {
  const wrongCredential = beginWire();
  (wrongCredential.tokens as Array<Record<string, unknown>>)[0].credential_id =
    "9a2c0001-0000-4000-8000-000000000099";
  await assertRejects(async () => Promise.resolve(parseMetaPageBeginResult(wrongCredential)));

  const wrongRevision = beginWire();
  (wrongRevision.tokens as Array<Record<string, unknown>>)[0].credential_revision = 8;
  await assertRejects(async () => Promise.resolve(parseMetaPageBeginResult(wrongRevision)));

  const wrongExpiry = beginWire();
  (wrongExpiry.tokens as Array<Record<string, unknown>>)[0].token_expires_at =
    "2027-01-01T00:00:00+00:00";
  await assertRejects(async () => Promise.resolve(parseMetaPageBeginResult(wrongExpiry)));
});

Deno.test("a credential token with an implicit null is refused", async () => {
  const implicitAccount = beginWire();
  delete (implicitAccount.tokens as Array<Record<string, unknown>>)[0].social_account_id;
  await assertRejects(async () => Promise.resolve(parseMetaPageBeginResult(implicitAccount)));

  const implicitRefresh = beginWire();
  delete (implicitRefresh.tokens as Array<Record<string, unknown>>)[0].refresh_token;
  await assertRejects(async () => Promise.resolve(parseMetaPageBeginResult(implicitRefresh)));
});

Deno.test("a capture whose window, attempt marker or timestamps disagree is refused", async () => {
  const incoherent = beginWire();
  incoherent.expires_at = CAPTURED_AT;
  await assertRejects(async () => Promise.resolve(parseMetaPageBeginResult(incoherent)));

  const wrongMarker = beginWire();
  wrongMarker.attempt_marker = EXPIRES_AT;
  await assertRejects(async () => Promise.resolve(parseMetaPageBeginResult(wrongMarker)));

  const wrongInner = beginWire();
  (wrongInner.capture as Record<string, unknown>).captured_at = EXPIRES_AT;
  await assertRejects(async () => Promise.resolve(parseMetaPageBeginResult(wrongInner)));

  const wrongTarget = beginWire();
  ((wrongTarget.capture as Record<string, unknown>).targets as Array<Record<string, unknown>>)[0]
    .last_refresh_attempt_at = EXPIRES_AT;
  await assertRejects(async () => Promise.resolve(parseMetaPageBeginResult(wrongTarget)));
});

Deno.test("a membership with a duplicate account is refused", async () => {
  const duplicate = beginWire();
  (duplicate.capture as Record<string, unknown>).members = [
    pageMember(),
    pageMember(),
  ];
  await assertRejects(async () => parseMetaPageBeginResult(duplicate));
});

Deno.test("a membership that moved or lost the selected target is refused by the store", async () => {
  const moved = beginWire();
  (moved.capture as Record<string, unknown>).members = [pageMember({ connection_version: 5 })];
  const movedStore = storeWith(rpcReturning({ begin_meta_account_refresh: moved }));
  const movedError = await assertRejects(async () =>
    movedStore.begin({
      userId: OWNER_ID,
      socialAccountId: ACCOUNT_ID,
      platform: "instagram",
    })
  );
  assert(isMetaPageReconciliationError(movedError));
  assertEquals(movedError.code, "capture_refused");

  const missingTarget = beginWire();
  (missingTarget.capture as Record<string, unknown>).members = [
    pageMember({ social_account_id: SIBLING_ID }),
  ];
  const missingStore = storeWith(rpcReturning({ begin_meta_account_refresh: missingTarget }));
  const missingError = await assertRejects(async () =>
    missingStore.begin({
      userId: OWNER_ID,
      socialAccountId: ACCOUNT_ID,
      platform: "instagram",
    })
  );
  assert(isMetaPageReconciliationError(missingError));
  assertEquals(missingError.code, "capture_refused");
});

Deno.test("a credential with a dirty identifier, a non-positive revision or a bad expiry is refused", async () => {
  const dirty = beginWire();
  ((dirty.capture as Record<string, unknown>).credential as Record<string, unknown>)
    .credential_id = " 9a2c0001 ";
  await assertRejects(async () => Promise.resolve(parseMetaPageBeginResult(dirty)));

  const zeroRevision = beginWire();
  ((zeroRevision.capture as Record<string, unknown>).credential as Record<string, unknown>)
    .revision = 0;
  await assertRejects(async () => Promise.resolve(parseMetaPageBeginResult(zeroRevision)));

  const naiveExpiry = beginWire();
  ((naiveExpiry.capture as Record<string, unknown>).credential as Record<string, unknown>)
    .token_expires_at = "2026-12-01T00:00:00";
  await assertRejects(async () => Promise.resolve(parseMetaPageBeginResult(naiveExpiry)));
});

Deno.test("a non-numeric-only identifier is accepted and a control character is not", async () => {
  const opaque = beginWire();
  ((opaque.capture as Record<string, unknown>).credential as Record<string, unknown>)
    .credential_id = "credential-abc";
  (opaque.tokens as Array<Record<string, unknown>>)[0].credential_id = "credential-abc";
  assertEquals(parseMetaPageBeginResult(opaque).credential.credentialId, "credential-abc");

  const control = beginWire();
  ((control.capture as Record<string, unknown>).credential as Record<string, unknown>)
    .credential_id = "credential" + String.fromCharCode(1) + "abc";
  (control.tokens as Array<Record<string, unknown>>)[0].credential_id =
    "credential" + String.fromCharCode(1) + "abc";
  await assertRejects(async () => parseMetaPageBeginResult(control));
});

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

Deno.test("the begin request names exactly one facebook_user_token target", async () => {
  const calls: RpcCall[] = [];
  const store = storeWith(rpcReturning({ begin_meta_account_refresh: beginWire() }, calls));
  await store.begin({
    userId: OWNER_ID,
    socialAccountId: ACCOUNT_ID,
    platform: "instagram",
    platformUserId: INSTAGRAM_ID,
  });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].name, "begin_meta_account_refresh");
  assertEquals(calls[0].args.p_user_id, OWNER_ID);
  assertEquals(calls[0].args.p_payload, {
    accounts: [{ social_account_id: ACCOUNT_ID, operation: "facebook_user_token" }],
  });
});

Deno.test("a capture that describes another account, owner or platform is refused", async () => {
  const otherAccount = beginWire();
  ((otherAccount.capture as Record<string, unknown>).targets as Array<Record<string, unknown>>)[0]
    .social_account_id = SIBLING_ID;
  const store = storeWith(rpcReturning({ begin_meta_account_refresh: otherAccount }));
  const error = await assertRejects(async () =>
    store.begin({
      userId: OWNER_ID,
      socialAccountId: ACCOUNT_ID,
      platform: "instagram",
    })
  );
  assert(isMetaPageReconciliationError(error));
  assertEquals(error.code, "capture_refused");
  assertEquals(isIndeterminatePageOutcome(error), false);

  const otherOwner = beginWire();
  (otherOwner.capture as Record<string, unknown>).user_id = OTHER_OWNER_ID;
  const ownerStore = storeWith(rpcReturning({ begin_meta_account_refresh: otherOwner }));
  const ownerError = await assertRejects(async () =>
    ownerStore.begin({
      userId: OWNER_ID,
      socialAccountId: ACCOUNT_ID,
      platform: "instagram",
    })
  );
  assert(isMetaPageReconciliationError(ownerError));
  assertEquals(ownerError.code, "capture_refused");
});

Deno.test("the driver envelope must carry an own data and an own null error", async () => {
  const envelopes: Array<Record<string, unknown>> = [
    {},
    { data: beginWire() },
    { error: null },
    { data: beginWire(), error: undefined },
    { data: beginWire(), error: false },
    { data: beginWire(), error: "boom" },
    { data: null, error: null },
    { data: undefined, error: null },
  ];
  for (const envelope of envelopes) {
    const store = storeWith(async () => envelope);
    const error = await assertRejects(async () =>
      store.begin({
        userId: OWNER_ID,
        socialAccountId: ACCOUNT_ID,
        platform: "instagram",
      })
    );
    assert(isMetaPageReconciliationError(error));
    assertEquals(error.code, "capture_malformed");
    assertEquals(isIndeterminatePageOutcome(error), true);
  }
});

Deno.test("an inherited or a getter error envelope is not a success", async () => {
  const inherited = Object.create({ error: null }) as { data?: unknown };
  inherited.data = beginWire();
  const inheritedStore = storeWith(async () => inherited);
  const inheritedError = await assertRejects(async () =>
    inheritedStore.begin({
      userId: OWNER_ID,
      socialAccountId: ACCOUNT_ID,
      platform: "instagram",
    })
  );
  assert(isMetaPageReconciliationError(inheritedError));
  assertEquals(inheritedError.code, "capture_malformed");

  const getter = {
    data: beginWire(),
    get error(): unknown {
      return null;
    },
  };
  const getterStore = storeWith(async () => getter);
  const getterError = await assertRejects(async () =>
    getterStore.begin({
      userId: OWNER_ID,
      socialAccountId: ACCOUNT_ID,
      platform: "instagram",
    })
  );
  assert(isMetaPageReconciliationError(getterError));
  assertEquals(getterError.code, "capture_malformed");
});

Deno.test("the SQLSTATE decides the store error code", async () => {
  const cases: Array<[string, string]> = [
    ["MAR01", "capture_refused"],
    ["MAR02", "capture_refused"],
    ["MAR03", "capture_refused"],
    ["MAR04", "capture_refused"],
    ["MAR05", "capture_contended"],
    ["MAR06", "capture_refused"],
    ["MAR07", "capture_refused"],
    ["57014", "capture_cancelled"],
    ["PGRST202", "schema_unavailable"],
  ];
  for (const [code, expected] of cases) {
    // The driver reports a SQLSTATE through the envelope, not by throwing.
    const store = storeWith(async () => ({
      data: null,
      error: { message: "driver text with a secret", code },
    }));
    const error = await assertRejects(async () =>
      store.begin({
        userId: OWNER_ID,
        socialAccountId: ACCOUNT_ID,
        platform: "instagram",
      })
    );
    assert(isMetaPageReconciliationError(error));
    assertEquals(error.code, expected);
    // The driver text never survives.
    assertEquals(error.message.includes("driver text"), false);
  }
});

Deno.test("the protected binding read is a narrow, owner-scoped projection", async () => {
  const requests: unknown[] = [];
  const store = storeWith(
    rpcReturning({ begin_meta_account_refresh: beginWire() }),
    async (request) => {
      requests.push(request);
      return { data: bindingRow(), error: null };
    },
  );
  const binding = await store.readProtectedBinding({
    userId: OWNER_ID,
    socialAccountId: ACCOUNT_ID,
    credentialId: CREDENTIAL_ID,
    connectionVersion: 4,
  });
  assertEquals(binding.verifiedFacebookPageId, PAGE_ID);
  assertEquals(binding.verifiedInstagramUserId, INSTAGRAM_ID);
  assertEquals(requests.length, 1);
  assertEquals(requests[0], {
    userId: OWNER_ID,
    socialAccountId: ACCOUNT_ID,
    credentialId: CREDENTIAL_ID,
    connectionVersion: 4,
  });
});

Deno.test("a missing binding is an absence and a failed binding read is not", async () => {
  const missingStore = storeWith(
    rpcReturning({}),
    async () => ({ data: null, error: null }),
  );
  const missing = await assertRejects(async () =>
    missingStore.readProtectedBinding({
      userId: OWNER_ID,
      socialAccountId: ACCOUNT_ID,
      credentialId: CREDENTIAL_ID,
      connectionVersion: 4,
    })
  );
  assert(isMetaPageReconciliationError(missing));
  assertEquals(missing.code, "binding_missing");

  const failedStore = storeWith(
    rpcReturning({}),
    async () => ({ data: null, error: { message: "driver text" } }),
  );
  const failed = await assertRejects(async () =>
    failedStore.readProtectedBinding({
      userId: OWNER_ID,
      socialAccountId: ACCOUNT_ID,
      credentialId: CREDENTIAL_ID,
      connectionVersion: 4,
    })
  );
  assert(isMetaPageReconciliationError(failed));
  assertEquals(failed.code, "binding_malformed");

  const thrownStore = storeWith(
    rpcReturning({}),
    async () => {
      throw new Error("transport");
    },
  );
  const thrown = await assertRejects(async () =>
    thrownStore.readProtectedBinding({
      userId: OWNER_ID,
      socialAccountId: ACCOUNT_ID,
      credentialId: CREDENTIAL_ID,
      connectionVersion: 4,
    })
  );
  assert(isMetaPageReconciliationError(thrown));
  assertEquals(thrown.code, "binding_malformed");
});

Deno.test("a binding row with a missing own field is malformed", async () => {
  const incomplete = bindingRow();
  delete incomplete.verified_facebook_page_id;
  await assertRejects(async () => Promise.resolve(parseMetaPageProtectedBinding(incomplete)));

  const dirty = bindingRow({ verified_instagram_user_id: " ig-1 " });
  await assertRejects(async () => Promise.resolve(parseMetaPageProtectedBinding(dirty)));

  const wrongPlatform = bindingRow({ platform: "tiktok" });
  await assertRejects(async () => Promise.resolve(parseMetaPageProtectedBinding(wrongPlatform)));

  const zeroVersion = bindingRow({ connection_version: 0 });
  await assertRejects(async () => Promise.resolve(parseMetaPageProtectedBinding(zeroVersion)));
});

Deno.test("the success request carries exactly the three contract keys", async () => {
  const calls: RpcCall[] = [];
  const store = storeWith(
    rpcReturning({ write_meta_page_reconciliation_success: writeReceipt() }, calls),
  );
  await store.writeSuccess({
    userId: OWNER_ID,
    captureId: CAPTURE_ID,
    accessToken: DERIVED_PAGE_TOKEN,
    facebookPageId: PAGE_ID,
    instagramUserId: INSTAGRAM_ID,
  });
  assertEquals(calls[0].name, "write_meta_page_reconciliation_success");
  assertEquals(calls[0].args.p_payload, {
    capture_id: CAPTURE_ID,
    operation: "page_reconciliation",
    fields: {
      access_token: DERIVED_PAGE_TOKEN,
      facebook_page_id: PAGE_ID,
      instagram_user_id: INSTAGRAM_ID,
      token_expires_at: null,
    },
  });
  const payload = calls[0].args.p_payload as Record<string, unknown>;
  assertEquals(Object.keys(payload).sort(), ["capture_id", "fields", "operation"]);
  assertEquals(Object.keys(payload.fields as Record<string, unknown>).sort(), [
    "access_token",
    "facebook_page_id",
    "instagram_user_id",
    "token_expires_at",
  ]);
});

Deno.test("a Facebook Page writes an explicit null Instagram identity", async () => {
  const calls: RpcCall[] = [];
  const store = storeWith(
    rpcReturning({ write_meta_page_reconciliation_success: writeReceipt() }, calls),
  );
  await store.writeSuccess({
    userId: OWNER_ID,
    captureId: CAPTURE_ID,
    accessToken: DERIVED_PAGE_TOKEN,
    facebookPageId: PAGE_ID,
    instagramUserId: null,
  });
  const payload = calls[0].args.p_payload as { fields: Record<string, unknown> };
  assertEquals(payload.fields.instagram_user_id, null);
  assertEquals(Object.hasOwn(payload.fields, "instagram_user_id"), true);
});

Deno.test("the success receipt must hold exactly the eight contract keys", async () => {
  const parsed = parseMetaPageWriteResult(writeReceipt());
  assertEquals(parsed.captureId, CAPTURE_ID);
  assertEquals(parsed.credentialGeneration, 12);
  assertEquals(parsed.expiryState, "unknown");

  const extra = writeReceipt();
  extra.extra_key = 1;
  await assertRejects(async () => Promise.resolve(parseMetaPageWriteResult(extra)));

  const missing = writeReceipt();
  delete missing.expiry_state;
  await assertRejects(async () => Promise.resolve(parseMetaPageWriteResult(missing)));

  const notApplied = writeReceipt({ applied: false });
  await assertRejects(async () => Promise.resolve(parseMetaPageWriteResult(notApplied)));

  const wrongOperation = writeReceipt({ operation: "direct_token" });
  await assertRejects(async () => Promise.resolve(parseMetaPageWriteResult(wrongOperation)));

  const wrongExpiry = writeReceipt({ expiry_state: "infinite" });
  await assertRejects(async () => Promise.resolve(parseMetaPageWriteResult(wrongExpiry)));
});

Deno.test("a malformed write receipt is indeterminate and never a success", async () => {
  const store = storeWith(
    rpcReturning({ write_meta_page_reconciliation_success: { applied: false } }),
  );
  const error = await assertRejects(async () =>
    store.writeSuccess({
      userId: OWNER_ID,
      captureId: CAPTURE_ID,
      accessToken: DERIVED_PAGE_TOKEN,
      facebookPageId: PAGE_ID,
      instagramUserId: INSTAGRAM_ID,
    })
  );
  assert(isMetaPageReconciliationError(error));
  assertEquals(error.code, "write_malformed");
  assertEquals(isIndeterminatePageOutcome(error), true);
});

Deno.test("a refused write is definite and an unreadable write is indeterminate", async () => {
  const refused = storeWith(async () => ({
    data: null,
    error: { message: "driver text", code: "MAR04" },
  }));
  const refusedError = await assertRejects(async () =>
    refused.writeSuccess({
      userId: OWNER_ID,
      captureId: CAPTURE_ID,
      accessToken: DERIVED_PAGE_TOKEN,
      facebookPageId: PAGE_ID,
      instagramUserId: INSTAGRAM_ID,
    })
  );
  assert(isMetaPageReconciliationError(refusedError));
  assertEquals(refusedError.code, "write_refused");
  assertEquals(isIndeterminatePageOutcome(refusedError), false);

  const unreadable = storeWith(async () => {
    throw new Error("transport");
  });
  const unreadableError = await assertRejects(async () =>
    unreadable.writeSuccess({
      userId: OWNER_ID,
      captureId: CAPTURE_ID,
      accessToken: DERIVED_PAGE_TOKEN,
      facebookPageId: PAGE_ID,
      instagramUserId: INSTAGRAM_ID,
    })
  );
  assert(isMetaPageReconciliationError(unreadableError));
  assertEquals(unreadableError.code, "write_transport");
  assertEquals(isIndeterminatePageOutcome(unreadableError), true);
});

Deno.test("the failure writer reuses the accepted failure contract", async () => {
  const calls: RpcCall[] = [];
  const store = storeWith(
    rpcReturning(
      {
        record_meta_refresh_failure: {
          capture_id: CAPTURE_ID,
          applied: true,
          error_category: "provider_invalid_grant",
          failure_count: 1,
          escalated: true,
          alert_marker_written: true,
          transitioned: true,
          enqueued: 1,
          account_found: true,
          account: accountState({ needs_reauth: true, failure_count: 1 }),
        },
      },
      calls,
    ),
  );
  const failure = await store.recordFailure({
    userId: OWNER_ID,
    captureId: CAPTURE_ID,
    socialAccountId: ACCOUNT_ID,
    errorCategory: "provider_invalid_grant",
  });
  assertEquals(failure.errorCategory, "provider_invalid_grant");
  assertEquals(failure.alertMarkerWritten, true);
  assertEquals(calls[0].args.p_payload, {
    capture_id: CAPTURE_ID,
    social_account_id: ACCOUNT_ID,
    error_category: "provider_invalid_grant",
  });
});

Deno.test("a malformed failure receipt is indeterminate", async () => {
  const store = storeWith(
    rpcReturning({ record_meta_refresh_failure: { applied: true } }),
  );
  const error = await assertRejects(async () =>
    store.recordFailure({
      userId: OWNER_ID,
      captureId: CAPTURE_ID,
      socialAccountId: ACCOUNT_ID,
      errorCategory: "provider_invalid_grant",
    })
  );
  assert(isMetaPageReconciliationError(error));
  assertEquals(error.code, "failure_malformed");
  assertEquals(isIndeterminatePageOutcome(error), true);
});

Deno.test("credential, member and token objects reject an unexpected key and a getter", async () => {
  let reads = 0;
  const extraCredential = beginWire();
  const credential = (extraCredential.capture as Record<string, unknown>).credential as Record<string, unknown>;
  Object.defineProperty(credential, "unexpected_authority", {
    enumerable: true,
    get() {
      reads += 1;
      return "not-in-the-frozen-contract";
    },
  });
  assertThrows(() => parseMetaPageBeginResult(extraCredential));

  const extraMember = beginWire();
  const member = ((extraMember.capture as Record<string, unknown>).members as Array<Record<string, unknown>>)[0];
  Object.defineProperty(member, "unexpected_authority", {
    enumerable: false,
    get() {
      reads += 1;
      return "not-in-the-frozen-contract";
    },
  });
  assertThrows(() => parseMetaPageBeginResult(extraMember));

  const extraToken = beginWire();
  const token = (extraToken.tokens as Array<Record<string, unknown>>)[0];
  token.unexpected_authority = "not-in-the-frozen-contract";
  assertThrows(() => parseMetaPageBeginResult(extraToken));
  assertEquals(reads, 0);
});

Deno.test("a missing credential key is refused and an explicit null expiry is not a missing key", async () => {
  const missing = beginWire();
  delete ((missing.capture as Record<string, unknown>).credential as Record<string, unknown>).revision;
  assertThrows(() => parseMetaPageBeginResult(missing));

  const explicitNull = beginWire();
  ((explicitNull.capture as Record<string, unknown>).credential as Record<string, unknown>)
    .token_expires_at = null;
  (explicitNull.tokens as Array<Record<string, unknown>>)[0].token_expires_at = null;
  assertEquals(parseMetaPageBeginResult(explicitNull).credential.tokenExpiresAt, null);
});

Deno.test("membership platforms are facebook or instagram and the selected platform must match", async () => {
  const sibling = "0f1a0003-0000-4000-8000-000000000013";
  const both = beginWire();
  (both.capture as Record<string, unknown>).members = [
    pageMember(),
    pageMember({
      social_account_id: sibling,
      platform: "facebook",
      capability_generation: null,
      connection_version: 2,
      fence_connection_version: 2,
    }),
  ];
  const parsed = parseMetaPageBeginResult(both);
  assertEquals(parsed.members.map((member) => member.platform), ["instagram", "facebook"]);
  assertEquals(parsed.members[1].capabilityGeneration, null);

  const unsupported = beginWire();
  ((unsupported.capture as Record<string, unknown>).members as Array<Record<string, unknown>>)[0]
    .platform = "unsupported-platform";
  const unsupportedError = assertThrows(() => parseMetaPageBeginResult(unsupported));
  assert(isMetaPageReconciliationError(unsupportedError));
  assertEquals(unsupportedError.code, "capture_malformed");

  const crossed = beginWire();
  ((crossed.capture as Record<string, unknown>).members as Array<Record<string, unknown>>)[0]
    .platform = "facebook";
  const store = storeWith(rpcReturning({ begin_meta_account_refresh: crossed }));
  const crossedError = await assertRejects(() =>
    store.begin({
      userId: OWNER_ID,
      socialAccountId: ACCOUNT_ID,
      platform: "instagram",
    })
  );
  assert(isMetaPageReconciliationError(crossedError));
  assertEquals(crossedError.code, "capture_refused");
});

Deno.test("a success or failure account getter is rejected without being invoked", async () => {
  let reads = 0;
  const success = writeReceipt();
  const successAccount = success.account as Record<string, unknown>;
  const successId = successAccount.social_account_id;
  Object.defineProperty(successAccount, "social_account_id", {
    enumerable: true,
    get() {
      reads += 1;
      return successId;
    },
  });
  const successStore = storeWith(rpcReturning({ write_meta_page_reconciliation_success: success }));
  const successError = await assertRejects(() =>
    successStore.writeSuccess({
      userId: OWNER_ID,
      captureId: CAPTURE_ID,
      accessToken: DERIVED_PAGE_TOKEN,
      facebookPageId: PAGE_ID,
      instagramUserId: INSTAGRAM_ID,
    })
  );
  assert(isMetaPageReconciliationError(successError));
  assertEquals(successError.code, "write_malformed");

  const failureAccount = accountState({ needs_reauth: true, failure_count: 1 });
  const failureId = failureAccount.social_account_id;
  Object.defineProperty(failureAccount, "social_account_id", {
    enumerable: true,
    get() {
      reads += 1;
      return failureId;
    },
  });
  const failureStore = storeWith(rpcReturning({
    record_meta_refresh_failure: {
      capture_id: CAPTURE_ID,
      applied: true,
      error_category: "provider_invalid_grant",
      failure_count: 1,
      escalated: true,
      alert_marker_written: true,
      transitioned: true,
      enqueued: 1,
      account_found: true,
      account: failureAccount,
    },
  }));
  const failureError = await assertRejects(() =>
    failureStore.recordFailure({
      userId: OWNER_ID,
      captureId: CAPTURE_ID,
      socialAccountId: ACCOUNT_ID,
      errorCategory: "provider_invalid_grant",
    })
  );
  assert(isMetaPageReconciliationError(failureError));
  assertEquals(failureError.code, "failure_malformed");
  assertEquals(reads, 0);
});
