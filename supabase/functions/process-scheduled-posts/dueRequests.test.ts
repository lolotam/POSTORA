import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { mergeDuePosts } from "./dueRequests.ts";

Deno.test("due posts keep query order and carry the matching claim expectation", () => {
  const scheduled = [
    { id: "s2", scheduled_at: "2026-11-06T09:00:00Z", publish_requested_at: null },
    { id: "s1", scheduled_at: "2026-11-06T08:00:00Z", publish_requested_at: null },
  ];
  const requested = [
    { id: "r2", scheduled_at: null, publish_requested_at: "2026-11-06T11:00:00Z" },
    { id: "r1", scheduled_at: null, publish_requested_at: "2026-11-06T10:00:00Z" },
  ];
  assertEquals(mergeDuePosts(scheduled, requested), [
    { post: scheduled[0], expectation: { kind: "scheduled", value: "2026-11-06T09:00:00Z" } },
    { post: scheduled[1], expectation: { kind: "scheduled", value: "2026-11-06T08:00:00Z" } },
    { post: requested[0], expectation: { kind: "requested", value: "2026-11-06T11:00:00Z" } },
    { post: requested[1], expectation: { kind: "requested", value: "2026-11-06T10:00:00Z" } },
  ]);
});

Deno.test("a post due by schedule and request is kicked once under its request", () => {
  const scheduled = { id: "both", scheduled_at: "2026-11-06T09:00:00Z", publish_requested_at: null };
  const requested = { ...scheduled, publish_requested_at: "2026-11-06T10:00:00Z" };
  assertEquals(mergeDuePosts([scheduled], [requested, requested]), [
    { post: requested, expectation: { kind: "requested", value: requested.publish_requested_at } },
  ]);
});

Deno.test("request-only work survives an empty scheduled query", () => {
  const requested = { id: "orphan", scheduled_at: null, publish_requested_at: "2026-11-06T10:00:00Z" };
  assertEquals(mergeDuePosts([], [requested, requested]), [
    { post: requested, expectation: { kind: "requested", value: requested.publish_requested_at } },
  ]);
  assertEquals(mergeDuePosts([], []), []);
});
