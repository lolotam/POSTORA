import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { readAiTextFlags } from "./textFlags.ts";

for (const stored of [undefined, false, "true", true]) {
  Deno.test(`new list flags accept only JSON true, stored=${stored}`, async () => {
    const admin = createClient("https://database.example.test", "test-key", { global: { fetch: (() => Promise.resolve(Response.json(stored === undefined ? [] : [
      { key: "feature_ai_text_auth_lists", value: stored }, { key: "feature_ai_provider_oauth", value: true },
    ]))) as typeof fetch } });
    const flags = await readAiTextFlags(admin);
    assertEquals(flags.feature_ai_text_auth_lists, stored === true);
    assertEquals(flags.feature_ai_category_text_ladders, false);
    assertEquals(flags.feature_ai_oauth_tools_claude, false);
    assertEquals(flags.feature_ai_oauth_tools_codex, false);
  });
}
Deno.test("failed flag reads refuse readiness instead of claiming disabled", async () => {
  const admin = createClient("https://database.example.test", "test-key", { global: { fetch: (() => Promise.resolve(Response.json({ message: "private failure" }, { status: 400 }))) as typeof fetch } });
  await assertRejects(() => readAiTextFlags(admin), Error, "AI text configuration read failed");
});
