import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import { refreshYoutubeAccessToken } from "./youtubeTokenRefresh.ts";

Deno.test("token refresh validates the response and does not replace a newer grant", async (t) => {
  const keys = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const;
  const old = keys.map((key) => Deno.env.get(key));
  for (const key of keys) Deno.env.set(key, "fixture");
  const now = Date.parse("2026-11-18T12:00:00.000Z");
  const account = {
    id: "account-1",
    accessToken: "previous",
    refreshToken: "previous-grant",
    tokenExpiresAt: new Date(now - 60_000).toISOString(),
  };
  try {
    for (const [label, payload, expected] of [
      ["JSON null", null, "refresh_answer_incomplete"],
      ["negative lifetime", { access_token: "candidate", expires_in: -1 }, "refresh_answer_incomplete"],
      ["expired stale grant", { access_token: "candidate", expires_in: 3600 }, "refresh_not_stored"],
    ] as const) {
      await t.step(label, async () => {
        const writes: URL[] = [];
        const current = "replacement";
        const db = createClient("https://db.invalid", "fixture", {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { fetch: (input, init) => {
            const request = new Request(input, init);
            if (request.method === "PATCH") {
              writes.push(new URL(request.url));
              return Promise.resolve(Response.json(null));
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
          assertEquals(writes[0]?.searchParams.get("access_token"), `eq.${account.accessToken}`);
          assertEquals(writes[0]?.searchParams.get("refresh_token"), `eq.${account.refreshToken}`);
          assertEquals(writes[0]?.searchParams.get("token_expires_at"), `eq.${account.tokenExpiresAt}`);
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
