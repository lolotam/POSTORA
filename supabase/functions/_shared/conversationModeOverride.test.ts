// deno-lint-ignore-file no-import-prefix
// supabase/functions/_shared/conversationModeOverride.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { activeOverrideMode, escalationOverride, isOverrideExpired } from "./conversationModeOverride.ts";

const NOW = Date.parse("2026-09-13T10:00:00Z");

Deno.test("an override with no expiry applies until released", () => {
  assertEquals(activeOverrideMode({ mode: "human_first", expires_at: null }, NOW), "human_first");
  assertEquals(activeOverrideMode({ mode: "human_first" }, NOW), "human_first");
});

Deno.test("an override past its expiry is treated as absent", () => {
  const row = { mode: "human_first", expires_at: "2026-09-13T09:59:59Z" };
  assertEquals(isOverrideExpired(row, NOW), true);
  assertEquals(activeOverrideMode(row, NOW), null);
  assertEquals(activeOverrideMode({ mode: "human_first", expires_at: "2026-09-13T10:00:01Z" }, NOW), "human_first");
});

Deno.test("an unparseable expiry never silences a conversation for ever", () => {
  assertEquals(activeOverrideMode({ mode: "human_first", expires_at: "garbage" }, NOW), null);
});

Deno.test("escalation gives humans an exclusive window only when one was assigned", () => {
  assertEquals(escalationOverride("human_then_ai", true, 30, NOW), { mode: "human_first", expires_at: "2026-09-13T10:30:00.000Z" });
  assertEquals(escalationOverride("human_then_ai", false, 30, NOW).mode, "human_then_ai");
  assertEquals(escalationOverride("ai_first", false, 30, NOW).mode, "human_first");
  assertEquals(escalationOverride("human_first", false, 30, NOW).mode, "human_first");
  assertEquals(escalationOverride(undefined, false, 30, NOW).mode, "human_first");
});

Deno.test("escalation timeout defaults to 240 minutes and is clamped to the allowed range", () => {
  assertEquals(escalationOverride("ai_first", false, null, NOW).expires_at, "2026-09-13T14:00:00.000Z");
  assertEquals(escalationOverride("ai_first", false, 0, NOW).expires_at, "2026-09-13T14:00:00.000Z");
  assertEquals(escalationOverride("ai_first", false, 999999, NOW).expires_at, "2026-09-20T10:00:00.000Z");
  assertEquals(escalationOverride("ai_first", false, -5, NOW).expires_at, "2026-09-13T10:01:00.000Z");
});
