import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { anonKey, integrationTest, supabaseUrl } from "../_shared/integrationTestGuard.ts";

const FUNCTION_URL = `${supabaseUrl}/functions/v1/process-post`;
const ANON_KEY = anonKey;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

integrationTest("process-post: handles CORS preflight request", async () => {
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

integrationTest("process-post: returns 400 when post_id is missing", async () => {
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
  assertEquals(body.error, "Missing post_id");
});

integrationTest("process-post: returns 401 when Authorization header is missing", async () => {
  const response = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": ANON_KEY,
    },
    body: JSON.stringify({ post_id: "test-post-id" }),
  });

  assertEquals(response.status, 401);
  const body = await response.json();
  assertExists(body.error);
  assertEquals(body.error, "Unauthorized: missing Authorization header");
});

integrationTest("process-post: returns 401 when bearer token is empty", async () => {
  const response = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": ANON_KEY,
      "Authorization": "Bearer ",
    },
    body: JSON.stringify({ post_id: "test-post-id" }),
  });

  // "Bearer " without token is treated as missing auth header
  assertEquals(response.status, 401);
  const body = await response.json();
  assertExists(body.error);
});

integrationTest("process-post: returns 401 for invalid/expired token", async () => {
  const invalidToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwiZXhwIjoxfQ.invalid";

  const response = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": ANON_KEY,
      "Authorization": `Bearer ${invalidToken}`,
    },
    body: JSON.stringify({ post_id: "test-post-id" }),
  });

  assertEquals(response.status, 401);
  const body = await response.json();
  assertExists(body.error);
  assertEquals(body.error, "Unauthorized: invalid token");
});

integrationTest("process-post: handles invalid JSON body", async () => {
  const response = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": ANON_KEY,
    },
    body: "not valid json",
  });

  // Should return 500 for parse error
  assertEquals(response.status, 500);
  const body = await response.json();
  assertExists(body.error);
});

integrationTest("process-post: accepts service role key for server-to-server calls", async () => {
  if (!SERVICE_ROLE_KEY) {
    console.log("Skipping service role test - key not available");
    return;
  }

  const response = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": ANON_KEY,
      "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ post_id: "00000000-0000-0000-0000-000000000000" }),
  });

  // Should return 404 (post not found) not 401 (auth error)
  // This proves service role auth works
  assertEquals(response.status, 404);
  const body = await response.json();
  assertEquals(body.error, "Post not found");
});

integrationTest("process-post: returns 404 for non-existent post with valid auth", async () => {
  if (!SERVICE_ROLE_KEY) {
    console.log("Skipping - service role key not available");
    return;
  }

  const response = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": ANON_KEY,
      "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ post_id: "00000000-0000-0000-0000-000000000000" }),
  });

  assertEquals(response.status, 404);
  const body = await response.json();
  assertEquals(body.error, "Post not found");
});
