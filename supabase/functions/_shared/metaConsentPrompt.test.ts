import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { withMetaConsentPrompt } from "./metaConsentPrompt.ts";

Deno.test("each Meta login kind gets the parameter that re-shows its permission screen", () => {
  const facebook = withMetaConsentPrompt(new URL("https://www.facebook.com/v22.0/dialog/oauth?client_id=1&scope=a,b"), "facebook_login");
  assertEquals(facebook.searchParams.get("auth_type"), "rerequest");
  assertEquals(facebook.searchParams.get("force_reauth"), null);
  assertEquals(facebook.searchParams.get("scope"), "a,b");

  const instagram = withMetaConsentPrompt(new URL("https://www.instagram.com/oauth/authorize?client_id=1"), "instagram_login");
  assertEquals(instagram.searchParams.get("force_reauth"), "true");
  assertEquals(instagram.searchParams.get("auth_type"), null);
});

Deno.test("applying the prompt twice leaves one parameter", () => {
  const url = withMetaConsentPrompt(withMetaConsentPrompt(new URL("https://www.facebook.com/v22.0/dialog/oauth"), "facebook_login"), "facebook_login");
  assertEquals(url.searchParams.getAll("auth_type"), ["rerequest"]);
});
