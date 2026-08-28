import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  accountCanAttemptRefresh,
  metaRefreshStrategy,
  metaTokenTooYoungToRefresh,
} from "./refreshEligibility.ts";

Deno.test("a Facebook account with no refresh token can still be refreshed by exchange", () => {
  // Regression: this exact account shape used to be marked needs_reauth on sight,
  // which is why 0 of 14 active Facebook accounts had a refresh token and 11 were red.
  assertEquals(accountCanAttemptRefresh({ platform: "facebook", refresh_token: null }), true);
});

Deno.test("Instagram and Threads behave the same as Facebook", () => {
  assertEquals(accountCanAttemptRefresh({ platform: "instagram", refresh_token: null }), true);
  assertEquals(accountCanAttemptRefresh({ platform: "threads", refresh_token: null }), true);
});

Deno.test("an OAuth2 platform with no refresh token genuinely cannot refresh", () => {
  assertEquals(accountCanAttemptRefresh({ platform: "pinterest", refresh_token: null }), false);
  assertEquals(accountCanAttemptRefresh({ platform: "youtube", refresh_token: null }), false);
  assertEquals(accountCanAttemptRefresh({ platform: "twitter", refresh_token: "" }), false);
});

Deno.test("an OAuth2 platform with a refresh token can refresh", () => {
  assertEquals(accountCanAttemptRefresh({ platform: "pinterest", refresh_token: "rt_abc" }), true);
});

Deno.test("Instagram Business Login uses the Instagram-scoped refresh endpoint", () => {
  // 21 of 27 active Instagram accounts are business_login. Their tokens are
  // Instagram-scoped and are rejected by fb_exchange_token.
  assertEquals(
    metaRefreshStrategy({ platform: "instagram", ig_auth_type: "business_login" }),
    "ig_refresh",
  );
});

Deno.test("Page-backed Instagram accounts use the Facebook exchange", () => {
  assertEquals(
    metaRefreshStrategy({ platform: "instagram", ig_auth_type: "facebook_page" }),
    "fb_exchange",
  );
  assertEquals(
    metaRefreshStrategy({ platform: "instagram", ig_auth_type: "facebook_business" }),
    "fb_exchange",
  );
});

Deno.test("an Instagram row with no ig_auth_type falls back to the Facebook exchange", () => {
  assertEquals(metaRefreshStrategy({ platform: "instagram", ig_auth_type: null }), "fb_exchange");
});

Deno.test("Facebook and Threads route to their own exchanges", () => {
  assertEquals(metaRefreshStrategy({ platform: "facebook", ig_auth_type: null }), "fb_exchange");
  assertEquals(metaRefreshStrategy({ platform: "threads", ig_auth_type: null }), "threads_refresh");
});

Deno.test("non-Meta platforms have no exchange strategy", () => {
  assertEquals(metaRefreshStrategy({ platform: "pinterest", ig_auth_type: null }), "none");
});

Deno.test("a just-reconnected Instagram Business token is too young to refresh", () => {
  // Meta rejects ig_refresh_token under 24h. Admin "Refresh all" bypasses the cooldown,
  // so without this guard three presses would flag a healthy new token.
  const now = new Date("2026-08-28T12:00:00Z");
  const issuedOneHourAgo = new Date("2026-10-27T11:00:00Z").toISOString(); // now + 60d - 1h
  assertEquals(
    metaTokenTooYoungToRefresh(
      { platform: "instagram", ig_auth_type: "business_login", token_expires_at: issuedOneHourAgo },
      now,
    ),
    true,
  );
});

Deno.test("an Instagram Business token older than 24h may refresh", () => {
  const now = new Date("2026-08-28T12:00:00Z");
  const issuedThreeDaysAgo = new Date("2026-10-24T12:00:00Z").toISOString(); // now + 60d - 3d
  assertEquals(
    metaTokenTooYoungToRefresh(
      { platform: "instagram", ig_auth_type: "business_login", token_expires_at: issuedThreeDaysAgo },
      now,
    ),
    false,
  );
});

Deno.test("Threads is subject to the same minimum age", () => {
  const now = new Date("2026-08-28T12:00:00Z");
  const issuedOneHourAgo = new Date("2026-10-27T11:00:00Z").toISOString();
  assertEquals(
    metaTokenTooYoungToRefresh({ platform: "threads", token_expires_at: issuedOneHourAgo }, now),
    true,
  );
});

Deno.test("Facebook has no minimum age — fb_exchange_token imposes none", () => {
  const now = new Date("2026-08-28T12:00:00Z");
  const issuedOneHourAgo = new Date("2026-10-27T11:00:00Z").toISOString();
  assertEquals(
    metaTokenTooYoungToRefresh({ platform: "facebook", token_expires_at: issuedOneHourAgo }, now),
    false,
  );
});

Deno.test("an unknown expiry cannot prove the token is too young", () => {
  assertEquals(
    metaTokenTooYoungToRefresh({
      platform: "instagram",
      ig_auth_type: "business_login",
      token_expires_at: null,
    }),
    false,
  );
});
