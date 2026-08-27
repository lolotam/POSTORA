import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { anonKey, integrationTest, supabaseUrl } from "../_shared/integrationTestGuard.ts";

const FUNCTION_URL = `${supabaseUrl}/functions/v1/check-connection-health`;
const ANON_KEY = anonKey;
const CALLER_JWT = Deno.env.get("CALLER_JWT");
const OWNED_ACCOUNT_ID = Deno.env.get("OWNED_ACCOUNT_ID");
const FOREIGN_ACCOUNT_ID = Deno.env.get("FOREIGN_ACCOUNT_ID");

integrationTest("check-connection-health: handles CORS preflight request", async () => {
  const response = await fetch(FUNCTION_URL, {
    method: "OPTIONS",
    headers: {
      "apikey": ANON_KEY,
    },
  });

  assertEquals(response.status, 200);
  const corsHeader = response.headers.get("Access-Control-Allow-Origin");
  assertEquals(corsHeader, "*");
});

integrationTest("check-connection-health: rejects unsupported methods", async () => {
  const response = await fetch(FUNCTION_URL, {
    method: "GET",
    headers: {
      "apikey": ANON_KEY,
    },
  });

  assertEquals(response.status, 405);
});

integrationTest("check-connection-health: returns 401 when Authorization header is missing", async () => {
  const response = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": ANON_KEY,
    },
    body: JSON.stringify({ account_id: "00000000-0000-0000-0000-000000000000", action: "test" }),
  });

  assertEquals(response.status, 401);
  const body = await response.json();
  assertExists(body.error);
});

integrationTest("check-connection-health: returns 401 when bearer token is empty", async () => {
  const response = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": ANON_KEY,
      "Authorization": "Bearer ",
    },
    body: JSON.stringify({ account_id: "00000000-0000-0000-0000-000000000000", action: "test" }),
  });

  assertEquals(response.status, 401);
  const body = await response.json();
  assertExists(body.error);
});

integrationTest("check-connection-health: returns 401 for invalid token", async () => {
  const response = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": ANON_KEY,
      "Authorization": "Bearer not-a-real-jwt",
    },
    body: JSON.stringify({ account_id: "00000000-0000-0000-0000-000000000000", action: "test" }),
  });

  assertEquals(response.status, 401);
  const body = await response.json();
  assertExists(body.error);
});

if (CALLER_JWT) {
  integrationTest("check-connection-health: returns 400 when account_id is missing", async () => {
    const response = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": ANON_KEY,
        "Authorization": `Bearer ${CALLER_JWT}`,
      },
      body: JSON.stringify({ action: "test" }),
    });

    assertEquals(response.status, 400);
    const body = await response.json();
    assertExists(body.error);
  });
}

if (CALLER_JWT && OWNED_ACCOUNT_ID && FOREIGN_ACCOUNT_ID) {
  integrationTest("check-connection-health: rejects account_id not owned by caller", async () => {
    const headers = {
      "Content-Type": "application/json",
      "apikey": ANON_KEY,
      "Authorization": `Bearer ${CALLER_JWT}`,
    };

    const response = await fetch(FUNCTION_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ account_id: FOREIGN_ACCOUNT_ID, action: "test" }),
    });

    const randomAccountResponse = await fetch(FUNCTION_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        account_id: "00000000-0000-0000-0000-000000000000",
        action: "test",
      }),
    });

    assertEquals(response.status, 403);
    assertEquals(randomAccountResponse.status, 403);

    const body = await response.json();
    const randomAccountBody = await randomAccountResponse.json();
    assertEquals(body.error, randomAccountBody.error);
    assertEquals(typeof body.error, "string");
    assertEquals(body.error.length <= 64, true);
    assertEquals(JSON.stringify(body).includes(FOREIGN_ACCOUNT_ID), false);
  });

  integrationTest("check-connection-health: allows owned account_id", async () => {
    const response = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": ANON_KEY,
        "Authorization": `Bearer ${CALLER_JWT}`,
      },
      body: JSON.stringify({ account_id: OWNED_ACCOUNT_ID, action: "status" }),
    });

    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.success, true);
    assertExists(body.tokenStatus);
  });
}
