import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  LEGACY_ACCOUNT_PROFILE_TITLE,
  parseRenameSourceInput,
  profileSourceFileName,
  shouldRetireLegacyPlatformProfile,
  SourceNameError,
} from "./profileSource.ts";

Deno.test("a profile file is named after the account, never after its uuid", () => {
  assertEquals(
    profileSourceFileName("whatsapp", { id: "8207c854-0000-0000-0000-000000000000", platform_username: "danantfuture" }),
    "Business profile · danantfuture (whatsapp)",
  );
  assertEquals(
    profileSourceFileName("instagram", { id: "id-1", platform_username: "  ", platform_user_id: "17841" }),
    "Business profile · 17841 (instagram)",
  );
  assertEquals(profileSourceFileName("threads", { id: "id-2" }), "Business profile · id-2 (threads)");
});

Deno.test("the legacy account title is recognised so an old row is adopted once, not duplicated", () => {
  const match = LEGACY_ACCOUNT_PROFILE_TITLE.exec("Business profile (whatsapp · 8207c854-8d9e-486e-9111-a669c113a325)");
  assertEquals(match?.[1], "whatsapp");
  assertEquals(match?.[2], "8207c854-8d9e-486e-9111-a669c113a325");
  assertEquals(LEGACY_ACCOUNT_PROFILE_TITLE.test("Business profile (whatsapp)"), false);
  assertEquals(LEGACY_ACCOUNT_PROFILE_TITLE.test("Business profile · danantfuture (whatsapp)"), false);
});

Deno.test("rename input is trimmed to one line and bounded", () => {
  assertEquals(
    parseRenameSourceInput({ source_id: " s1 ", file_name: "  Price   list\t2026 " }),
    { sourceId: "s1", fileName: "Price list 2026" },
  );
  assertThrows(() => parseRenameSourceInput({ source_id: "s1", file_name: "   " }), SourceNameError, "empty");
  assertThrows(() => parseRenameSourceInput({ source_id: "s1", file_name: "x".repeat(121) }), SourceNameError, "120");
  assertThrows(() => parseRenameSourceInput({ source_id: "s1" }), SourceNameError, "file_name is required");
  assertThrows(() => parseRenameSourceInput({ file_name: "x" }), SourceNameError, "source_id");
  assertThrows(() => parseRenameSourceInput({ source_id: "s1", file_name: "a\u0008b" }), SourceNameError, "single line");
});

Deno.test("the platform-wide profile is retired only when every account on the platform has its own", () => {
  assertEquals(shouldRetireLegacyPlatformProfile(["a", "b"], ["a", "b", "c"]), true);
  assertEquals(shouldRetireLegacyPlatformProfile(["a", "b"], ["a"]), false);
  // No configs on the platform: nothing proves the legacy row is unneeded.
  assertEquals(shouldRetireLegacyPlatformProfile([], []), false);
});
