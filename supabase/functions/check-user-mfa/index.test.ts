import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { anonKey, integrationTest, supabaseUrl } from "../_shared/integrationTestGuard.ts";

const FUNCTION_URL = `${supabaseUrl}/functions/v1/check-user-mfa`;
const ANON_KEY = anonKey;

integrationTest("check-user-mfa: handles CORS preflight request", async () => {
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

integrationTest("check-user-mfa: rejects unsupported methods", async () => {
  const response = await fetch(FUNCTION_URL, {
    method: "GET",
    headers: {
      "apikey": ANON_KEY,
    },
  });

  assertEquals(response.status, 405);
});

integrationTest("check-user-mfa: returns 400 when email is missing", async () => {
  const response = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": ANON_KEY,
    },
    body: JSON.stringify({}),
  });

  assertEquals(response.status, 400);
  const body = await response.json();
  assertExists(body.error);
  assertEquals(body.error, "Email is required");
});

integrationTest("check-user-mfa: does not reveal userExists", async () => {
  const response = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": ANON_KEY,
    },
    body: JSON.stringify({ email: "definitely-not-a-real-user-xyz@example.invalid" }),
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(Object.prototype.hasOwnProperty.call(body, "userExists"), false);
});

integrationTest("check-user-mfa: does not return factorId", async () => {
  const response = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": ANON_KEY,
    },
    body: JSON.stringify({ email: "another-fake-user@example.invalid" }),
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(Object.prototype.hasOwnProperty.call(body, "factorId"), false);
});

integrationTest("check-user-mfa: returns constant hasMFA false regardless of email", async () => {
  const headers = {
    "Content-Type": "application/json",
    "apikey": ANON_KEY,
  };

  const plausibleResponse = await fetch(FUNCTION_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "user@example.com" }),
  });
  const fakeResponse = await fetch(FUNCTION_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "definitely-not-a-real-user-xyz@example.invalid" }),
  });

  assertEquals(plausibleResponse.status, 200);
  assertEquals(fakeResponse.status, 200);
  assertEquals(await plausibleResponse.json(), { hasMFA: false });
  assertEquals(await fakeResponse.json(), { hasMFA: false });
});

integrationTest("check-user-mfa: returns 400 for malformed JSON body", async () => {
  const response = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": ANON_KEY,
    },
    body: "{ not json",
  });

  assertEquals(response.status, 400);
  const body = await response.json();
  assertExists(body.error);
  assertEquals(body.error, "Email is required");
});
