import { describe, expect, it } from "vitest";
import {
  HIGGSFIELD_CALLBACK_PATH,
  higgsfieldCallbackRescuePath,
  isHiggsfieldOAuthCallback,
  shouldForwardSocialOAuthToProfiles,
} from "./higgsfieldOAuthReturn";

function search(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

const higgsfieldReturn =
  "code=YJDIZGRLM2QTYZUXNI0ZYWI1LTKZNZQTODK5MZYZYMMXZWI1&iss=https%3A%2F%2Fclerk.higgsfield.ai&state=izd9psUenjnxQngKOwqbZhp3G9PRLnsp";

describe("isHiggsfieldOAuthCallback", () => {
  it("recognises a Clerk Higgsfield callback", () => {
    expect(isHiggsfieldOAuthCallback(search(higgsfieldReturn))).toBe(true);
  });

  it("does not treat Instagram code+state as Higgsfield", () => {
    expect(isHiggsfieldOAuthCallback(search("code=abc&state=xyz"))).toBe(false);
  });
});

describe("shouldForwardSocialOAuthToProfiles", () => {
  it("does not steal a Higgsfield callback off the dedicated route", () => {
    expect(
      shouldForwardSocialOAuthToProfiles(HIGGSFIELD_CALLBACK_PATH, search(higgsfieldReturn)),
    ).toBe(false);
  });

  it("does not steal a Higgsfield callback that landed on /profiles", () => {
    expect(shouldForwardSocialOAuthToProfiles("/profiles", search(higgsfieldReturn))).toBe(false);
  });

  it("still forwards Instagram-style code+state from settings to /profiles", () => {
    expect(
      shouldForwardSocialOAuthToProfiles("/settings", search("code=ig-code&state=ig-state")),
    ).toBe(true);
  });

  it("does not forward dedicated social callback routes", () => {
    expect(
      shouldForwardSocialOAuthToProfiles("/tiktok-callback", search("code=tt&state=st")),
    ).toBe(false);
  });
});

describe("higgsfieldCallbackRescuePath", () => {
  it("sends a Higgsfield return that landed on /profiles to the callback route", () => {
    expect(higgsfieldCallbackRescuePath("/profiles", search(higgsfieldReturn))).toBe(
      `${HIGGSFIELD_CALLBACK_PATH}?${higgsfieldReturn}`,
    );
  });

  it("leaves the dedicated callback route in place", () => {
    expect(higgsfieldCallbackRescuePath(HIGGSFIELD_CALLBACK_PATH, search(higgsfieldReturn))).toBeNull();
  });

  it("ignores Instagram returns", () => {
    expect(higgsfieldCallbackRescuePath("/settings", search("code=ig&state=st"))).toBeNull();
  });
});
