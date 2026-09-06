import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CONVERSATION_LIST_LIMIT,
  conversationSearchOr,
  displayNameFor,
  sanitizeConversationSearch,
} from "./whatsappConversationList.ts";

Deno.test("search term is trimmed, capped, and stripped of ilike wildcards and filter separators", () => {
  assertEquals(sanitizeConversationSearch("  ali%_(,) "), "ali");
  assertEquals(sanitizeConversationSearch(""), null);
  assertEquals(sanitizeConversationSearch(undefined), null);
  assertEquals(sanitizeConversationSearch("x".repeat(200))?.length, 80);
});

Deno.test("search matches the participant name or the phone digits", () => {
  assertEquals(
    conversationSearchOr("9655"),
    "participant_name.ilike.%9655%,conversation_id.ilike.%9655%",
  );
});

Deno.test("directory name beats the push name, but a bare phone in the directory does not", () => {
  assertEquals(displayNameFor("Push Name", "96555", { display_name: "Ali Saved" }), "Ali Saved");
  assertEquals(displayNameFor("Push Name", "96555", { display_name: "+96555" }), "Push Name");
  assertEquals(displayNameFor("Push Name", "96555", { display_name: "96555" }), "Push Name");
  assertEquals(displayNameFor(null, "96555", undefined), "+96555");
  assertEquals(CONVERSATION_LIST_LIMIT, 500);
});
