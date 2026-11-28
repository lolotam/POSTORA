import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  authenticateCaller,
  isValidUserIdUuid,
  serviceRoleCallerUserId,
} from "./auth-helper.ts";

const VALID_UUID = "11111111-2222-4333-8444-555555555555";
const OTHER_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

Deno.test("isValidUserIdUuid accepts valid RFC UUIDs and rejects non-UUID values", () => {
  assertEquals(isValidUserIdUuid(VALID_UUID), true);
  assertEquals(isValidUserIdUuid("not-a-uuid"), false);
  assertEquals(isValidUserIdUuid(""), false);
  assertEquals(isValidUserIdUuid(undefined), false);
  assertEquals(isValidUserIdUuid(null), false);
});

Deno.test("authenticateCaller throws when Authorization header is missing or malformed", async () => {
  const reqMissing = new Request("https://postora.test/fn", { method: "POST" });
  await assertRejects(
    () => authenticateCaller(reqMissing),
    Error,
    "Missing or invalid Authorization header",
  );

  const reqBasic = new Request("https://postora.test/fn", {
    method: "POST",
    headers: { Authorization: "Basic abc" },
  });
  await assertRejects(
    () => authenticateCaller(reqBasic),
    Error,
    "Missing or invalid Authorization header",
  );
});

Deno.test("authenticateCaller accepts service-role bearer with valid UUID bodyUserId", async () => {
  const req = new Request("https://postora.test/fn", {
    method: "POST",
    headers: { Authorization: "Bearer srv-key" },
  });

  const res = await authenticateCaller(req, VALID_UUID, {
    serviceRoleKey: "srv-key",
  });
  assertEquals(res, { userId: VALID_UUID, isServiceRole: true });
});

Deno.test("authenticateCaller rejects service-role bearer when bodyUserId is missing or not a UUID", async () => {
  const req = new Request("https://postora.test/fn", {
    method: "POST",
    headers: { Authorization: "Bearer srv-key" },
  });

  await assertRejects(
    () => authenticateCaller(req, undefined, { serviceRoleKey: "srv-key" }),
    Error,
    "Service-role call requires a valid UUID user_id in request body",
  );

  await assertRejects(
    () => authenticateCaller(req, null, { serviceRoleKey: "srv-key" }),
    Error,
    "Service-role call requires a valid UUID user_id in request body",
  );

  await assertRejects(
    () => authenticateCaller(req, "not-a-uuid", { serviceRoleKey: "srv-key" }),
    Error,
    "Service-role call requires a valid UUID user_id in request body",
  );
});

Deno.test("authenticateCaller rejects user JWT when claims.sub is missing or not a valid UUID", async () => {
  const req = new Request("https://postora.test/fn", {
    method: "POST",
    headers: { Authorization: "Bearer usr-jwt" },
  });

  // Anon key style JWT: valid signature/claims object, but no `sub` claim
  await assertRejects(
    () =>
      authenticateCaller(req, VALID_UUID, {
        serviceRoleKey: "srv-key",
        getClaims: () => Promise.resolve({ data: { claims: {} }, error: null }),
      }),
    Error,
    "Unauthorized: token subject is not a valid user ID",
  );

  // Non-UUID `sub` claim (e.g. "anon" or arbitrary string)
  await assertRejects(
    () =>
      authenticateCaller(req, VALID_UUID, {
        serviceRoleKey: "srv-key",
        getClaims: () =>
          Promise.resolve({ data: { claims: { sub: "anon-subject" } }, error: null }),
      }),
    Error,
    "Unauthorized: token subject is not a valid user ID",
  );
});

Deno.test("authenticateCaller returns JWT userId when claims.sub is a valid UUID", async () => {
  const req = new Request("https://postora.test/fn", {
    method: "POST",
    headers: { Authorization: "Bearer usr-jwt" },
  });

  const res = await authenticateCaller(req, OTHER_UUID, {
    serviceRoleKey: "srv-key",
    getClaims: () =>
      Promise.resolve({ data: { claims: { sub: VALID_UUID } }, error: null }),
  });
  assertEquals(res, { userId: VALID_UUID, isServiceRole: false });
});

Deno.test("serviceRoleCallerUserId validates UUID user_id in JSON body for service-role bearer", async () => {
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "srv-key");
  try {
    const validReq = new Request("https://postora.test/fn", {
      method: "POST",
      headers: {
        Authorization: "Bearer srv-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ user_id: VALID_UUID }),
    });
    assertEquals(await serviceRoleCallerUserId(validReq), VALID_UUID);

    const invalidReq = new Request("https://postora.test/fn", {
      method: "POST",
      headers: {
        Authorization: "Bearer srv-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ user_id: "invalid-user" }),
    });
    await assertRejects(
      () => serviceRoleCallerUserId(invalidReq),
      Error,
      "Service-role call requires a valid UUID user_id in request body",
    );
  } finally {
    Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
  }
});
