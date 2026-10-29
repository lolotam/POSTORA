import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { primaryDeliveryUrl, registerDirectUpload, type DirectUploadFacts } from "./register.ts";
import type { DirectUploadSession } from "./session.ts";

const SESSION: DirectUploadSession = {
  v: 1,
  uid: "user-1",
  exp: 9_999_999_999,
  publicId: "postora_2026-10-29_user-1_7",
  folder: "media/u/2026-10-29",
  uploadDate: "2026-10-29",
  ext: "mp4",
  mime: "video/mp4",
  kind: "video",
  storedFileType: "video",
  size: 300,
  originalFilename: "clip.mp4",
  providers: ["openinary", "cloudinary"],
  required: ["openinary"],
  readPreference: "openinary",
  openinary: { folder: "postora.cloud/media/u/2026-10-29", fileName: "postora_2026-10-29_user-1_7.mp4" },
};

const OPENINARY = { path: "postora.cloud/media/u/2026-10-29/postora_2026-10-29_user-1_7.mp4", url: "https://o.example/t/x.mp4" };
const CLOUDINARY = { public_id: "media/u/2026-10-29/postora_2026-10-29_user-1_7", secure_url: "https://res.cloudinary.com/x.mp4", bytes: 300, duration: 12 };

/** Records every write; answers the duplicate lookup and the insert as configured. */
function fakeDb(options: { existing?: { id: string; file_path: string }; insertError?: string } = {}) {
  const writes: { table: string; rows: unknown }[] = [];
  const db = {
    writes,
    from(table: string) {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: () => Promise.resolve({ data: options.existing ?? null, error: null }),
        insert(rows: unknown) {
          writes.push({ table, rows });
          if (table === "media_file_providers") return Promise.resolve({ error: null });
          return {
            select: () => ({
              single: () => Promise.resolve(options.insertError
                ? { data: null, error: { message: options.insertError } }
                : { data: { id: "media-1" }, error: null }),
            }),
          };
        },
      };
      return query;
    },
  };
  return db;
}

/** The fake answers only the calls register.ts makes. */
function client(db: ReturnType<typeof fakeDb>): SupabaseClient {
  return db as unknown as SupabaseClient;
}

function facts(overrides: Partial<DirectUploadFacts> = {}): DirectUploadFacts {
  return { session: SESSION, cloudinary: null, openinary: OPENINARY, errors: [], ...overrides };
}

Deno.test("an Openinary-only upload records one library row and a ready provider row", async () => {
  const db = fakeDb();
  const outcome = await registerDirectUpload(client(db), client(db), facts({ session: { ...SESSION, providers: ["openinary"] } }));
  assertEquals(outcome.status, 200);
  assertEquals(outcome.body.mediaFileId, "media-1");
  assertEquals(outcome.body.url, OPENINARY.url);
  assertEquals(outcome.body.partial, false);
  const [library, providers] = db.writes;
  assertEquals(library.table, "media_files");
  const row = library.rows as Record<string, unknown>;
  assertEquals(row.storage_bucket, "openinary");
  assertEquals((row.metadata as Record<string, unknown>).direct_upload_id, SESSION.publicId);
  assertEquals(providers.rows, [{
    media_file_id: "media-1", provider: "openinary", object_version: 1, object_key: OPENINARY.path,
    status: "ready", delivery_url: OPENINARY.url, error: null, bytes: 300, mime_type: "video/mp4",
  }]);
});

Deno.test("a provider the browser failed on gets a failed row and the upload is partial", async () => {
  const db = fakeDb();
  const outcome = await registerDirectUpload(client(db), client(db), facts({ errors: ["cloudinary: HTTP 400 File size too large"] }));
  assertEquals(outcome.status, 200);
  assertEquals(outcome.body.partial, true);
  const rows = db.writes[1].rows as Record<string, unknown>[];
  assertEquals(rows.map((r) => [r.provider, r.status, r.error]), [
    ["openinary", "ready", null],
    ["cloudinary", "failed", "cloudinary: HTTP 400 File size too large"],
  ]);
});

Deno.test("nothing stored means no library row", async () => {
  const db = fakeDb();
  const outcome = await registerDirectUpload(client(db), client(db), facts({ openinary: null, errors: ["openinary: object not found after upload"] }));
  assertEquals(outcome.status, 502);
  assertEquals(db.writes.length, 0);
});

Deno.test("a retried complete returns the existing row instead of adding one", async () => {
  const db = fakeDb({ existing: { id: "media-0", file_path: OPENINARY.url } });
  const outcome = await registerDirectUpload(client(db), client(db), facts());
  assertEquals(outcome.body.mediaFileId, "media-0");
  assertEquals(db.writes.length, 0);
});

Deno.test("an insert error is not echoed to the browser", async () => {
  const db = fakeDb({ insertError: "permission denied for table media_files" });
  const outcome = await registerDirectUpload(client(db), client(db), facts());
  assertEquals(outcome.status, 500);
  assertEquals(outcome.body.error, "Could not save the upload to your library");
});

Deno.test("the read preference picks the served URL when that provider holds the file", () => {
  const both = { session: SESSION, openinary: OPENINARY, cloudinary: CLOUDINARY };
  assertEquals(primaryDeliveryUrl(both), OPENINARY.url);
  assertEquals(primaryDeliveryUrl({ ...both, session: { ...SESSION, readPreference: "cloudinary" } }), CLOUDINARY.secure_url);
  assertEquals(primaryDeliveryUrl({ ...both, openinary: null }), CLOUDINARY.secure_url);
});
