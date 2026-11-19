import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  createYouTubeOAuthHandler,
  type YouTubeAccountSave,
  type YouTubeOAuthPorts,
} from "./handler.ts";

const USER_ID = "0ee00001-0000-4000-8000-000000000001";
const OTHER_USER_ID = "0ee00002-0000-4000-8000-000000000002";
const PROFILE_ID = "0ee10001-0000-4000-8000-000000000011";
const FOREIGN_PROFILE_ID = "0ee10002-0000-4000-8000-000000000012";
const RETURN_TO = "https://postora.cloud/profiles";
const REDIRECT_URI = "https://api.postora.cloud/functions/v1/youtube-oauth";

function opaqueValue(): string {
  return crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
}

function post(body: unknown): Request {
  return new Request(REDIRECT_URI, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(code: string, state: string, returnTo?: string): Request {
  const url = new URL(REDIRECT_URI);
  url.searchParams.set("code", code);
  url.searchParams.set("state", state);
  if (returnTo) url.searchParams.set("return_to", returnTo);
  return new Request(url);
}

function fixture(overrides: {
  authenticated?: boolean;
  attemptUserId?: string;
  consumeResult?: { ok: false; reason: string };
  accountError?: boolean;
} = {}) {
  const state = opaqueValue();
  const authorizationCode = opaqueValue();
  const accessToken = opaqueValue();
  const storedRefreshToken = opaqueValue();
  const calls = { auth: 0, create: 0, consume: 0, google: 0, save: 0, defaultProfile: 0 };
  const logs: Array<{ action: string; reason: string; userId: string | null }> = [];
  const saved: YouTubeAccountSave[] = [];
  const account: { refreshToken: string | null; metadata: Record<string, unknown> } = {
    refreshToken: storedRefreshToken,
    metadata: { unrelated: { retained: true }, granted_scopes: ["scope.one"] },
  };

  const ports: YouTubeOAuthPorts = {
    auth: {
      authenticate: () => {
        calls.auth++;
        if (overrides.authenticated === false) return Promise.reject(new Error("unauthorized"));
        return Promise.resolve({ userId: USER_ID });
      },
    },
    attempts: {
      create: (input) => {
        calls.create++;
        if (input.socialProfileId === FOREIGN_PROFILE_ID) {
          return Promise.reject(Object.assign(new Error("refused"), { code: "YOA02" }));
        }
        return Promise.resolve({ nonce: state });
      },
      consume: (_nonce) => {
        calls.consume++;
        if (overrides.consumeResult) return Promise.resolve(overrides.consumeResult);
        return Promise.resolve({
          ok: true as const,
          userId: overrides.attemptUserId ?? USER_ID,
          socialProfileId: PROFILE_ID,
          returnTo: RETURN_TO,
        });
      },
    },
    google: {
      complete: () => {
        calls.google++;
        return Promise.resolve({
          accessToken,
          expiresIn: 3600,
          scope: "scope.one",
          channel: { id: "synthetic-channel", title: "Synthetic channel", avatarUrl: null },
        });
      },
    },
    accounts: {
      findDefaultProfile: () => {
        calls.defaultProfile++;
        return Promise.resolve(PROFILE_ID);
      },
      save: (input) => {
        calls.save++;
        if (overrides.accountError) return Promise.reject(new Error("database unavailable"));
        saved.push(input);
        if (Object.hasOwn(input, "refreshToken")) account.refreshToken = input.refreshToken ?? null;
        return Promise.resolve();
      },
    },
    clock: { now: () => new Date("2026-11-19T12:00:00.000Z") },
    log: {
      refusal: (entry) => {
        logs.push(entry);
        return Promise.resolve();
      },
    },
  };

  const handler = createYouTubeOAuthHandler(ports, {
    clientId: "synthetic-client",
    redirectUri: REDIRECT_URI,
    trustedAppOrigin: "http://127.0.0.1:8080",
  });

  return { handler, ports, calls, logs, saved, account, state, authorizationCode, accessToken, storedRefreshToken };
}

Deno.test("unauthenticated authorize is refused before attempts, credentials, or Google", async () => {
  const f = fixture({ authenticated: false });
  const response = await f.handler(post({
    action: "authorize",
    social_profile_id: PROFILE_ID,
    return_to: RETURN_TO,
  }));

  assertEquals(response.status, 401);
  assertEquals(await response.json(), { error: "Unauthorized" });
  assertEquals(f.calls.create, 0);
  assertEquals(f.calls.google, 0);
  assertEquals(f.calls.save, 0);
  assertEquals(f.logs.length, 1);
});

Deno.test("authorize refuses a profile owned by another user", async () => {
  const f = fixture();
  const response = await f.handler(post({
    action: "authorize",
    social_profile_id: FOREIGN_PROFILE_ID,
    return_to: RETURN_TO,
  }));

  assertEquals(response.status, 403);
  assertEquals(await response.json(), { error: "profile_not_owned" });
  assertEquals(f.calls.google, 0);
  assertEquals(f.logs, [{ action: "authorize", reason: "profile_not_owned", userId: USER_ID }]);
});

Deno.test("authorize refuses a return URL outside approved origins", async () => {
  const f = fixture();
  const response = await f.handler(post({
    action: "authorize",
    social_profile_id: PROFILE_ID,
    return_to: "https://postora.cloud.example.invalid/profiles",
  }));

  assertEquals(response.status, 400);
  assertEquals(await response.json(), { error: "invalid_return_to" });
  assertEquals(f.calls.create, 0);
  assertEquals(f.calls.google, 0);
  assertEquals(f.logs.length, 1);
});

Deno.test("authorize stores the validated return URL and uses only the opaque nonce as state", async () => {
  const f = fixture();
  const response = await f.handler(post({
    action: "authorize",
    social_profile_id: PROFILE_ID,
    return_to: RETURN_TO,
  }));
  const body = await response.json();
  const state = new URL(body.url).searchParams.get("state");

  assertEquals(response.status, 200);
  assertEquals(body.redirect_uri, REDIRECT_URI);
  assert(state === f.state);
  assert(!state?.includes("."));
  assertEquals(f.calls.create, 1);
});

Deno.test("authorize resolves an omitted profile and reports when none exists", async () => {
  const f = fixture();
  const response = await f.handler(post({ action: "authorize", return_to: RETURN_TO }));

  assertEquals(response.status, 200);
  await response.body?.cancel();
  assertEquals(f.calls.defaultProfile, 1);

  f.ports.accounts.findDefaultProfile = () => Promise.resolve(null);
  const missing = await f.handler(post({ action: "authorize", return_to: RETURN_TO }));
  assertEquals(missing.status, 400);
  assertEquals(await missing.json(), { error: "profile_required" });
});

for (const reason of ["already_consumed", "expired"] as const) {
  Deno.test(`GET callback refuses ${reason} state before Google`, async () => {
    const f = fixture({ consumeResult: { ok: false, reason } });
    const response = await f.handler(get(f.authorizationCode, f.state));

    assertEquals(response.status, 400);
    assertEquals(await response.json(), { error: reason });
    assertEquals(f.calls.google, 0);
    assertEquals(f.calls.save, 0);
    assertEquals(f.logs, [{ action: "callback", reason, userId: null }]);
  });
}

Deno.test("legacy signed JSON state has no acceptance path", async () => {
  const legacyState = `${btoa(JSON.stringify({ user_id: USER_ID, return_to: RETURN_TO }))}.signature`;
  const f = fixture({ consumeResult: { ok: false, reason: "not_found" } });
  const response = await f.handler(get(f.authorizationCode, legacyState));

  assertEquals(response.status, 400);
  assertEquals(await response.json(), { error: "not_found" });
  assertEquals(f.calls.consume, 1);
  assertEquals(f.calls.google, 0);
});

Deno.test("GET callback redirects only to the attempt's stored return URL", async () => {
  const f = fixture();
  const response = await f.handler(get(
    f.authorizationCode,
    f.state,
    "https://attacker.example.invalid/steal",
  ));

  assertEquals(response.status, 302);
  const location = new URL(response.headers.get("location")!);
  assertEquals(location.origin, new URL(RETURN_TO).origin);
  assertEquals(location.pathname, "/profiles");
  assertEquals(location.searchParams.get("connected"), "youtube");
  assertEquals(location.searchParams.get("profile_id"), PROFILE_ID);
  assertEquals(location.searchParams.get("channel"), "Synthetic channel");
  assertEquals(f.calls.save, 1);
});

Deno.test("POST callback requires the attempt owner", async () => {
  const f = fixture({ attemptUserId: OTHER_USER_ID });
  const response = await f.handler(post({
    action: "callback",
    code: f.authorizationCode,
    state: f.state,
    social_profile_id: PROFILE_ID,
  }));

  assertEquals(response.status, 403);
  assertEquals(await response.json(), { error: "owner_mismatch" });
  assertEquals(f.calls.google, 0);
  assertEquals(f.calls.save, 0);
  assertEquals(f.logs.length, 1);
});

Deno.test("refresh action is removed", async () => {
  const f = fixture();
  const response = await f.handler(post({ action: "refresh", account_id: crypto.randomUUID() }));

  assertEquals(response.status, 400);
  assertEquals(await response.json(), { error: "Invalid action" });
  assertEquals(f.calls.auth, 0);
  assertEquals(f.calls.google, 0);
  assertEquals(f.calls.save, 0);
  assertEquals(f.logs.length, 1);
});

Deno.test("re-consent without a new refresh token preserves credentials and unrelated metadata", async () => {
  const f = fixture();
  const response = await f.handler(post({
    action: "callback",
    code: f.authorizationCode,
    state: f.state,
  }));

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { success: true, username: "Synthetic channel" });
  assertEquals(f.account.refreshToken, f.storedRefreshToken);
  assertEquals(f.account.metadata, {
    unrelated: { retained: true },
    granted_scopes: ["scope.one"],
  });
  assert(!Object.hasOwn(f.saved[0], "refreshToken"));
  assert(!Object.hasOwn(f.saved[0], "accountMetadata"));
});

Deno.test("an account database error fails closed with a sanitized response", async () => {
  const f = fixture({ accountError: true });
  const response = await f.handler(post({
    action: "callback",
    code: f.authorizationCode,
    state: f.state,
  }));
  const text = await response.text();

  assertEquals(response.status, 500);
  assertEquals(JSON.parse(text), { error: "Authentication failed. Please try again." });
  assert(!text.includes(f.accessToken));
  assert(!text.includes(f.storedRefreshToken));
  assertEquals(f.logs, [{ action: "callback", reason: "account_save_failed", userId: USER_ID }]);
});
