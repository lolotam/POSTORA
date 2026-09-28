import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { deleteClaimedMediaRow, markProviderDeleted } from "./deps.ts";

type Row = Record<string, unknown>;

function matches(rows: Row[], filters: Array<[string, unknown]>): Row[] {
  return rows.filter((row) => filters.every(([column, value]) => row[column] === value));
}

/** Applies eq filters the way the service-role client would, and returns the matched ids. */
function fakeSupabase(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const rows = () => tables[table];
      return {
        delete() {
          const filters: Array<[string, unknown]> = [];
          return {
            eq(column: string, value: unknown) {
              filters.push([column, value]);
              return this;
            },
            select(_columns: string) {
              const hits = matches(rows(), filters);
              const ids = new Set(hits.map((row) => row.id));
              tables[table] = rows().filter((row) => !ids.has(row.id));
              return Promise.resolve({ data: hits.map((row) => ({ id: row.id })), error: null });
            },
          };
        },
        update(values: Record<string, unknown>) {
          const filters: Array<[string, unknown]> = [];
          return {
            eq(column: string, value: unknown) {
              filters.push([column, value]);
              return this;
            },
            select(_columns: string) {
              const hits = matches(rows(), filters);
              for (const row of hits) Object.assign(row, values);
              return Promise.resolve({ data: hits.map((row) => ({ id: row.id })), error: null });
            },
          };
        },
        select(_columns: string) {
          const filters: Array<[string, unknown]> = [];
          return {
            eq(column: string, value: unknown) {
              filters.push([column, value]);
              return this;
            },
            maybeSingle() {
              const hits = matches(rows(), filters);
              return Promise.resolve({ data: hits[0] ?? null, error: null });
            },
          };
        },
      };
    },
  };
}

Deno.test("a delete with a mismatched user_id removes nothing", async () => {
  const tables = {
    media_files: [{ id: "file-1", user_id: "owner", retention_state: "deleting" }],
  };
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    const result = await deleteClaimedMediaRow(fakeSupabase(tables) as never, "file-1", "other");
    assertEquals(result.removed, false);
    assertEquals(result.stillDeleting, true);
    assertEquals(tables.media_files, [{ id: "file-1", user_id: "owner", retention_state: "deleting" }]);
    const logged = JSON.stringify(errors);
    assertEquals(logged.includes("file-1"), false);
    assertEquals(logged.includes("owner"), false);
    assertEquals(logged.includes("other"), false);
  } finally {
    console.error = original;
  }
});

Deno.test("a row not in deleting is not removed", async () => {
  const tables = {
    media_files: [{ id: "file-1", user_id: "owner", retention_state: "warned" }],
  };
  const result = await deleteClaimedMediaRow(fakeSupabase(tables) as never, "file-1", "owner");
  assertEquals(result, { removed: false, stillDeleting: false });
  assertEquals(tables.media_files[0].retention_state, "warned");
});

Deno.test("markDeleted does not change a provider row for a different media file", async () => {
  const tables = {
    media_file_providers: [{ id: "prov-1", media_file_id: "file-1", status: "ready" }],
  };
  const client = fakeSupabase(tables);
  const missed = await markProviderDeleted(client as never, "prov-1", "file-2");
  assertEquals(missed, { error: "provider status update failed" });
  assertEquals(tables.media_file_providers[0].status, "ready");

  const marked = await markProviderDeleted(client as never, "prov-1", "file-1");
  assertEquals(marked, {});
  assertEquals(tables.media_file_providers[0].status, "deleted");
});
