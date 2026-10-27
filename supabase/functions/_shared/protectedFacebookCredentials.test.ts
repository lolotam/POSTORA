import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CredentialStoreError,
  credentialReadClientError,
  type FacebookUserAccountCredential,
  type FacebookUserCredentialPort,
  type InstagramAccountCapability,
  type InstagramAccountCapabilityPort,
} from "./facebookUserCredentialStore.ts";
import { resolveProtectedUserToken } from "./protectedFacebookCredentials.ts";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const ACCOUNT_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_ACCOUNT_ID = "44444444-4444-4444-4444-444444444444";
const CREDENTIAL_ID = "33333333-3333-3333-3333-333333333333";
const SECRET = "EAABwzLixnjYBO7ZBsecretValueThatIsLongEnoughToLookLikeAToken123";

function credential(
  overrides: Partial<FacebookUserAccountCredential> = {},
): FacebookUserAccountCredential {
  return {
    found: true,
    socialAccountId: ACCOUNT_ID,
    platform: "facebook",
    credentialId: CREDENTIAL_ID,
    credentialKind: "facebook_user",
    token: "user-token-value",
    tokenExpiresAt: "2026-11-26T09:00:00Z",
    revision: 3,
    capabilityGeneration: null,
    connectionVersion: 1,
    ...overrides,
  };
}

function capability(loginKind: "page_linked" | "direct" | null): InstagramAccountCapability {
  return {
    socialAccountId: ACCOUNT_ID,
    capabilityPresent: true,
    loginKind,
    permissionReadState: "ok",
    scopesAuthoritative: true,
    grantedScopes: ["instagram_basic"],
    scopesReadAt: null,
    lastReadFailedAt: null,
    lastReadErrorCode: null,
    credentialGeneration: 1,
    credentialUpdatedAt: null,
    generationReason: null,
    reconnectedAt: null,
    hasProtectedCredential: true,
    updatedAt: null,
  };
}

function ports(
  read: FacebookUserCredentialPort["readAccountCredential"],
  readCapability: InstagramAccountCapabilityPort["readCapability"] = () => {
    throw new Error("capability read invoked");
  },
) {
  let pageTokenReads = 0;
  const pageToken = () => {
    pageTokenReads += 1;
    throw new Error(`page token fallback invoked ${SECRET}`);
  };
  return {
    pageToken,
    pageTokenReads: () => pageTokenReads,
    deps: {
      credentials: { readAccountCredential: read, readPageToken: pageToken },
      capabilities: { readCapability, readPageToken: pageToken },
    },
  };
}

Deno.test("a page-linked facebook user token is returned for the requested account", async () => {
  const harness = ports(async () => credential({ platform: "instagram" }), async () => capability("page_linked"));
  const resolved = await resolveProtectedUserToken(harness.deps, {
    userId: USER_ID,
    socialAccountId: ACCOUNT_ID,
  });
  assertEquals(resolved.token, "user-token-value");
  assertEquals(resolved.credentialId, CREDENTIAL_ID);
  assertEquals(resolved.revision, 3);
  assertEquals(harness.pageTokenReads(), 0);
});

Deno.test("a missing protected credential throws and does not read a page token", async () => {
  const harness = ports(async () => credential({
    found: false,
    token: null,
    credentialId: null,
    revision: null,
  }));
  const error = await assertRejects(
    () => resolveProtectedUserToken(harness.deps, { userId: USER_ID, socialAccountId: ACCOUNT_ID }),
    CredentialStoreError,
  );
  assertEquals(error.code, "not_found");
  assertEquals(error.message.includes("user-token"), false);
  assertEquals(harness.pageTokenReads(), 0);
  const clientError = credentialReadClientError(error);
  assertEquals(clientError.status, 404);
  assertEquals(clientError.error_code, "PROTECTED_CREDENTIAL_UNAVAILABLE");
  assertEquals(clientError.error.includes(SECRET), false);
});

Deno.test("a credential for a different account is refused before the token is returned", async () => {
  let capabilityReads = 0;
  const harness = ports(
    async () => credential({ socialAccountId: OTHER_ACCOUNT_ID, token: SECRET }),
    async () => {
      capabilityReads += 1;
      throw new Error("capability read invoked");
    },
  );
  const error = await assertRejects(
    () => resolveProtectedUserToken(harness.deps, { userId: USER_ID, socialAccountId: ACCOUNT_ID }),
    CredentialStoreError,
  );
  assertEquals(error.code, "invalid_contract");
  assertEquals(error.message.includes(SECRET), false);
  assertEquals(capabilityReads, 0);
  assertEquals(harness.pageTokenReads(), 0);
});

Deno.test("a direct-login instagram account does not receive the facebook user token", async () => {
  const harness = ports(
    async () => credential({ platform: "instagram", token: SECRET }),
    async () => capability("direct"),
  );
  const error = await assertRejects(
    () => resolveProtectedUserToken(harness.deps, { userId: USER_ID, socialAccountId: ACCOUNT_ID }),
    CredentialStoreError,
  );
  assertEquals(error.code, "refused");
  assertEquals(error.message.includes(SECRET), false);
  assertEquals(harness.pageTokenReads(), 0);
});

Deno.test("a null login kind is not page-linked and does not return the token", async () => {
  const harness = ports(
    async () => credential({ platform: "instagram" }),
    async () => capability(null),
  );
  const error = await assertRejects(
    () => resolveProtectedUserToken(harness.deps, { userId: USER_ID, socialAccountId: ACCOUNT_ID }),
    CredentialStoreError,
  );
  assertEquals(error.code, "refused");
});

Deno.test("a capability read failure does not return the user token", async () => {
  const harness = ports(
    async () => credential({ platform: "instagram", token: SECRET }),
    async () => {
      throw new CredentialStoreError(
        "schema_unavailable",
        `read_instagram_account_capability is not available ${SECRET}`,
      );
    },
  );
  const error = await assertRejects(
    () => resolveProtectedUserToken(harness.deps, { userId: USER_ID, socialAccountId: ACCOUNT_ID }),
    CredentialStoreError,
  );
  assertEquals(error.code, "schema_unavailable");
  const clientError = credentialReadClientError(error);
  assertEquals(clientError.error_code, "SCHEMA_UNAVAILABLE");
  assertEquals(clientError.error.includes(SECRET), false);
  assertEquals(clientError.error.includes("read_instagram_account_capability"), false);
  assertEquals(harness.pageTokenReads(), 0);
});

Deno.test("an incomplete protected credential is not a usable token", async () => {
  const incomplete = [
    credential({ credentialKind: "page" }),
    credential({ token: "" }),
    credential({ token: null }),
    credential({ credentialId: null }),
    credential({ revision: null }),
  ];
  for (const row of incomplete) {
    const harness = ports(async () => row);
    const error = await assertRejects(
      () => resolveProtectedUserToken(harness.deps, { userId: USER_ID, socialAccountId: ACCOUNT_ID }),
      CredentialStoreError,
    );
    assertEquals(error.code, "invalid_contract");
    assertEquals(harness.pageTokenReads(), 0);
  }
});

Deno.test("a missing schema on the account read is not an empty token", async () => {
  const harness = ports(async () => {
    throw new CredentialStoreError("schema_unavailable", "read_facebook_user_account_credential is not available");
  });
  const error = await assertRejects(
    () => resolveProtectedUserToken(harness.deps, { userId: USER_ID, socialAccountId: ACCOUNT_ID }),
    CredentialStoreError,
  );
  assertEquals(error.code, "schema_unavailable");
  assertEquals(harness.pageTokenReads(), 0);
});

Deno.test("a capability row for a different account does not return the token", async () => {
  const harness = ports(
    async () => credential({ platform: "instagram", token: SECRET }),
    async () => ({ ...capability("page_linked"), socialAccountId: OTHER_ACCOUNT_ID }),
  );
  const error = await assertRejects(
    () => resolveProtectedUserToken(harness.deps, { userId: USER_ID, socialAccountId: ACCOUNT_ID }),
    CredentialStoreError,
  );
  assertEquals(error.code, "invalid_contract");
  assertEquals(error.message.includes(SECRET), false);
});
