import { assert, assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { anonKey, integrationTest, supabaseUrl } from "../_shared/integrationTestGuard.ts";
import { YOUTUBE_UPLOAD_REASON, youtubeUploadPublicMessage } from "./youtubeUploadPolicy.ts";

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

/**
 * The entrypoint, loaded with its port stubbed.
 *
 * The module binds a port when it is loaded, so the stub is what lets a test
 * reach the code inside it. The query keeps this a module of its own, so the
 * other process-post tests keep theirs.
 */
async function loadProcessPost(): Promise<typeof import("./index.ts")> {
  const previousServe = Deno.serve;
  Deno.serve = ((_registered: (request: Request) => Response | Promise<Response>) => ({
    finished: Promise.resolve(),
    shutdown: () => Promise.resolve(),
  })) as typeof Deno.serve;
  try {
    return (await import("./index.ts?process-post-unit-test")) as typeof import("./index.ts");
  } finally {
    Deno.serve = previousServe;
  }
}

Deno.test("a terminal failure never promises a check that is not coming", async () => {
  const { youtubeContinuationResponse } = await loadProcessPost();
  const response = youtubeContinuationResponse({
    status: "failed",
    reason: YOUTUBE_UPLOAD_REASON.unknown,
  });

  assertEquals(response.status, 500);
  const body = await response.json();
  // The session was released for good, so the answer is the reconcile one.
  assertEquals(body.error, youtubeUploadPublicMessage(YOUTUBE_UPLOAD_REASON.reconcile));
  // The reason code is the one the caller matches on, and it is unchanged.
  assertEquals(body.reason, YOUTUBE_UPLOAD_REASON.unknown);
  assert(!JSON.stringify(body).includes("checked again shortly"));
});

Deno.test("a refusal still answers 503 with its own message", async () => {
  const { youtubeContinuationResponse } = await loadProcessPost();
  const response = youtubeContinuationResponse({
    status: "refused",
    reason: YOUTUBE_UPLOAD_REASON.lease_conflict,
  });

  // A refusal is safe to repeat: the next reconciler pass looks again.
  assertEquals(response.status, 503);
  const body = await response.json();
  assertEquals(body.error, youtubeUploadPublicMessage(YOUTUBE_UPLOAD_REASON.lease_conflict));
  assertEquals(body.reason, YOUTUBE_UPLOAD_REASON.lease_conflict);
});

Deno.test("a reopened session keeps the pending row of its first admission", async () => {
  const { openYoutubeUploadSession } = await loadProcessPost();
  const admits: Array<string | null> = ["first-row", null];
  const claims: Array<string | null> = ["session_expired", null];
  let admitRound = 0;
  let claimRound = 0;
  const store = {
    async admit() {
      const platformPostId = admits[admitRound++] ?? null;
      return { record: { id: "session-1" }, refused: null, platformPostId };
    },
    async claim() {
      const refused = claims[claimRound++] ?? null;
      return { record: refused ? null : { id: "session-1" }, refused };
    },
  };

  const opened = await openYoutubeUploadSession(
    store as never,
    {} as never,
    "lease-token",
    60_000,
  );

  // The second admission carried no row id, and the row the upload settles is
  // still the row the first admission created.
  assertEquals(opened.platformPostId, "first-row");
  assertEquals(opened.refused, null);
  assertEquals(admitRound, 2);
  assertEquals(claimRound, 2);
});

Deno.test("a claim that throws after the admission hands the row to the recovery", async () => {
  const { openYoutubeUploadSession } = await loadProcessPost();
  const store = {
    async admit() {
      return { record: { id: "session-1" }, refused: null, platformPostId: "first-row" };
    },
    async claim() {
      throw new Error("transport lost the claim answer");
    },
  };

  let thrown: unknown;
  try {
    await openYoutubeUploadSession(store as never, {} as never, "lease-token", 60_000);
  } catch (error) {
    thrown = error;
  }

  // The row the admission created is named, so the generic failure writer
  // records nothing beside it and the scope keeps the destination.
  assert(thrown instanceof Error);
  assertEquals((thrown as { platformPostId?: string | null }).platformPostId, "first-row");
  assertEquals((thrown as { selfWroteRows?: boolean }).selfWroteRows, true);
});

Deno.test("a claim that throws before any row exists carries no row id", async () => {
  const { openYoutubeUploadSession } = await loadProcessPost();
  const store = {
    async admit() {
      return { record: { id: "session-1" }, refused: null, platformPostId: null };
    },
    async claim() {
      throw new Error("transport lost the claim answer");
    },
  };

  let thrown: unknown;
  try {
    await openYoutubeUploadSession(store as never, {} as never, "lease-token", 60_000);
  } catch (error) {
    thrown = error;
  }

  // Nothing was admitted, so there is no owned row to preserve: the original
  // error travels unchanged.
  assert(thrown instanceof Error);
  assertEquals((thrown as Error).message, "transport lost the claim answer");
  assertEquals((thrown as { platformPostId?: string | null }).platformPostId, undefined);
});

Deno.test("a scheduled YouTube post settles as private and carries its schedule", async () => {
  const { youtubeSettlementEvidence } = await loadProcessPost();
  const publishAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const evidence = youtubeSettlementEvidence({
    youtube_visibility: "public",
    youtube_publish_at: publishAt,
  });

  // The post asked for public, and the video was uploaded private: YouTube
  // makes it public at the scheduled time.
  assertEquals(evidence.requested_privacy, "private");
  assertEquals(evidence.scheduled, true);
  assertEquals(evidence.schedule_warning, null);
  assertEquals(evidence.requested_publish_at, publishAt);
});
