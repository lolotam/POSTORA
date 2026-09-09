import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  refreshReasonFor,
  type GraphActivity,
  type PublishedExport,
} from "./dueUsers.ts";

const OPENINARY =
  "https://openinary.walidmohamed.com/t/postora.cloud/media/someone_at_example_com/knowledge-graph/graph.html";
const OPENINARY_VAULT =
  "https://openinary.walidmohamed.com/t/postora.cloud/media/someone_at_example_com/knowledge-graph/obsidian-vault.zip";

function activity(overrides: Partial<GraphActivity> = {}): GraphActivity {
  return {
    userId: "11111111-1111-1111-1111-111111111111",
    entityCount: 8,
    relationCount: 5,
    newestActivity: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

function published(overrides: Partial<PublishedExport> = {}): PublishedExport {
  return {
    htmlUrl: OPENINARY,
    vaultUrl: OPENINARY_VAULT,
    generatedAt: "2026-09-02T00:00:00Z",
    entityCount: 8,
    relationCount: 5,
    ...overrides,
  };
}

Deno.test("a current export on a renderable host is not due", () => {
  assertEquals(refreshReasonFor(activity(), published()), null);
});

Deno.test("a user with entities and no export row has never been exported", () => {
  assertEquals(refreshReasonFor(activity(), null), "never_exported");
});

Deno.test("a user with no entities and no export is never due", () => {
  // Otherwise every account that has never touched the knowledge base would be
  // reported as due on every run, forever.
  assertEquals(
    refreshReasonFor(activity({ entityCount: 0, relationCount: 0 }), null),
    null,
  );
});

Deno.test("an export row with no generated_at counts as never exported", () => {
  assertEquals(
    refreshReasonFor(activity(), published({ generatedAt: null })),
    "never_exported",
  );
});

Deno.test("a storage-hosted export is due even when nothing has changed", () => {
  // The bug this rule exists for: Supabase Storage serves graph.html as
  // text/plain, so this row can only ever show source code in a browser. Its
  // counts and timestamps are all current, so no other rule would catch it.
  const legacyPublicUrl =
    "https://api.postora.cloud/storage/v1/object/public/ai-knowledge/media/someone_at_example_com/knowledge-graph/graph.html";
  const durableRef =
    "supabase://ai-knowledge/media/someone_at_example_com/knowledge-graph/graph.html";

  for (const stored of [legacyPublicUrl, durableRef]) {
    assertEquals(
      refreshReasonFor(activity(), published({ htmlUrl: stored })),
      "unrenderable_host",
    );
  }
});

Deno.test("a half-published export is due on the missing half", () => {
  assertEquals(
    refreshReasonFor(activity(), published({ vaultUrl: null })),
    "unrenderable_host",
  );
});

Deno.test("an unviewable link outranks an out-of-date one", () => {
  // Both conditions hold. The reason is logged, so it should name the worse
  // problem rather than whichever check happened to run first.
  const stale = published({
    htmlUrl: "supabase://ai-knowledge/media/someone_at_example_com/knowledge-graph/graph.html",
    generatedAt: "2026-08-01T00:00:00Z",
    entityCount: 1,
  });
  assertEquals(refreshReasonFor(activity(), stale), "unrenderable_host");
});

Deno.test("deleting an entity is only visible in the counts", () => {
  // The nightly prune deletes orphan entities. Deletion moves no created_at, so
  // newestActivity is still older than generated_at and only the count betrays
  // that the published graph is wrong.
  const afterPrune = activity({ entityCount: 3, newestActivity: "2026-08-01T00:00:00Z" });
  assertEquals(refreshReasonFor(afterPrune, published()), "count_changed");
});

Deno.test("a row written before the count columns existed refreshes once", () => {
  assertEquals(
    refreshReasonFor(
      activity({ newestActivity: "2026-08-01T00:00:00Z" }),
      published({ entityCount: null, relationCount: null }),
    ),
    "count_changed",
  );
});

Deno.test("indexing after the export was written makes it due", () => {
  assertEquals(
    refreshReasonFor(
      activity({ newestActivity: "2026-09-03T00:00:00Z" }),
      published(),
    ),
    "new_activity",
  );
});

Deno.test("activity exactly at the export timestamp is not new", () => {
  assertEquals(
    refreshReasonFor(
      activity({ newestActivity: "2026-09-02T00:00:00Z" }),
      published({ generatedAt: "2026-09-02T00:00:00Z" }),
    ),
    null,
  );
});

Deno.test("an unparseable timestamp leaves the export alone", () => {
  // Answering "due" here would rebuild this user's graph on every run for the
  // rest of the system's life, because nothing about a corrupt value changes.
  for (const corrupt of ["not a date", ""]) {
    assertEquals(refreshReasonFor(activity({ newestActivity: corrupt }), published()), null);
  }
  assertEquals(
    refreshReasonFor(activity(), published({ generatedAt: "not a date" })),
    null,
  );
});

Deno.test("a foreign-bucket URL is not treated as renderable", () => {
  // parseExportUrlTarget only maps a storage URL back to a path for the expected
  // bucket. Another bucket's public URL is structurally a storage link, and
  // classifying it as an external delivery URL would leave it published forever.
  assertEquals(
    refreshReasonFor(
      activity(),
      published({
        htmlUrl:
          "https://api.postora.cloud/storage/v1/object/public/some-other-bucket/graph.html",
      }),
    ),
    "unrenderable_host",
  );
});

Deno.test("a user whose graph is now empty is due once, then quiet", () => {
  // The worker feeds this shape for a user the activity rollup no longer covers
  // because they have neither entities nor relations left -- what the 03:15
  // prune does to a user whose extraction produced no relations. Without it
  // their graph of deleted data stays on a public URL forever.
  const emptied = activity({ entityCount: 0, relationCount: 0, newestActivity: null });

  assertEquals(refreshReasonFor(emptied, published()), "count_changed");
  // And once the empty graph is published, they stop being reported every night.
  assertEquals(
    refreshReasonFor(emptied, published({ entityCount: 0, relationCount: 0 })),
    null,
  );
});
