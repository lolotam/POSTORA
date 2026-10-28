import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { InstagramGraphProvider, ProviderError } from "./graphProvider.ts";

Deno.test("InstagramGraphProvider fetches account profile successfully", async () => {
  const fakeFetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ followers_count: 1250, media_count: 84 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

  const provider = new InstagramGraphProvider({ fetchFn: fakeFetch });
  const profile = await provider.fetchAccountProfile("1784140001", "valid_token");

  assertEquals(profile.followers_count, 1250);
  assertEquals(profile.media_count, 84);
});

Deno.test("InstagramGraphProvider fetches account daily insights successfully", async () => {
  const fakeFetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: [
            { name: "reach", values: [{ value: 450 }] },
            { name: "views", values: [{ value: 890 }] },
            { name: "accounts_engaged", values: [{ value: 35 }] },
            { name: "total_interactions", values: [{ value: 12 }] },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );

  const provider = new InstagramGraphProvider({ fetchFn: fakeFetch });
  const insights = await provider.fetchAccountDailyInsights("1784140001", "valid_token", "2026-10-28");

  assertEquals(insights.provider_date, "2026-10-28");
  assertEquals(insights.metric_date, "2026-10-28");
  assertEquals(insights.query_kind, "interactions");
  assertEquals(insights.metrics.reach, 450);
  assertEquals(insights.metrics.views, 890);
  assertEquals(insights.metrics.accounts_engaged, 35);
  assertEquals(insights.metrics.total_interactions, 12);
});

Deno.test("InstagramGraphProvider fetches recent media items correctly", async () => {
  const fakeFetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "media_12345",
              media_type: "IMAGE",
              caption: "Hello Instagram!",
              permalink: "https://instagram.com/p/12345",
              timestamp: "2026-10-28T14:00:00Z",
              like_count: 55,
              comments_count: 3,
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );

  const provider = new InstagramGraphProvider({ fetchFn: fakeFetch });
  const media = await provider.fetchRecentMedia("1784140001", "valid_token", 10);

  assertEquals(media.length, 1);
  assertEquals(media[0].ig_media_id, "media_12345");
  assertEquals(media[0].media_type, "IMAGE");
  assertEquals(media[0].metrics.like_count_public, 55);
  assertEquals(media[0].metrics.comments_count_public, 3);
});

Deno.test("InstagramGraphProvider classifies rate limit errors (HTTP 429 & code 32)", async () => {
  const fakeFetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          error: { code: 32, message: "Page request limit reached" },
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      )
    );

  const provider = new InstagramGraphProvider({ fetchFn: fakeFetch });

  const error = await assertRejects(
    () => provider.fetchAccountProfile("1784140001", "token"),
    ProviderError
  );

  assertEquals(error.kind, "rate_limited");
  assertEquals(error.retryAfterSeconds, 300);
});

Deno.test("InstagramGraphProvider classifies token expiry (code 190)", async () => {
  const fakeFetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          error: { code: 190, error_subcode: 463, message: "Session has expired" },
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      )
    );

  const provider = new InstagramGraphProvider({ fetchFn: fakeFetch });

  const error = await assertRejects(
    () => provider.fetchAccountProfile("1784140001", "token"),
    ProviderError
  );

  assertEquals(error.kind, "token_expired");
});

Deno.test("InstagramGraphProvider classifies transient server errors (HTTP 500)", async () => {
  const fakeFetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          error: { message: "Internal server error" },
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      )
    );

  const provider = new InstagramGraphProvider({ fetchFn: fakeFetch });

  const error = await assertRejects(
    () => provider.fetchAccountProfile("1784140001", "token"),
    ProviderError
  );

  assertEquals(error.kind, "transient_error");
});

