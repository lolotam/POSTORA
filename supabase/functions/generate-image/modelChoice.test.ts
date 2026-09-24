// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { pickRequestedModelRow } from "./modelChoice.ts";

const row = (provider_code: string, is_active = true) => ({ model_id: "openai/gpt-image-2", ai_providers: { provider_code, is_active } });

Deno.test("prefers the admin's default image provider when several share an id", () => {
  assertEquals(pickRequestedModelRow([row("openrouter"), row("vercel")], "vercel")?.ai_providers.provider_code, "vercel");
});
Deno.test("skips inactive providers and returns null when nothing is usable", () => {
  assertEquals(pickRequestedModelRow([row("vercel", false), row("openrouter")], "vercel")?.ai_providers.provider_code, "openrouter");
  assertEquals(pickRequestedModelRow([row("vercel", false)], "vercel"), null);
});
