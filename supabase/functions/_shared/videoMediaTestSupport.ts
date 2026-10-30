/** Test-only: an in-memory stand-in for the two tables video processing reads and writes. */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { ProviderRow, VideoMediaRow } from "./derivedVideoMedia.ts";

export interface FakeDbState {
  mediaFiles: VideoMediaRow[];
  providers: (ProviderRow & { media_file_id: string })[];
  inserted: { table: string; row: Record<string, unknown> }[];
  /** Error message the next media_files insert should fail with. */
  mediaInsertError?: string;
  providerInsertError?: string;
  /** Error message a read of this table should fail with. */
  readError?: Partial<Record<"media_files" | "media_file_providers", string>>;
}

export function fakeDb(initial: Partial<FakeDbState> = {}): { db: SupabaseClient; state: FakeDbState } {
  const state: FakeDbState = { mediaFiles: [], providers: [], inserted: [], ...initial };
  const db = {
    from(table: string) {
      const filters: [string, unknown][] = [];
      const rows = (): Record<string, unknown>[] =>
        (table === "media_files" ? state.mediaFiles : state.providers as unknown as Record<string, unknown>[])
          .filter((row) => filters.every(([column, value]) => (row as Record<string, unknown>)[column] === value)) as Record<string, unknown>[];
      const query = {
        select() { return query; },
        eq(column: string, value: unknown) { filters.push([column, value]); return query; },
        maybeSingle() {
          const failure = state.readError?.[table as "media_files"];
          return Promise.resolve(failure ? { data: null, error: { message: failure } } : { data: rows()[0] ?? null, error: null });
        },
        then(resolve: (value: { data: unknown[] | null; error: { message: string } | null }) => unknown) {
          const failure = state.readError?.[table as "media_file_providers"];
          return Promise.resolve(failure ? { data: null, error: { message: failure } } : { data: rows(), error: null }).then(resolve);
        },
        insert(row: Record<string, unknown>) {
          state.inserted.push({ table, row });
          const failure = table === "media_files" ? state.mediaInsertError : state.providerInsertError;
          const result = failure
            ? { data: null, error: { message: failure } }
            : { data: { id: "new-media-id" }, error: null };
          const done = {
            select() { return done; },
            single() { return Promise.resolve(result); },
            then(resolve: (value: { error: { message: string } | null }) => unknown) { return Promise.resolve({ error: result.error }).then(resolve); },
          };
          return done;
        },
      };
      return query;
    },
  };
  return { db: db as unknown as SupabaseClient, state };
}

export function videoRow(overrides: Partial<VideoMediaRow> = {}): VideoMediaRow {
  return {
    id: "media-1",
    user_id: "user-1",
    file_path: "https://cdn.example.test/t/postora.cloud/media/u_at_x_com/2026-10-29/postora_2026-10-29_user-1_1.mp4",
    file_type: "video",
    file_size: 10_000_000,
    storage_bucket: "openinary",
    cloudinary_public_id: null,
    platforms: ["tiktok"],
    social_account_ids: ["acct-1"],
    metadata: { width: 1920, height: 1080 },
    ...overrides,
  };
}

export const readyOpeninary = (objectKey: string, version = 1): ProviderRow & { media_file_id: string } => ({
  media_file_id: "media-1",
  provider: "openinary",
  object_key: objectKey,
  status: "ready",
  delivery_url: null,
  object_version: version,
});
