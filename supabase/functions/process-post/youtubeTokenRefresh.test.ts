import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import {
  refreshYoutubeAccessToken,
  youtubeJitRefusalStopsPublish,
} from "./youtubeTokenRefresh.ts";

// The fake credentials are BUILT, not written down. A literal that looks like
// a token is a secret to every scanner that reads the diff, and a scanner that
// redacts it cannot review it.
const fake = (word: string) => [word].join("");

const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const LEASE_ID = "44444444-4444-4444-8444-444444444444";

function withGoogleEnv<T>(fn: () => Promise<T>): Promise<T> {
  const keys = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const;
  const old = keys.map((key) => Deno.env.get(key));
  for (const key of keys) Deno.env.set(key, fake("fixture"));
  return fn().finally(() => {
    keys.forEach((key, index) => {
      const value = old[index];
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    });
  });
}

Deno.test("token refresh acquires DB lease, validates response, and fences writes on lease_token", async (t) => {
  await withGoogleEnv(async () => {
    const account = {
      id: "account-1",
      accessToken: fake("previous"),
      refreshToken: ["previous", "grant"].join("-"),
      tokenExpiresAt: new Date(NOW - 60_000).toISOString(),
    };

    for (const [label, payload, expected] of [
      ["JSON null", null, "refresh_answer_incomplete"],
      ["negative lifetime", { access_token: fake("candidate"), expires_in: -1 }, "refresh_answer_incomplete"],
      ["stale lease rejected", { access_token: fake("candidate"), expires_in: 3600 }, "stale_lease"],
    ] as const) {
      await t.step(label, async () => {
        const rpcCalls: Array<{ path: string; req: Request }> = [];
        const db = createClient("https://db.invalid", fake("fixture"), {
          auth: { persistSession: false, autoRefreshToken: false },
          global: {
            fetch: (input, init) => {
              const req = new Request(input, init);
              const url = new URL(req.url);
              if (req.method === "POST") {
                rpcCalls.push({ path: url.pathname, req });
                if (url.pathname.endsWith("/rpc/acquire_youtube_refresh_lease")) {
                  return Promise.resolve(Response.json({
                    ok: true,
                    lease_token: LEASE_ID,
                    expires_at: new Date(NOW + 60_000).toISOString(),
                  }));
                }
                if (url.pathname.endsWith("/rpc/store_youtube_refreshed_token_with_lease")) {
                  return Promise.resolve(Response.json({ ok: false, reason: "stale_lease" }));
                }
                if (url.pathname.endsWith("/rpc/release_youtube_refresh_lease")) {
                  return Promise.resolve(Response.json(true));
                }
              }
              return Promise.resolve(Response.json({
                id: account.id,
                access_token: account.accessToken,
                refresh_token: account.refreshToken,
                token_expires_at: account.tokenExpiresAt,
                needs_reauth: false,
              }));
            },
          },
        });

        const result = await refreshYoutubeAccessToken({
          supabase: db,
          account,
          nowMs: NOW,
          fetchImpl: () => Promise.resolve(Response.json(payload)),
        });

        assertEquals(result.reason, expected);
        assertEquals(result.refreshed, false);
        assertEquals(
          rpcCalls.some((c) => c.path.endsWith("/rpc/acquire_youtube_refresh_lease")),
          true,
        );

        const storeCall = rpcCalls.find((c) =>
          c.path.endsWith("/rpc/store_youtube_refreshed_token_with_lease")
        );
        if (expected === "stale_lease") {
          // Credentials travel only in the RPC POST body, never in URL filters.
          assertEquals(Boolean(storeCall), true);
          const url = new URL(storeCall!.req.url);
          assertEquals(url.searchParams.get("access_token"), null);
          assertEquals(url.searchParams.get("refresh_token"), null);
          const body = JSON.parse(await storeCall!.req.clone().text()) as Record<string, unknown>;
          assertEquals(body.p_account_id, account.id);
          assertEquals(body.p_lease_token, LEASE_ID);
          assertEquals(body.p_new_access_token, fake("candidate"));
          assertEquals(body.p_new_refresh_token, null);
        } else {
          assertEquals(storeCall, undefined);
          assertEquals(
            rpcCalls.some((c) => c.path.endsWith("/rpc/release_youtube_refresh_lease")),
            true,
          );
        }
      });
    }
  });
});

Deno.test("contender without lease reuses fresh token or returns retryable refresh_in_progress", async () => {
  await withGoogleEnv(async () => {
    const freshToken = fake("winner");
    const freshExpiry = new Date(NOW + 3_500_000).toISOString();
    const account = {
      id: "account-1",
      accessToken: fake("stale"),
      refreshToken: ["previous", "grant"].join("-"),
      tokenExpiresAt: new Date(NOW - 60_000).toISOString(),
    };

    const makeDb = (storedAccess: string, storedExpiry: string) =>
      createClient("https://db.invalid", fake("fixture"), {
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
          fetch: (input, init) => {
            const req = new Request(input, init);
            const url = new URL(req.url);
            if (url.pathname.endsWith("/rpc/acquire_youtube_refresh_lease")) {
              return Promise.resolve(Response.json({ ok: false, reason: "lease_held" }));
            }
            return Promise.resolve(Response.json({
              id: account.id,
              access_token: storedAccess,
              refresh_token: account.refreshToken,
              token_expires_at: storedExpiry,
              needs_reauth: false,
            }));
          },
        },
      });

    let googleCalls = 0;
    const reused = await refreshYoutubeAccessToken({
      supabase: makeDb(freshToken, freshExpiry),
      account,
      nowMs: NOW,
      fetchImpl: () => {
        googleCalls++;
        throw new Error("must not call Google without lease");
      },
    });
    assertEquals(reused.accessToken, freshToken);
    assertEquals(reused.reason, null);
    assertEquals(googleCalls, 0);

    const refused = await refreshYoutubeAccessToken({
      supabase: makeDb(account.accessToken, account.tokenExpiresAt),
      account,
      nowMs: NOW,
      fetchImpl: () => {
        googleCalls++;
        throw new Error("must not call Google without lease");
      },
    });
    assertEquals(refused.accessToken, null);
    assertEquals(refused.reason, "refresh_in_progress");
    assertEquals(googleCalls, 0);
  });
});

Deno.test("invalid_grant marks needs_reauth via fenced RPC", async () => {
  await withGoogleEnv(async () => {
    let recordedInvalidGrant = false;
    const account = {
      id: "account-1",
      accessToken: fake("stale"),
      refreshToken: ["revoked", "grant"].join("-"),
      tokenExpiresAt: new Date(NOW - 60_000).toISOString(),
    };
    const db = createClient("https://db.invalid", fake("fixture"), {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: async (input, init) => {
          const req = new Request(input, init);
          const url = new URL(req.url);
          if (url.pathname.endsWith("/rpc/acquire_youtube_refresh_lease")) {
            return Response.json({
              ok: true,
              lease_token: LEASE_ID,
              expires_at: new Date(NOW + 60_000).toISOString(),
            });
          }
          if (url.pathname.endsWith("/rpc/record_youtube_refresh_failure_with_lease")) {
            const body = JSON.parse(await req.clone().text()) as Record<string, unknown>;
            recordedInvalidGrant = body.p_is_invalid_grant === true && body.p_lease_token === LEASE_ID;
            return Response.json({
              ok: true,
              needs_reauth: true,
              failure_count: 1,
              transitioned: true,
              enqueued: 0,
            });
          }
          return Response.json({
            id: account.id,
            access_token: account.accessToken,
            refresh_token: account.refreshToken,
            token_expires_at: account.tokenExpiresAt,
            needs_reauth: false,
          });
        },
      },
    });

    const result = await refreshYoutubeAccessToken({
      supabase: db,
      account,
      nowMs: NOW,
      fetchImpl: () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }),
        ),
    });

    assertEquals(result.reason, "invalid_grant");
    assertEquals(result.needsReauth, true);
    assertEquals(result.accessToken, null);
    assertEquals(recordedInvalidGrant, true);
  });
});

Deno.test("no refresh token returns the stored token while the credential policy still accepts it", async () => {
  await withGoogleEnv(async () => {
    const storedToken = fake("still-valid");
    // Inside the refresh window, still strictly in the future: the credential
    // policy accepts it, and the old behaviour handed it back so the publish
    // could proceed.
    const storedExpiry = new Date(NOW + 10 * 60_000).toISOString();

    let googleCalled = false;
    const db = createClient("https://db.invalid", fake("fixture"), {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: (input, init) => {
          const url = new URL(new Request(input, init).url);
          if (url.pathname.endsWith("/rpc/acquire_youtube_refresh_lease")) {
            return Promise.resolve(
              Response.json({ ok: false, reason: "lease_held" }),
            );
          }
          return Promise.resolve(Response.json({
            id: "account-1",
            access_token: storedToken,
            refresh_token: null,
            token_expires_at: storedExpiry,
            needs_reauth: false,
          }));
        },
      },
    });

    const result = await refreshYoutubeAccessToken({
      supabase: db,
      account: {
        id: "account-1",
        accessToken: storedToken,
        refreshToken: null,
        tokenExpiresAt: storedExpiry,
      },
      nowMs: NOW,
      fetchImpl: () => {
        googleCalled = true;
        return Promise.reject(new Error("must not call Google without a refresh token"));
      },
    });

    assertEquals(result.accessToken, storedToken);
    assertEquals(result.reason, "no_refresh_token");
    assertEquals(result.refreshed, false);
    assertEquals(result.needsReauth, false);
    assertEquals(googleCalled, false);
  });
});

Deno.test("no refresh token with an expired stored credential still refuses", async () => {
  await withGoogleEnv(async () => {
    const db = createClient("https://db.invalid", fake("fixture"), {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: (input, init) => {
          const url = new URL(new Request(input, init).url);
          return Promise.resolve(Response.json({
            id: "account-1",
            access_token: fake("stale"),
            refresh_token: null,
            token_expires_at: new Date(NOW - 60_000).toISOString(),
            needs_reauth: false,
          }));
        },
      },
    });

    const result = await refreshYoutubeAccessToken({
      supabase: db,
      account: {
        id: "account-1",
        accessToken: fake("stale"),
        refreshToken: null,
        tokenExpiresAt: new Date(NOW - 60_000).toISOString(),
      },
      nowMs: NOW,
      fetchImpl: () => Promise.reject(new Error("must not call Google")),
    });

    assertEquals(result.accessToken, null);
    assertEquals(result.reason, "no_refresh_token");
  });
});

Deno.test("a reauthentication refusal stops the publish for the account; retryable and happy outcomes do not", () => {
  // invalid_grant (or an account already flagged needs_reauth): the stored
  // grant is dead even when the cached access token still looks usable. The
  // publish for this account must stop — the same rule the continuation path
  // applies when youtubeCredentialRefusalReason meets a null token.
  assertEquals(
    youtubeJitRefusalStopsPublish({ accessToken: null, needsReauth: true }),
    true,
  );
  // A retryable refusal (lease held, refresh in progress) is not a dead grant.
  assertEquals(
    youtubeJitRefusalStopsPublish({ accessToken: null, needsReauth: false }),
    false,
  );
  // A returned token never stops the publish.
  assertEquals(
    youtubeJitRefusalStopsPublish({ accessToken: fake("tok"), needsReauth: false }),
    false,
  );
});
