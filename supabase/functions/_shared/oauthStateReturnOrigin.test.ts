import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createOAuthState, safeReturnTo, verifyOAuthState } from "./oauthState.ts";

Deno.test("signed OAuth state retains only the application origin explicitly configured by the server", async () => {
  const previousOrigin = Deno.env.get("PUBLIC_APP_ORIGIN");
  const previousSecret = Deno.env.get("OAUTH_STATE_SECRET");
  Deno.env.set("OAUTH_STATE_SECRET", "synthetic-return-origin-signing-secret");
  try {
    Deno.env.set("PUBLIC_APP_ORIGIN", "http://127.0.0.1:8080");
    const target = "http://127.0.0.1:8080/profiles?connected=instagram_business";
    const state = await createOAuthState({ platform: "instagram", user_id: "synthetic-owner", return_to: target });
    assertEquals((await verifyOAuthState(state, { expectedPlatform: "instagram" })).return_to, target);
    for (const untrusted of ["http://127.0.0.1:8081/profiles", "http://localhost:8080/profiles", "https://evilpostora.cloud/profiles", "https://postora.cloud.attacker.invalid/"]) {
      const invalid = await createOAuthState({ platform: "instagram", user_id: "synthetic-owner", extra: { return_to: untrusted } });
      assertEquals((await verifyOAuthState(invalid)).return_to, "https://postora.cloud/profiles");
    }
  } finally {
    if (previousOrigin === undefined) Deno.env.delete("PUBLIC_APP_ORIGIN"); else Deno.env.set("PUBLIC_APP_ORIGIN", previousOrigin);
    if (previousSecret === undefined) Deno.env.delete("OAUTH_STATE_SECRET"); else Deno.env.set("OAUTH_STATE_SECRET", previousSecret);
  }
});

Deno.test("the default return policy never implicitly trusts loopback or lookalike production domains", () => {
  for (const target of ["http://127.0.0.1:8080/profiles", "https://evilpostora.cloud/profiles", "https://postora.cloud.attacker.invalid/"]) {
    assertEquals(safeReturnTo(target), "https://postora.cloud/profiles");
  }
  assertEquals(safeReturnTo("https://postora.cloud/profiles?connected=instagram_business"), "https://postora.cloud/profiles?connected=instagram_business");
});

Deno.test("configured origins must be actual trusted origins without credentials, paths or unsafe schemes", () => {
  for (const trusted of ["http://remote.invalid", "http://127.0.0.1:8080/private", "http://127.0.0.1:8080/?allow=true",
    "http://user:password@127.0.0.1:8080", "javascript:alert(1)", "file:///", "not-a-url"]) {
    assertEquals(safeReturnTo("http://127.0.0.1:8080/profiles", undefined, trusted), "https://postora.cloud/profiles");
  }
  assertEquals(safeReturnTo("https://app.example.test/profiles", undefined, "https://app.example.test"), "https://app.example.test/profiles");
  assertEquals(safeReturnTo("https://username:password@postora.cloud/profiles"), "https://postora.cloud/profiles");
});
