import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  refreshFacebookToken,
  refreshInstagramBusinessToken,
  refreshThreadsToken,
  type SocialAccount,
} from "./social-auth.ts";

const account: SocialAccount = {
  id: "a1", platform: "facebook", access_token: "SECRET_TOKEN",
  refresh_token: null, token_expires_at: null, platform_user_id: "p1", user_id: "u1",
};

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init))) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

/** Capture console.error as strings so tests can prove a live token never reaches a log. */
function captureConsoleError(): { logs: string[]; restore: () => void } {
  const original = console.error;
  const logs: string[] = [];
  console.error = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };
  return { logs, restore: () => { console.error = original; } };
}

function successResponse(): Response {
  return new Response(JSON.stringify({ access_token: "new", expires_in: 5184000 }), { status: 200 });
}

Deno.test("the Facebook credential travels in the POST body, never the URL", async () => {
  let seenUrl = ""; let seenBody = ""; let seenMethod = "";
  const restore = stubFetch((url, init) => {
    seenUrl = url; seenBody = String(init?.body); seenMethod = String(init?.method);
    return successResponse();
  });
  try {
    const outcome = await refreshFacebookToken(account);
    assertEquals(outcome.ok, true);
    assertEquals(seenUrl.includes("SECRET_TOKEN"), false);
    assertEquals(seenBody.includes("SECRET_TOKEN"), true);
    assertEquals(seenMethod, "POST");
  } finally { restore(); }
});

Deno.test("a revoked Facebook token comes back as a permanent structured error", async () => {
  const restore = stubFetch(() =>
    new Response(JSON.stringify({
      error: { type: "OAuthException", code: 190, error_subcode: 463, message: "Session expired" },
    }), { status: 400 }));
  try {
    const outcome = await refreshFacebookToken(account);
    assertEquals(outcome.ok, false);
    if (!outcome.ok) {
      assertEquals(outcome.error.code, 190);
      assertEquals(outcome.error.error_subcode, 463);
      assertEquals(outcome.error.transient, false);
    }
  } finally { restore(); }
});

Deno.test("a Facebook 200 with no access_token is a failure, not a success", async () => {
  const restore = stubFetch(() => new Response(JSON.stringify({ unexpected: true }), { status: 200 }));
  try {
    assertEquals((await refreshFacebookToken(account)).ok, false);
  } finally { restore(); }
});

Deno.test("a Facebook network failure is transient and never leaks the token into a log", async () => {
  // The rejection message embeds the credential exactly the way Deno does for network
  // errors. The catch must classify it transient AND log only error.name — anything
  // else writes a live token to the logs.
  const restore = stubFetch(() => {
    throw new TypeError("error sending request for url (https://x?access_token=SECRET_TOKEN)");
  });
  const captured = captureConsoleError();
  try {
    const outcome = await refreshFacebookToken(account);
    assertEquals(outcome.ok, false);
    if (!outcome.ok) assertEquals(outcome.error.transient, true);
    for (const line of captured.logs) {
      assertEquals(line.includes("SECRET_TOKEN"), false, `log leaked the credential: ${line}`);
    }
  } finally {
    captured.restore();
    restore();
  }
});

Deno.test("a Facebook timeout surfaces as a transient TimeoutError outcome", async () => {
  const restore = stubFetch(() => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });
  try {
    const outcome = await refreshFacebookToken(account);
    assertEquals(outcome.ok, false);
    if (!outcome.ok) {
      assertEquals(outcome.error.type, "TimeoutError");
      assertEquals(outcome.error.transient, true);
    }
  } finally { restore(); }
});

// Instagram and Threads STAY ON GET: verified against the live API with real tokens,
// graph.instagram.com answers "Unsupported post request" to POST, and Threads is
// unproven. These tests exist so a future well-meaning migration trips a test rather
// than production (see the 2026-08-29 Meta refresh hardening spec §3).

Deno.test("Instagram Business refresh stays a GET against graph.instagram.com", async () => {
  let seenUrl = ""; let seenMethod = "(none)";
  const igAccount: SocialAccount = { ...account, platform: "instagram" };
  const restore = stubFetch((url, init) => {
    seenUrl = url; seenMethod = String(init?.method ?? "(none)");
    return successResponse();
  });
  try {
    const outcome = await refreshInstagramBusinessToken(igAccount);
    assertEquals(outcome.ok, true);
    assertEquals(seenUrl.startsWith("https://graph.instagram.com/refresh_access_token"), true);
    assertEquals(seenMethod, "(none)");
  } finally { restore(); }
});

Deno.test("a revoked Instagram token comes back as a permanent structured error", async () => {
  const restore = stubFetch(() =>
    new Response(JSON.stringify({
      error: { type: "OAuthException", code: 190, error_subcode: 463, message: "Session expired" },
    }), { status: 400 }));
  try {
    const outcome = await refreshInstagramBusinessToken({ ...account, platform: "instagram" });
    assertEquals(outcome.ok, false);
    if (!outcome.ok) {
      assertEquals(outcome.error.code, 190);
      assertEquals(outcome.error.transient, false);
    }
  } finally { restore(); }
});

Deno.test("an Instagram network failure is transient and never leaks the token into a log", async () => {
  // For Instagram the sanitized catch is LOAD-BEARING, not defence in depth: the
  // credential is still in the URL, and Deno embeds the URL in network errors.
  const restore = stubFetch(() => {
    throw new TypeError("error sending request for url (https://graph.instagram.com/refresh_access_token?access_token=SECRET_TOKEN)");
  });
  const captured = captureConsoleError();
  try {
    const outcome = await refreshInstagramBusinessToken({ ...account, platform: "instagram" });
    assertEquals(outcome.ok, false);
    if (!outcome.ok) assertEquals(outcome.error.transient, true);
    for (const line of captured.logs) {
      assertEquals(line.includes("SECRET_TOKEN"), false, `log leaked the credential: ${line}`);
    }
  } finally {
    captured.restore();
    restore();
  }
});

Deno.test("an Instagram 200 with no access_token is a failure, not a success", async () => {
  const restore = stubFetch(() => new Response(JSON.stringify({ unexpected: true }), { status: 200 }));
  try {
    assertEquals((await refreshInstagramBusinessToken({ ...account, platform: "instagram" })).ok, false);
  } finally { restore(); }
});

Deno.test("Threads refresh stays a GET against graph.threads.net", async () => {
  let seenUrl = ""; let seenMethod = "(none)";
  const restore = stubFetch((url, init) => {
    seenUrl = url; seenMethod = String(init?.method ?? "(none)");
    return successResponse();
  });
  try {
    const outcome = await refreshThreadsToken({ ...account, platform: "threads" });
    assertEquals(outcome.ok, true);
    assertEquals(seenUrl.startsWith("https://graph.threads.net/refresh_access_token"), true);
    assertEquals(seenMethod, "(none)");
  } finally { restore(); }
});

Deno.test("a revoked Threads token comes back as a permanent structured error", async () => {
  const restore = stubFetch(() =>
    new Response(JSON.stringify({
      error: { type: "OAuthException", code: 190, error_subcode: 463, message: "Session expired" },
    }), { status: 400 }));
  try {
    const outcome = await refreshThreadsToken({ ...account, platform: "threads" });
    assertEquals(outcome.ok, false);
    if (!outcome.ok) {
      assertEquals(outcome.error.code, 190);
      assertEquals(outcome.error.transient, false);
    }
  } finally { restore(); }
});

Deno.test("a Threads network failure is transient and never leaks the token into a log", async () => {
  const restore = stubFetch(() => {
    throw new TypeError("error sending request for url (https://graph.threads.net/refresh_access_token?access_token=SECRET_TOKEN)");
  });
  const captured = captureConsoleError();
  try {
    const outcome = await refreshThreadsToken({ ...account, platform: "threads" });
    assertEquals(outcome.ok, false);
    if (!outcome.ok) assertEquals(outcome.error.transient, true);
    for (const line of captured.logs) {
      assertEquals(line.includes("SECRET_TOKEN"), false, `log leaked the credential: ${line}`);
    }
  } finally {
    captured.restore();
    restore();
  }
});
