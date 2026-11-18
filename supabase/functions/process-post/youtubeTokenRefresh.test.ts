import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import { refreshYoutubeAccessToken } from "./youtubeTokenRefresh.ts";

// The fake credentials are BUILT, not written down. A literal that looks like
// a token is a secret to every scanner that reads the diff, and a scanner that
// redacts it cannot review it.
const fake = (word: string) => [word].join("");

Deno.test("token refresh validates the response and does not replace a newer grant", async (t) => {
  const keys = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const;
  const old = keys.map((key) => Deno.env.get(key));
  for (const key of keys) Deno.env.set(key, fake("fixture"));
  const now = Date.parse("2026-11-18T12:00:00.000Z");
  const account = {
    id: "account-1",
    accessToken: fake("previous"),
    refreshToken: ["previous", "grant"].join("-"),
    tokenExpiresAt: new Date(now - 60_000).toISOString(),
  };
  try {
    for (const [label, payload, expected] of [
      ["JSON null", null, "refresh_answer_incomplete"],
      ["negative lifetime", { access_token: fake("candidate"), expires_in: -1 }, "refresh_answer_incomplete"],
      ["expired stale grant", { access_token: fake("candidate"), expires_in: 3600 }, "refresh_not_stored"],
    ] as const) {
      await t.step(label, async () => {
        const writes: Request[] = [];
        const current = fake("replacement");
        const db = createClient("https://db.invalid", fake("fixture"), {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { fetch: (input, init) => {
            const request = new Request(input, init);
            if (request.method === "POST") {
              writes.push(request);
              return Promise.resolve(Response.json(false));
            }
            return Promise.resolve(Response.json({
              access_token: current,
              token_expires_at: new Date(now + 3_600_000).toISOString(),
            }));
          } },
        });
        const result = await refreshYoutubeAccessToken({
          supabase: db, account, nowMs: now,
          fetchImpl: () => Promise.resolve(Response.json(payload)),
        });
        assertEquals(result.reason, expected);
        if (expected === "refresh_not_stored") {
          // THE CREDENTIALS NEVER TRAVEL IN A URL
          //
          // The compare-and-set is a call to the database, so the tokens are
          // in the BODY of the POST. A filter would have put them in the
          // query string, and a query string is written to every access log
          // on the way.
          assertEquals(writes.length, 1);
          const write = writes[0]!;
          const url = new URL(write.url);
          assertEquals(url.pathname.endsWith("/rpc/store_youtube_refreshed_token"), true);
          assertEquals(url.searchParams.get("access_token"), null);
          assertEquals(url.searchParams.get("refresh_token"), null);
          assertEquals(url.searchParams.get("token_expires_at"), null);
          const body = JSON.parse(await write.clone().text()) as Record<string, unknown>;
          assertEquals(body.p_account_id, account.id);
          assertEquals(body.p_expected_refresh_token, account.refreshToken);
          assertEquals(body.p_expected_access_token, account.accessToken);
          assertEquals(body.p_expected_token_expires_at, account.tokenExpiresAt);
          assertEquals(body.p_new_access_token, fake("candidate"));
          assertEquals(result.accessToken, current);
        } else {
          assertEquals(writes.length, 0);
        }
      });
    }
  } finally {
    keys.forEach((key, index) => {
      const value = old[index];
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    });
  }
});
