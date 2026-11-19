import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  createYouTubeOAuthHandler,
  type GoogleRevokeResult,
  type YouTubeAccountSave,
  type YouTubeDisconnectAccount,
  type YouTubeOAuthPorts,
} from "./handler.ts";
import { revokeGoogleToken } from "./revoke.ts";

const USER_ID = "0ee00001-0000-4000-8000-000000000001";
const OTHER_USER_ID = "0ee00002-0000-4000-8000-000000000002";
const PROFILE_ID = "0ee10001-0000-4000-8000-000000000011";
const FOREIGN_PROFILE_ID = "0ee10002-0000-4000-8000-000000000012";
const ACCOUNT_ID = "0ee20001-0000-4000-8000-000000000021";
const FOREIGN_ACCOUNT_ID = "0ee20002-0000-4000-8000-000000000022";
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
  disconnectAccount?: Partial<YouTubeDisconnectAccount> | null;
  loadError?: boolean;
  activeSharingGrantCount?: number;
  countGrantError?: boolean;
  revokeResult?: GoogleRevokeResult;
  revokeThrows?: boolean;
  clearError?: boolean;
  clearConflict?: boolean;
} = {}) {
  const state = opaqueValue();
  const authorizationCode = opaqueValue();
  const accessToken = opaqueValue();
  const storedRefreshToken = opaqueValue();
  const calls = {
    auth: 0,
    create: 0,
    consume: 0,
    google: 0,
    revoke: 0,
    save: 0,
    defaultProfile: 0,
    load: 0,
    countOtherActiveNativeAccounts: 0,
    clearCredentials: 0,
  };
  const order: string[] = [];
  const revokedTokens: string[] = [];
  const logs: Array<{ action: string; reason: string; userId: string | null }> = [];
  const saved: YouTubeAccountSave[] = [];
  const account: {
    accessToken: string | null;
    refreshToken: string | null;
    isActive: boolean;
    metadata: Record<string, unknown>;
  } = {
    accessToken,
    refreshToken: storedRefreshToken,
    isActive: true,
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
      revoke: (token) => {
        calls.revoke++;
        order.push("revoke");
        revokedTokens.push(token);
        if (overrides.revokeThrows) return Promise.reject(new Error("network timeout"));
        return Promise.resolve(overrides.revokeResult ?? { ok: true, alreadyInvalid: false });
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
      load: ({ accountId, userId }) => {
        calls.load++;
        if (overrides.loadError) return Promise.reject(new Error("metadata read failed"));
        if (overrides.disconnectAccount === null) return Promise.resolve(null);
        if (accountId === FOREIGN_ACCOUNT_ID) return Promise.resolve(null);
        return Promise.resolve({
          id: accountId,
          userId,
          accessToken: account.accessToken,
          refreshToken: account.refreshToken,
          isActive: account.isActive,
          accountMetadata: account.metadata,
          updatedAt: "2026-11-19T11:00:00.000Z",
          ...overrides.disconnectAccount,
        });
      },
      countOtherActiveNativeAccounts: () => {
        calls.countOtherActiveNativeAccounts++;
        if (overrides.countGrantError) return Promise.reject(new Error("grant count failed"));
        return Promise.resolve(overrides.activeSharingGrantCount ?? 0);
      },
      clearCredentials: (input) => {
        calls.clearCredentials++;
        order.push("clearCredentials");
        if (overrides.clearError) return Promise.reject(new Error("metadata write failed"));
        if (overrides.clearConflict) {
          return Promise.reject(Object.assign(new Error("account_changed"), { code: "account_changed" }));
        }
        account.accessToken = null;
        account.refreshToken = null;
        account.isActive = false;
        account.metadata = input.accountMetadata;
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

  return {
    handler,
    ports,
    calls,
    order,
    revokedTokens,
    logs,
    saved,
    account,
    state,
    authorizationCode,
    accessToken,
    storedRefreshToken,
  };
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

Deno.test("unauthenticated disconnect is refused before loading accounts or calling Google", async () => {
  const f = fixture({ authenticated: false });
  const response = await f.handler(post({ action: "disconnect", account_id: ACCOUNT_ID }));

  assertEquals(response.status, 401);
  assertEquals(await response.json(), { error: "Unauthorized" });
  assertEquals(f.calls.load, 0);
  assertEquals(f.calls.countOtherActiveNativeAccounts, 0);
  assertEquals(f.calls.revoke, 0);
  assertEquals(f.calls.clearCredentials, 0);
  assertEquals(f.logs, [{ action: "disconnect", reason: "Unauthorized", userId: null }]);
});

Deno.test("disconnect refuses a malformed account_id", async () => {
  const f = fixture();
  const response = await f.handler(post({ action: "disconnect", account_id: "not-a-uuid" }));

  assertEquals(response.status, 400);
  assertEquals(await response.json(), { error: "invalid_request" });
  assertEquals(f.calls.load, 0);
  assertEquals(f.calls.revoke, 0);
  assertEquals(f.calls.clearCredentials, 0);
  assertEquals(f.logs, [{ action: "disconnect", reason: "invalid_request", userId: USER_ID }]);
});

Deno.test("disconnect refuses another user's account with 404 and touches nothing", async () => {
  const f = fixture();
  const response = await f.handler(post({ action: "disconnect", account_id: FOREIGN_ACCOUNT_ID }));

  assertEquals(response.status, 404);
  assertEquals(await response.json(), { error: "account_not_found" });
  assertEquals(f.calls.load, 1);
  assertEquals(f.calls.countOtherActiveNativeAccounts, 0);
  assertEquals(f.calls.revoke, 0);
  assertEquals(f.calls.clearCredentials, 0);
  assertEquals(f.account.isActive, true);
  assertEquals(f.account.refreshToken, f.storedRefreshToken);
  assertEquals(f.logs, [{ action: "disconnect", reason: "account_not_found", userId: USER_ID }]);
});

Deno.test("disconnect refuses an account whose owner disagrees with the caller", async () => {
  const f = fixture({ disconnectAccount: { userId: OTHER_USER_ID } });
  const response = await f.handler(post({ action: "disconnect", account_id: ACCOUNT_ID }));

  assertEquals(response.status, 404);
  assertEquals(await response.json(), { error: "account_not_found" });
  assertEquals(f.calls.countOtherActiveNativeAccounts, 0);
  assertEquals(f.calls.revoke, 0);
  assertEquals(f.calls.clearCredentials, 0);
  assertEquals(f.logs, [{ action: "disconnect", reason: "account_not_found", userId: USER_ID }]);
});

Deno.test("disconnect revokes at Google then clears local credentials when last active user of grant", async () => {
  const f = fixture({ activeSharingGrantCount: 0 });
  const response = await f.handler(post({ action: "disconnect", account_id: ACCOUNT_ID }));
  const text = await response.text();

  assertEquals(response.status, 200);
  assertEquals(JSON.parse(text), { success: true, revoked: true, reason: null });
  assertEquals(f.calls.countOtherActiveNativeAccounts, 1);
  assertEquals(f.calls.revoke, 1);
  assertEquals(f.revokedTokens, [f.storedRefreshToken]);
  assertEquals(f.calls.clearCredentials, 1);
  assertEquals(f.order, ["revoke", "clearCredentials"]);
  assertEquals(f.account.accessToken, null);
  assertEquals(f.account.refreshToken, null);
  assertEquals(f.account.isActive, false);
  assertEquals(f.account.metadata, { unrelated: { retained: true } });
  assert(!text.includes(f.accessToken));
  assert(!text.includes(f.storedRefreshToken));
});

Deno.test("disconnect skips Google revoke when sibling channels share the active grant", async () => {
  const f = fixture({ activeSharingGrantCount: 1 });
  const response = await f.handler(post({ action: "disconnect", account_id: ACCOUNT_ID }));
  const text = await response.text();

  assertEquals(response.status, 200);
  assertEquals(JSON.parse(text), { success: true, revoked: false, reason: "grant_shared" });
  assertEquals(f.calls.countOtherActiveNativeAccounts, 1);
  assertEquals(f.calls.revoke, 0);
  assertEquals(f.calls.clearCredentials, 1);
  assertEquals(f.account.accessToken, null);
  assertEquals(f.account.refreshToken, null);
  assertEquals(f.account.isActive, false);
  assertEquals(f.account.metadata, { unrelated: { retained: true } });
  assert(!text.includes(f.accessToken));
  assert(!text.includes(f.storedRefreshToken));
});

Deno.test("disconnect with missing grant skips Google revoke and clears local credentials", async () => {
  const f = fixture({ disconnectAccount: { refreshToken: null } });
  const response = await f.handler(post({ action: "disconnect", account_id: ACCOUNT_ID }));
  const text = await response.text();

  assertEquals(response.status, 200);
  assertEquals(JSON.parse(text), { success: true, revoked: false, reason: "missing_grant" });
  assertEquals(f.calls.countOtherActiveNativeAccounts, 0);
  assertEquals(f.calls.revoke, 0);
  assertEquals(f.calls.clearCredentials, 1);
  assertEquals(f.account.accessToken, null);
  assertEquals(f.account.isActive, false);
  assert(!text.includes(f.accessToken));
});

Deno.test("disconnect treats Google invalid_grant / already invalid as already revoked and clears local credentials", async () => {
  const f = fixture({
    activeSharingGrantCount: 0,
    revokeResult: { ok: true, alreadyInvalid: true },
  });
  const response = await f.handler(post({ action: "disconnect", account_id: ACCOUNT_ID }));
  const text = await response.text();

  assertEquals(response.status, 200);
  assertEquals(JSON.parse(text), { success: true, revoked: true, reason: "already_invalid" });
  assertEquals(f.calls.revoke, 1);
  assertEquals(f.calls.clearCredentials, 1);
  assertEquals(f.account.accessToken, null);
  assertEquals(f.account.refreshToken, null);
  assertEquals(f.account.isActive, false);
  assert(!text.includes(f.accessToken));
  assert(!text.includes(f.storedRefreshToken));
});

Deno.test("disconnect aborts on Google 5xx and leaves local credentials untouched", async () => {
  const f = fixture({
    activeSharingGrantCount: 0,
    revokeResult: { ok: false, status: 503, reason: "google_revoke_failed" },
  });
  const response = await f.handler(post({ action: "disconnect", account_id: ACCOUNT_ID }));
  const text = await response.text();

  assertEquals(response.status, 502);
  assertEquals(JSON.parse(text), { error: "Failed to disconnect YouTube account. Please try again." });
  assertEquals(f.calls.revoke, 1);
  assertEquals(f.calls.clearCredentials, 0);
  assertEquals(f.account.accessToken, f.accessToken);
  assertEquals(f.account.refreshToken, f.storedRefreshToken);
  assertEquals(f.account.isActive, true);
  assertEquals(f.account.metadata, { unrelated: { retained: true }, granted_scopes: ["scope.one"] });
  assert(!text.includes(f.accessToken));
  assert(!text.includes(f.storedRefreshToken));
  assertEquals(f.logs, [{ action: "disconnect", reason: "google_revoke_failed", userId: USER_ID }]);
});

Deno.test("disconnect aborts on Google revoke network throw and leaves local credentials untouched", async () => {
  const f = fixture({ activeSharingGrantCount: 0, revokeThrows: true });
  const response = await f.handler(post({ action: "disconnect", account_id: ACCOUNT_ID }));
  const text = await response.text();

  assertEquals(response.status, 502);
  assertEquals(JSON.parse(text), { error: "Failed to disconnect YouTube account. Please try again." });
  assertEquals(f.calls.clearCredentials, 0);
  assertEquals(f.account.refreshToken, f.storedRefreshToken);
  assertEquals(f.account.isActive, true);
  assert(!text.includes(f.accessToken));
  assert(!text.includes(f.storedRefreshToken));
  assertEquals(f.logs, [{ action: "disconnect", reason: "google_revoke_failed", userId: USER_ID }]);
});

Deno.test("disconnect fails closed on account/metadata read failure", async () => {
  const f = fixture({ loadError: true });
  const response = await f.handler(post({ action: "disconnect", account_id: ACCOUNT_ID }));
  const text = await response.text();

  assertEquals(response.status, 500);
  assertEquals(JSON.parse(text), { error: "Failed to disconnect YouTube account. Please try again." });
  assertEquals(f.calls.countOtherActiveNativeAccounts, 0);
  assertEquals(f.calls.revoke, 0);
  assertEquals(f.calls.clearCredentials, 0);
  assert(!text.includes(f.accessToken));
  assert(!text.includes(f.storedRefreshToken));
  assertEquals(f.logs, [{ action: "disconnect", reason: "account_read_failed", userId: USER_ID }]);
});

Deno.test("disconnect fails closed on grant sharing count read failure", async () => {
  const f = fixture({ countGrantError: true });
  const response = await f.handler(post({ action: "disconnect", account_id: ACCOUNT_ID }));
  const text = await response.text();

  assertEquals(response.status, 500);
  assertEquals(JSON.parse(text), { error: "Failed to disconnect YouTube account. Please try again." });
  assertEquals(f.calls.revoke, 0);
  assertEquals(f.calls.clearCredentials, 0);
  assert(!text.includes(f.accessToken));
  assert(!text.includes(f.storedRefreshToken));
  assertEquals(f.logs, [{ action: "disconnect", reason: "grant_count_failed", userId: USER_ID }]);
});

Deno.test("disconnect fails closed on credential/metadata write failure", async () => {
  const f = fixture({ activeSharingGrantCount: 0, clearError: true });
  const response = await f.handler(post({ action: "disconnect", account_id: ACCOUNT_ID }));
  const text = await response.text();

  assertEquals(response.status, 500);
  assertEquals(JSON.parse(text), { error: "Failed to disconnect YouTube account. Please try again." });
  assertEquals(f.calls.revoke, 1);
  assertEquals(f.calls.clearCredentials, 1);
  assert(!text.includes(f.accessToken));
  assert(!text.includes(f.storedRefreshToken));
  assertEquals(f.logs, [{ action: "disconnect", reason: "account_clear_failed", userId: USER_ID }]);
});

Deno.test("revokeGoogleToken posts token in form body (never URL) and classifies responses", async () => {
  const token = opaqueValue();
  const captured: Array<{ url: string; method?: string; body?: string; hasSignal: boolean }> = [];

  const mockFetch = (status: number, body: unknown): typeof fetch =>
    ((input: URL | RequestInfo, init?: RequestInit) => {
      captured.push({
        url: String(input),
        method: init?.method,
        body: init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? ""),
        hasSignal: init?.signal instanceof AbortSignal,
      });
      return Promise.resolve(new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }));
    }) as typeof fetch;

  assertEquals(await revokeGoogleToken(mockFetch(200, {}), token), { ok: true, alreadyInvalid: false });
  assertEquals(captured[0].url, "https://oauth2.googleapis.com/revoke");
  assert(!captured[0].url.includes(token));
  assertEquals(captured[0].method, "POST");
  assertEquals(captured[0].body, `token=${token}`);
  assertEquals(captured[0].hasSignal, true);

  assertEquals(
    await revokeGoogleToken(mockFetch(400, { error: "invalid_grant" }), token),
    { ok: true, alreadyInvalid: true },
  );
  assertEquals(
    await revokeGoogleToken(mockFetch(400, { error: "invalid_token" }), token),
    { ok: true, alreadyInvalid: true },
  );
  assertEquals(
    await revokeGoogleToken(mockFetch(400, { error: "unsupported_token_type" }), token),
    { ok: false, status: 400, reason: "google_revoke_rejected" },
  );
  assertEquals(
    await revokeGoogleToken(mockFetch(503, { error: "backend_error" }), token),
    { ok: false, status: 503, reason: "google_revoke_failed" },
  );
  const failingFetch = (() => Promise.reject(new Error("connection reset"))) as typeof fetch;
  assertEquals(
    await revokeGoogleToken(failingFetch, token),
    { ok: false, status: 502, reason: "google_revoke_failed" },
  );
});

Deno.test("disconnect returns a conflict and keeps a newer reconnection when the account changed meanwhile", async () => {
  const f = fixture({ activeSharingGrantCount: 0, clearConflict: true });
  const response = await f.handler(post({ action: "disconnect", account_id: ACCOUNT_ID }));
  const text = await response.text();

  assertEquals(response.status, 409);
  assertEquals(JSON.parse(text), { error: "account_changed" });
  assert(!text.includes(f.accessToken));
  assert(!text.includes(f.storedRefreshToken));
  assertEquals(f.account.isActive, true);
  assertEquals(f.account.refreshToken, f.storedRefreshToken);
});
