import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CredentialStoreError,
  createFacebookUserCredentialStore,
  createInstagramAccountCapabilityStore,
  createServiceRpcCaller,
  parseFacebookUserAccountCredential,
  parseInstagramAccountCapability,
  type ServiceRpcCaller,
} from "./facebookUserCredentialStore.ts";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const ACCOUNT_ID = "22222222-2222-2222-2222-222222222222";
const CREDENTIAL_ID = "33333333-3333-3333-3333-333333333333";

interface RecordedCall {
  functionName: string;
  args: Record<string, unknown>;
}

function fakeRpc(
  responder: (call: RecordedCall) => { data?: unknown; error?: { message: string; code?: string } },
): { rpc: ServiceRpcCaller; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const rpc: ServiceRpcCaller = async (functionName, args) => {
    const call = { functionName, args };
    calls.push(call);
    const result = responder(call);
    if (result.error) return { data: null, error: result.error };
    return { data: result.data ?? null, error: null };
  };
  return { rpc, calls };
}

function accountCredentialPayload(overrides: Record<string, unknown> = {}) {
  return {
    found: true,
    social_account_id: ACCOUNT_ID,
    platform: "facebook",
    credential_id: CREDENTIAL_ID,
    credential_kind: "facebook_user",
    token: "user-token-value",
    token_expires_at: "2026-11-26T09:00:00Z",
    revision: 3,
    capability_generation: 7,
    connection_version: 2,
    ...overrides,
  };
}

Deno.test("the account read uses the accepted function and argument names", async () => {
  const { rpc, calls } = fakeRpc(() => ({ data: accountCredentialPayload() }));
  const store = createFacebookUserCredentialStore(rpc);

  const credential = await store.readAccountCredential({
    userId: USER_ID,
    socialAccountId: ACCOUNT_ID,
  });

  assertEquals(calls.length, 1);
  assertEquals(calls[0].functionName, "read_facebook_user_account_credential");
  assertEquals(calls[0].args, {
    p_user_id: USER_ID,
    p_social_account_id: ACCOUNT_ID,
  });
  assertEquals(credential.found, true);
  assertEquals(credential.token, "user-token-value");
  assertEquals(credential.revision, 3);
  assertEquals(credential.capabilityGeneration, 7);
  assertEquals(credential.connectionVersion, 2);
});

Deno.test("a missing binding is an empty result, never an invented token", () => {
  const credential = parseFacebookUserAccountCredential(
    "read_facebook_user_account_credential",
    accountCredentialPayload({ found: false, credential_id: null, token: null, revision: null }),
  );
  assertEquals(credential.found, false);
  assertEquals(credential.token, null);
  assertEquals(credential.credentialId, null);
});

Deno.test("a missing schema is refused as schema_unavailable, never as an empty result", async () => {
  const { rpc } = fakeRpc(() => ({
    error: {
      message:
        "Could not find the function public.read_facebook_user_account_credential in the schema cache",
      code: "PGRST202",
    },
  }));
  const store = createFacebookUserCredentialStore(rpc);

  const error = await assertRejects(
    () => store.readAccountCredential({ userId: USER_ID, socialAccountId: ACCOUNT_ID }),
    CredentialStoreError,
  );
  assertEquals(error.code, "schema_unavailable");
  assertEquals(error.sqlstate, "PGRST202");
});

Deno.test("a stale fence is refused as stale_version and writes nothing", async () => {
  for (const sqlstate of ["FUC01", "ICG01"]) {
    const { rpc } = fakeRpc(() => ({
      error: { message: "stale credential generation", code: sqlstate },
    }));
    const store = createFacebookUserCredentialStore(rpc);

    const error = await assertRejects(
      () => store.readAccountCredential({ userId: USER_ID, socialAccountId: ACCOUNT_ID }),
      CredentialStoreError,
    );
    assertEquals(error.code, "stale_version");
    assertEquals(error.sqlstate, sqlstate);
  }
});

Deno.test("the other accepted refusals are reported as refused", async () => {
  for (const sqlstate of ["FUC02", "FUC03", "FUC04", "FUC06", "ICG02", "ICG03", "ICG04", "ICG05"]) {
    const { rpc } = fakeRpc(() => ({ error: { message: "refused", code: sqlstate } }));
    const store = createFacebookUserCredentialStore(rpc);

    const error = await assertRejects(
      () => store.readAccountCredential({ userId: USER_ID, socialAccountId: ACCOUNT_ID }),
      CredentialStoreError,
    );
    assertEquals(error.code, "refused");
    assertEquals(error.sqlstate, sqlstate);
  }
});

Deno.test("an account that is not owned by the caller is a refusal, not an empty read", async () => {
  const { rpc } = fakeRpc(() => ({
    error: {
      message: "Instagram account 22222222-2222-2222-2222-222222222222 is not owned by the given user",
      code: "P0001",
    },
  }));
  const store = createFacebookUserCredentialStore(rpc);

  const error = await assertRejects(
    () => store.readAccountCredential({ userId: USER_ID, socialAccountId: ACCOUNT_ID }),
    CredentialStoreError,
  );
  assertEquals(error.code, "refused");
  assertEquals(error.message.includes(ACCOUNT_ID), false);
  assertEquals(error.message.includes("not owned"), false);
});

Deno.test("a transport failure is reported as read_failed", async () => {
  const { rpc } = fakeRpc(() => ({
    error: { message: "canceling statement due to statement timeout", code: "57014" },
  }));
  const store = createFacebookUserCredentialStore(rpc);

  const error = await assertRejects(
    () => store.readAccountCredential({ userId: USER_ID, socialAccountId: ACCOUNT_ID }),
    CredentialStoreError,
  );
  assertEquals(error.code, "read_failed");
});

Deno.test("a malformed return value is refused, never read as success", async () => {
  const malformed: unknown[] = [
    null,
    "not an object",
    42,
    [],
    { found: "yes" },
    { found: true, social_account_id: ACCOUNT_ID, platform: "tiktok", credential_id: null },
    { found: true, social_account_id: ACCOUNT_ID, platform: "facebook", revision: "three" },
    { found: true, social_account_id: ACCOUNT_ID, platform: "facebook", revision: Number.NaN },
  ];

  for (const payload of malformed) {
    const { rpc } = fakeRpc(() => ({ data: payload }));
    const store = createFacebookUserCredentialStore(rpc);

    const error = await assertRejects(
      () => store.readAccountCredential({ userId: USER_ID, socialAccountId: ACCOUNT_ID }),
      CredentialStoreError,
    );
    assertEquals(error.code, "invalid_contract");
  }
});

Deno.test("a capability projection with an unknown login kind is refused", () => {
  const error = (() => {
    try {
      parseInstagramAccountCapability("read_instagram_account_capability", {
        social_account_id: ACCOUNT_ID,
        capability_present: true,
        login_kind: "carrier_pigeon",
        permission_read_state: "ok",
        scopes_authoritative: true,
        granted_scopes: [],
        credential_generation: 1,
        has_protected_credential: true,
      });
      return null;
    } catch (thrown) {
      return thrown;
    }
  })();

  assertEquals(error instanceof CredentialStoreError, true);
  assertEquals((error as CredentialStoreError).code, "invalid_contract");
});

Deno.test("the capability projection is read strictly", () => {
  const capability = parseInstagramAccountCapability("read_instagram_account_capability", {
    social_account_id: ACCOUNT_ID,
    capability_present: true,
    login_kind: "page_linked",
    permission_read_state: "ok",
    scopes_authoritative: true,
    granted_scopes: ["instagram_basic", "read_insights"],
    scopes_read_at: "2026-10-26T09:00:00Z",
    last_read_failed_at: null,
    last_read_error_code: null,
    credential_generation: 4,
    credential_updated_at: "2026-10-26T08:00:00Z",
    generation_reason: "credential_bound",
    reconnected_at: null,
    has_protected_credential: true,
    updated_at: "2026-10-26T09:00:00Z",
  });

  assertEquals(capability.loginKind, "page_linked");
  assertEquals(capability.permissionReadState, "ok");
  assertEquals(capability.scopesAuthoritative, true);
  assertEquals(capability.grantedScopes, ["instagram_basic", "read_insights"]);
  assertEquals(capability.credentialGeneration, 4);
  assertEquals(capability.hasProtectedCredential, true);
});

Deno.test("the capability read uses the accepted function and argument names", async () => {
  const { rpc, calls } = fakeRpc(() => ({
    data: {
      social_account_id: ACCOUNT_ID,
      capability_present: true,
      login_kind: "page_linked",
      permission_read_state: "unknown",
      scopes_authoritative: false,
      granted_scopes: [],
      credential_generation: 0,
      has_protected_credential: false,
    },
  }));
  const capabilities = createInstagramAccountCapabilityStore(rpc);
  const capability = await capabilities.readCapability({
    userId: USER_ID,
    socialAccountId: ACCOUNT_ID,
  });

  assertEquals(calls.length, 1);
  assertEquals(calls[0].functionName, "read_instagram_account_capability");
  assertEquals(calls[0].args, {
    p_user_id: USER_ID,
    p_social_account_id: ACCOUNT_ID,
  });
  assertEquals(capability.loginKind, "page_linked");
});

Deno.test("a read for a different account is refused and the token is not returned", async () => {
  const { rpc } = fakeRpc(() => ({
    data: accountCredentialPayload({ social_account_id: CREDENTIAL_ID, token: "should-not-surface" }),
  }));
  const store = createFacebookUserCredentialStore(rpc);
  const error = await assertRejects(
    () => store.readAccountCredential({ userId: USER_ID, socialAccountId: ACCOUNT_ID }),
    CredentialStoreError,
  );
  assertEquals(error.code, "invalid_contract");
  assertEquals(error.message.includes("should-not-surface"), false);
});

Deno.test("a thrown transport error is a typed read failure and drops the driver text", async () => {
  const secret = "EAABwzLixnjYBO7ZBsecretValueThatIsLongEnoughToLookLikeAToken123";
  const rpc: ServiceRpcCaller = () => {
    throw new Error(`connect failed access_token=${secret}`);
  };
  const store = createFacebookUserCredentialStore(rpc);
  const error = await assertRejects(
    () => store.readAccountCredential({ userId: USER_ID, socialAccountId: ACCOUNT_ID }),
    CredentialStoreError,
  );
  assertEquals(error.code, "read_failed");
  assertEquals(error.message.includes(secret), false);
  assertEquals(error.message.includes("access_token"), false);
});

Deno.test("a database error that quotes a token does not keep the driver text", async () => {
  const secret = "EAABwzLixnjYBO7ZBsecretValueThatIsLongEnoughToLookLikeAToken123";
  const { rpc } = fakeRpc(() => ({
    error: { message: `invalid input value for token: ${secret}`, code: "22P02" },
  }));
  const store = createFacebookUserCredentialStore(rpc);

  const error = await assertRejects(
    () => store.readAccountCredential({ userId: USER_ID, socialAccountId: ACCOUNT_ID }),
    CredentialStoreError,
  );
  assertEquals(error.code, "read_failed");
  assertEquals(error.message.includes(secret), false);
  assertEquals(error.message.includes("invalid input"), false);
});

Deno.test("the Supabase client is adapted without the adapter knowing about Supabase", async () => {
  const calls: RecordedCall[] = [];
  const client = {
    rpc(
      functionName: string,
      args?: Record<string, unknown>,
    ): PromiseLike<{
      data: unknown;
      error: { message: string; code?: string } | null;
    }> {
      calls.push({ functionName, args: args ?? {} });
      return Promise.resolve({
        data: accountCredentialPayload(),
        error: null,
      });
    },
  };

  const rpc = createServiceRpcCaller(client);
  const store = createFacebookUserCredentialStore(rpc);
  await store.readAccountCredential({ userId: USER_ID, socialAccountId: ACCOUNT_ID });

  assertEquals(calls.length, 1);
  assertEquals(calls[0].functionName, "read_facebook_user_account_credential");
});

const RAW_SECRET = "EAABwzLixnjYBO7ZBsecretValueThatIsLongEnoughToLookLikeAToken123";

function secretCredential() {
  return accountCredentialPayload({ token: RAW_SECRET });
}

function assertInvalidContract(error: CredentialStoreError): void {
  assertEquals(error.code, "invalid_contract");
  assertEquals(error.message.includes(RAW_SECRET), false);
  assertEquals(error.message.includes("access_token"), false);
}

async function rejectBothPorts(envelope: unknown): Promise<void> {
  const callback: ServiceRpcCaller = () => Promise.resolve(envelope);
  const callbackError = await assertRejects(
    () => createFacebookUserCredentialStore(callback).readAccountCredential({
      userId: USER_ID,
      socialAccountId: ACCOUNT_ID,
    }),
    CredentialStoreError,
  );
  assertInvalidContract(callbackError);

  const client = {
    rpc(): PromiseLike<unknown> {
      return Promise.resolve(envelope);
    },
  };
  const adapterError = await assertRejects(
    () => createFacebookUserCredentialStore(createServiceRpcCaller(client)).readAccountCredential({
      userId: USER_ID,
      socialAccountId: ACCOUNT_ID,
    }),
    CredentialStoreError,
  );
  assertInvalidContract(adapterError);
}

Deno.test("a missing rpc error property is an invalid contract before the token is returned", async () => {
  await rejectBothPorts({ data: secretCredential() });
});

Deno.test("an undefined rpc error is an invalid contract before the token is returned", async () => {
  await rejectBothPorts({ data: secretCredential(), error: undefined });
});

Deno.test("a false rpc error is an invalid contract before the token is returned", async () => {
  await rejectBothPorts({ data: secretCredential(), error: false });
});

Deno.test("a prototype-inherited rpc envelope is an invalid contract before the token is returned", async () => {
  await rejectBothPorts(Object.create({ data: secretCredential(), error: null }));
});

Deno.test("missing, undefined, and null rpc data are invalid contracts", async () => {
  await rejectBothPorts({ error: null, leaked: RAW_SECRET });
  await rejectBothPorts({ data: undefined, error: null, leaked: RAW_SECRET });
  await rejectBothPorts({ data: null, error: null, leaked: RAW_SECRET });
  await rejectBothPorts({ data: secretCredential(), error: { message: 12 } });
});

Deno.test("the production adapter maps driver errors and drops raw text", async () => {
  class SyntheticDriverError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = "SyntheticDriverError";
      this.code = code;
    }
  }

  const cases: Array<{
    error: unknown;
    code: CredentialStoreError["code"];
    sqlstate: string | null;
    leaked: string;
  }> = [
    {
      error: {
        message: "Could not find the function public.read_facebook_user_account_credential",
        code: "PGRST202",
      },
      code: "schema_unavailable",
      sqlstate: "PGRST202",
      leaked: "Could not find the function",
    },
    {
      error: new SyntheticDriverError(
        `Could not find the function public.read_facebook_user_account_credential ${RAW_SECRET}`,
        "PGRST202",
      ),
      code: "schema_unavailable",
      sqlstate: "PGRST202",
      leaked: RAW_SECRET,
    },
    {
      error: { message: "stale credential generation", code: "FUC01" },
      code: "stale_version",
      sqlstate: "FUC01",
      leaked: "stale credential",
    },
    {
      error: { message: `account ${RAW_SECRET} is not owned by the given user`, code: "P0001" },
      code: "refused",
      sqlstate: "P0001",
      leaked: RAW_SECRET,
    },
    {
      error: { message: `canceling statement ${RAW_SECRET}`, code: "57014" },
      code: "read_failed",
      sqlstate: "57014",
      leaked: RAW_SECRET,
    },
    {
      error: { message: `invalid input value for token: ${RAW_SECRET}` },
      code: "read_failed",
      sqlstate: null,
      leaked: RAW_SECRET,
    },
  ];

  for (const item of cases) {
    const client = {
      rpc(): PromiseLike<unknown> {
        return Promise.resolve({ data: secretCredential(), error: item.error });
      },
    };
    const error = await assertRejects(
      () => createFacebookUserCredentialStore(createServiceRpcCaller(client)).readAccountCredential({
        userId: USER_ID,
        socialAccountId: ACCOUNT_ID,
      }),
      CredentialStoreError,
    );
    assertEquals(error.code, item.code);
    assertEquals(error.sqlstate, item.sqlstate);
    assertEquals(error.message.includes(item.leaked), false);
    assertEquals(error.message.includes(RAW_SECRET), false);
  }
});

Deno.test("an explicit null rpc error on the production adapter returns the credential", async () => {
  const client = {
    rpc(): PromiseLike<unknown> {
      return Promise.resolve({ data: secretCredential(), error: null });
    },
  };
  const credential = await createFacebookUserCredentialStore(createServiceRpcCaller(client))
    .readAccountCredential({ userId: USER_ID, socialAccountId: ACCOUNT_ID });
  assertEquals(credential.token, RAW_SECRET);
  assertEquals(credential.socialAccountId, ACCOUNT_ID);
});

Deno.test("a thrown transport error from the production adapter stays read_failed", async () => {
  const rejecting = {
    rpc(): PromiseLike<unknown> {
      return Promise.reject(new Error(`connect failed access_token=${RAW_SECRET}`));
    },
  };
  const throwing = {
    rpc(): PromiseLike<unknown> {
      throw new Error(`connect failed access_token=${RAW_SECRET}`);
    },
  };

  for (const client of [rejecting, throwing]) {
    const error = await assertRejects(
      () => createFacebookUserCredentialStore(createServiceRpcCaller(client)).readAccountCredential({
        userId: USER_ID,
        socialAccountId: ACCOUNT_ID,
      }),
      CredentialStoreError,
    );
    assertEquals(error.code, "read_failed");
    assertEquals(error.message.includes(RAW_SECRET), false);
    assertEquals(error.message.includes("access_token"), false);
  }
});
