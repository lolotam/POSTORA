import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { platformUsesRefreshToken } from "./tokenExpiryConstants.ts";

Deno.test("Meta platforms do not use OAuth refresh tokens", () => {
  // Facebook Pages, Instagram and Threads issue a long-lived access token that is
  // exchanged in place (fb_exchange_token / ig_refresh_token / th_refresh_token).
  // There is no separate refresh token, and treating its absence as a failure is
  // what flagged every healthy Meta account as needs_reauth.
  assertEquals(platformUsesRefreshToken("facebook"), false);
  assertEquals(platformUsesRefreshToken("instagram"), false);
  assertEquals(platformUsesRefreshToken("threads"), false);
});

Deno.test("OAuth2 platforms do use refresh tokens", () => {
  assertEquals(platformUsesRefreshToken("twitter"), true);
  assertEquals(platformUsesRefreshToken("youtube"), true);
  assertEquals(platformUsesRefreshToken("pinterest"), true);
  assertEquals(platformUsesRefreshToken("linkedin"), true);
  assertEquals(platformUsesRefreshToken("tiktok"), true);
});

Deno.test("platform matching is case-insensitive", () => {
  assertEquals(platformUsesRefreshToken("FaceBook"), false);
  assertEquals(platformUsesRefreshToken("INSTAGRAM"), false);
});

Deno.test("unknown platforms keep the conservative default", () => {
  // A platform nobody has configured yet must behave as it did before: a missing
  // refresh token is a failure.
  assertEquals(platformUsesRefreshToken("some-new-platform"), true);
});
