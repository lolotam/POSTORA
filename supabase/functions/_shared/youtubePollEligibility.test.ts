import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { selectPollableChannels } from "./youtubePollEligibility.ts";

const SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"];
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  user_id: "u1",
  platform_user_id: "UC1",
  auth_provider: "native",
  account_metadata: {
    comment_automation_handler: "internal",
    granted_scopes: SCOPES,
  },
  ...over,
});

Deno.test("polls capable channels whose handler is on, and counts what it left out", () => {
  const selection = selectPollableChannels([
    row("ok"),
    row("off", {
      account_metadata: {
        comment_automation_handler: "off",
        granted_scopes: SCOPES,
      },
    }),
    row("unset", { account_metadata: { granted_scopes: SCOPES } }),
    row("stale", {
      platform_user_id: "UC2",
      account_metadata: { comment_automation_handler: "n8n" },
    }),
  ]);
  assertEquals(selection.eligible.map((candidate) => candidate.id), ["ok"]);
  assertEquals(selection.skipped, {
    handler_off: 2,
    reconnect_required: 1,
    duplicate_channel: 0,
  });
});

// Polling a duplicate native and Composio row would ingest every comment twice under two
// social_account_ids; the inbox unique key is per account, so downstream cannot dedupe it.
Deno.test("one row per user+channel, preferring the Composio row", () => {
  const selection = selectPollableChannels([
    row("native"),
    row("composio", {
      auth_provider: "composio",
      account_metadata: { comment_automation_handler: "internal" },
    }),
    row("other-user", { user_id: "u2" }),
  ]);
  assertEquals(selection.eligible.map((candidate) => candidate.id), [
    "composio",
    "other-user",
  ]);
  assertEquals(selection.skipped.duplicate_channel, 1);
});

Deno.test("a row with no channel id is never polled", () => {
  assertEquals(
    selectPollableChannels([row("x", { platform_user_id: null })]).eligible,
    [],
  );
});
