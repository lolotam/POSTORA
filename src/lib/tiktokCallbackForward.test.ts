import { describe, expect, it } from "vitest";
import { tiktokBackendCallbackUrl } from "./tiktokCallbackForward";

const API = "https://api.postora.cloud";

describe("tiktokBackendCallbackUrl", () => {
  it("forwards a code and its signed state to the edge function unchanged", () => {
    const search = new URLSearchParams({ code: "abc*1!", state: "head.body.sig", scopes: "user.info.basic" });
    expect(tiktokBackendCallbackUrl(search, API)).toBe(
      `${API}/functions/v1/tiktok-oauth?code=abc*1%21&state=head.body.sig&scopes=user.info.basic`,
    );
  });

  it("forwards a TikTok error that carries a state, so the edge function reports it", () => {
    const search = new URLSearchParams({ error: "access_denied", state: "s" });
    expect(tiktokBackendCallbackUrl(search, API)).toBe(
      `${API}/functions/v1/tiktok-oauth?error=access_denied&state=s`,
    );
  });

  it("leaves an answer without a state to the page", () => {
    expect(tiktokBackendCallbackUrl(new URLSearchParams({ code: "abc" }), API)).toBeNull();
    expect(tiktokBackendCallbackUrl(new URLSearchParams({ code: "abc", state: "" }), API)).toBeNull();
  });

  it("does not double the slash when the Supabase URL ends with one", () => {
    const search = new URLSearchParams({ code: "c", state: "s" });
    expect(tiktokBackendCallbackUrl(search, `${API}/`)).toBe(
      `${API}/functions/v1/tiktok-oauth?code=c&state=s`,
    );
  });
});
