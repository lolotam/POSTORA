import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import { claimFinalNotification, FINAL_NOTIFIED_KEY, markerCoversCycle } from "./finalNotification.ts";

interface PostRow {
  metadata: Record<string, unknown> | null;
  processing_started_at: string | null;
}

/**
 * A posts table of one row with the semantics the claim relies on: an UPDATE applies only if
 * its filters still hold against the row as it is when the UPDATE runs, not as it was read.
 */
function fakePosts(initial: PostRow, failures: { read?: string; update?: string } = {}) {
  const row: PostRow = structuredClone(initial);
  const valueAt = (column: string): unknown => {
    const [field, key] = column.split("->>");
    return key ? (row[field as "metadata"] as Record<string, unknown> | null)?.[key] ?? null : (row as unknown as Record<string, unknown>)[field];
  };
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve(failures.read ? { data: null, error: { message: failures.read } } : { data: structuredClone(row), error: null }),
        }),
      }),
      update: (values: Partial<PostRow>) => {
        const filters: ((column?: string) => boolean)[] = [];
        const chain = {
          eq: (column: string, value: unknown) => {
            if (column !== "id") filters.push(() => valueAt(column) === value);
            return chain;
          },
          is: (column: string, value: null) => {
            filters.push(() => valueAt(column) === value);
            return chain;
          },
          select: () => {
            if (failures.update) return Promise.resolve({ data: null, error: { message: failures.update } });
            if (!filters.every((holds) => holds())) return Promise.resolve({ data: [], error: null });
            Object.assign(row, values);
            return Promise.resolve({ data: [{ id: "post-1" }], error: null });
          },
        };
        return chain;
      },
    }),
  } as unknown as SupabaseClient;
  return { client, row };
}

const NOW = new Date("2026-10-30T12:00:00.000Z");

Deno.test("the first claim wins, keeps the rest of the metadata, and a second finds it taken", async () => {
  const { client, row } = fakePosts({ metadata: { webhook_url: "https://hook" }, processing_started_at: "2026-10-30T11:00:00.000Z" });
  assertEquals(await claimFinalNotification(client, "post-1", NOW), { claimed: true, error: null });
  assertEquals(row.metadata, { webhook_url: "https://hook", [FINAL_NOTIFIED_KEY]: NOW.toISOString() });
  assertEquals(await claimFinalNotification(client, "post-1", NOW), { claimed: false, error: null });
});

Deno.test("two runs claiming at the same moment: exactly one is told to send", async () => {
  const { client } = fakePosts({ metadata: null, processing_started_at: "2026-10-30T11:00:00.000Z" });
  const results = await Promise.all([claimFinalNotification(client, "post-1", NOW), claimFinalNotification(client, "post-1", NOW)]);
  assertEquals(results.filter((r) => r.claimed).length, 1);
  assertEquals(results.every((r) => r.error === null), true);
});

Deno.test("a post retried and final again is announced again, still by exactly one of two runs", async () => {
  const { client, row } = fakePosts({
    metadata: { [FINAL_NOTIFIED_KEY]: "2026-10-30T09:00:00.000Z" },
    processing_started_at: "2026-10-30T11:00:00.000Z", // claimed again after the earlier announcement
  });
  const results = await Promise.all([claimFinalNotification(client, "post-1", NOW), claimFinalNotification(client, "post-1", NOW)]);
  assertEquals(results.filter((r) => r.claimed).length, 1);
  assertEquals(row.metadata?.[FINAL_NOTIFIED_KEY], NOW.toISOString());
});

Deno.test("a read that fails, or a missing post, is an error rather than 'already announced'", async () => {
  const unreadable = fakePosts({ metadata: null, processing_started_at: null }, { read: "statement timeout" });
  assertEquals(await claimFinalNotification(unreadable.client, "post-1", NOW), { claimed: false, error: "statement timeout" });
});

Deno.test("an update that fails is an error, so the caller can send instead of dropping the notice", async () => {
  const { client } = fakePosts({ metadata: null, processing_started_at: "2026-10-30T11:00:00.000Z" }, { update: "permission denied" });
  assertEquals(await claimFinalNotification(client, "post-1", NOW), { claimed: false, error: "permission denied" });
});

Deno.test("a marker covers the cycle it was written in, not an earlier one", () => {
  assertEquals(markerCoversCycle(undefined, "2026-10-30T11:00:00.000Z"), false);
  assertEquals(markerCoversCycle("2026-10-30T11:30:00.000Z", "2026-10-30T11:00:00.000Z"), true);
  assertEquals(markerCoversCycle("2026-10-30T09:00:00.000Z", "2026-10-30T11:00:00.000Z"), false);
  // Without a recorded claim time a marker is taken to cover the post.
  assertEquals(markerCoversCycle("2026-10-30T09:00:00.000Z", null), true);
});
