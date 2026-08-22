import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { extractThreadsChanges, normalizeThreadsReply } from "./replyEvents.ts";

Deno.test("extractThreadsChanges reads entry/changes envelopes", () => {
  const out = extractThreadsChanges({ entry: [{ id: "th-1", changes: [{ field: "replies", value: { id: "r1" } }] }] });
  assertEquals(out, [{ targetId: "th-1", field: "replies", value: { id: "r1" } }]);
});

Deno.test("extractThreadsChanges reads flat topic/values envelopes", () => {
  const out = extractThreadsChanges({ topic: "moderate", target_id: "th-1", values: { field: "replies", value: { id: "r1" } } });
  assertEquals(out, [{ targetId: "th-1", field: "replies", value: { id: "r1" } }]);
});

Deno.test("extractThreadsChanges returns nothing for an unrecognised envelope", () => {
  assertEquals(extractThreadsChanges({}), []);
  assertEquals(extractThreadsChanges({ entry: [{ id: "th-1" }] }), []);
});

Deno.test("normalizeThreadsReply maps the Meta reply shape", () => {
  const out = normalizeThreadsReply({
    id: "r1",
    username: "fan",
    text: "Hey",
    permalink: "https://threads.net/@fan/post/r1",
    replied_to: { id: "p1" },
    root_post: { id: "p1", owner_id: "th-1", username: "mybrand" },
    timestamp: "2026-08-22T10:00:00+0000",
  });
  assertEquals(out, {
    comment: { id: "r1", kind: "reply", text: "Hey", parentCommentId: "p1", mediaUrl: "https://threads.net/@fan/post/r1" },
    post: { id: "p1", url: null, caption: null },
    author: { id: null, name: null, username: "fan" },
    timestamp: "2026-08-22T10:00:00.000Z",
  });
});

Deno.test("normalizeThreadsReply rejects values without an id", () => {
  assertEquals(normalizeThreadsReply({ text: "x" }), null);
  assertEquals(normalizeThreadsReply(null), null);
});

Deno.test("normalizeThreadsReply leaves the timestamp undefined when Meta sends an unusable one", () => {
  const out = normalizeThreadsReply({ id: "r1", timestamp: "not-a-date" });
  assertEquals(out?.timestamp, undefined);
});
