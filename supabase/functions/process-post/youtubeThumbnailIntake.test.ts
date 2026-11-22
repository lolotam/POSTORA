import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  isExternalThumbnailUrl,
  resolveYoutubeThumbnail,
  thumbnailSourceOf,
} from "./youtubeThumbnailIntake.ts";
import { approvedMediaHosts } from "./youtubeUploadPolicy.ts";
import type { MediaFile } from "./mediaDelivery.ts";

const OWNER = "owner-1";
const HOSTS = approvedMediaHosts({ supabaseUrl: "https://api.example.test", cdnOrigins: [] });

const fakeSupabase = {
  from: (table: string) => ({
    select: () => ({
      in: async () => table === "media_file_providers" ? { data: [] } : { data: [], error: null },
      eq: async () => ({ data: null, error: null }),
    }),
  }),
  storage: {
    from: () => ({
      createSignedUrl: async () => ({
        data: { signedUrl: "https://api.example.test/storage/v1/object/sign/media/signed" },
        error: null,
      }),
    }),
  },
} as never;

const ownedRow: MediaFile = {
  id: "media-1",
  user_id: OWNER,
  file_path: `${OWNER}/thumbnail.jpg`,
  file_type: "image",
  storage_bucket: "media",
  mime_type: "image/jpeg",
  current_object_version: 1,
};

Deno.test("thumbnail source keeps owned media ids separate from external URLs", () => {
  assertEquals(thumbnailSourceOf({ youtube_thumbnail_media_id: "m1", youtube_thumbnail_url: "https://cdn.example.test/x.jpg" }), { kind: "owned", id: "m1" });
  assertEquals(thumbnailSourceOf({ youtube_thumbnail_url: "https://cdn.example.test/x.jpg" }), { kind: "external", url: "https://cdn.example.test/x.jpg" });
  assertEquals(thumbnailSourceOf({}), null);
  assertEquals(isExternalThumbnailUrl("http://example.test/x.jpg"), false);
});

Deno.test("an external thumbnail is accepted only from an approved HTTPS host", async () => {
  const ports = {
    supabase: fakeSupabase,
    loadOwnedMedia: () => Promise.resolve({ ok: true as const, row: null }),
    allowedWorkspaceIds: new Set<string>(),
    mediaHosts: HOSTS,
  };
  assertEquals(
    await resolveYoutubeThumbnail(ports, OWNER, { youtube_thumbnail_url: "https://api.example.test/thumb.jpg" }),
    { ok: true, url: "https://api.example.test/thumb.jpg", source: "external_url" },
  );
  assertEquals(
    await resolveYoutubeThumbnail(ports, OWNER, { youtube_thumbnail_url: "https://evil.test/thumb.jpg" }),
    { ok: false, reason: "origin_not_approved" },
  );
});

Deno.test("an owned thumbnail must resolve under the post owner's identity", async () => {
  const base = {
    supabase: fakeSupabase,
    allowedWorkspaceIds: new Set<string>(),
    mediaHosts: HOSTS,
  };
  const refused = await resolveYoutubeThumbnail({
    ...base,
    loadOwnedMedia: () => Promise.resolve({ ok: true as const, row: { ...ownedRow, user_id: "someone-else" } }),
  }, OWNER, { youtube_thumbnail_media_id: "media-1" });
  assertEquals(refused, { ok: false, reason: "not_owned" });

  const accepted = await resolveYoutubeThumbnail({
    ...base,
    loadOwnedMedia: (_id, ownerId) => Promise.resolve({ ok: true as const, row: ownerId === OWNER ? ownedRow : null }),
  }, OWNER, { youtube_thumbnail_media_id: "media-1" });
  assertEquals(accepted.ok, true);
});

function signingSupabase() {
  const calls = { signs: 0, reads: 0 };
  const client = {
    from: () => ({
      select: () => ({
        in: async () => {
          calls.reads += 1;
          return { data: [] };
        },
        eq: async () => {
          calls.reads += 1;
          return { data: null, error: null };
        },
      }),
    }),
    storage: {
      from: () => ({
        createSignedUrl: async () => {
          calls.signs += 1;
          return { data: { signedUrl: "https://api.example.test/signed" }, error: null };
        },
      }),
    },
  } as never;
  return { client, calls };
}

Deno.test("a failed owner-bound read is reported separately from an absent or refused row", async () => {
  const ports = {
    supabase: fakeSupabase,
    loadOwnedMedia: () => Promise.resolve({ ok: false as const, reason: "read_error" as const }),
    allowedWorkspaceIds: new Set<string>(),
    mediaHosts: HOSTS,
  };
  assertEquals(
    await resolveYoutubeThumbnail(ports, OWNER, { youtube_thumbnail_media_id: "media-1" }),
    { ok: false, reason: "read_error" },
  );
});

Deno.test("a blocked scan fixture is refused before any signature or media read", async () => {
  for (const scanState of ["pending", "rejected"]) {
    const { client, calls } = signingSupabase();
    const result = await resolveYoutubeThumbnail({
      supabase: client,
      loadOwnedMedia: () => Promise.resolve({
        ok: true as const,
        row: { ...ownedRow, scan_state: scanState } as MediaFile,
      }),
      allowedWorkspaceIds: new Set<string>(),
      mediaHosts: HOSTS,
    }, OWNER, { youtube_thumbnail_media_id: "media-1" });
    assertEquals(result, { ok: false, reason: "unavailable" });
    assertEquals(calls.signs, 0);
    assertEquals(calls.reads, 0);
  }
});

Deno.test("a non-image is refused before any signature or media read", async () => {
  const { client, calls } = signingSupabase();
  const result = await resolveYoutubeThumbnail({
    supabase: client,
    loadOwnedMedia: () => Promise.resolve({
      ok: true as const,
      row: { ...ownedRow, file_type: "video", mime_type: "video/mp4" },
    }),
    allowedWorkspaceIds: new Set<string>(),
    mediaHosts: HOSTS,
  }, OWNER, { youtube_thumbnail_media_id: "media-1" });
  assertEquals(result, { ok: false, reason: "not_image" });
  assertEquals(calls.signs, 0);
  assertEquals(calls.reads, 0);
});

Deno.test("a mismatched image type and MIME is refused with zero side effects", async () => {
  const { client, calls } = signingSupabase();
  const result = await resolveYoutubeThumbnail({
    supabase: client,
    loadOwnedMedia: () => Promise.resolve({
      ok: true as const,
      row: { ...ownedRow, file_type: "image", mime_type: "video/mp4" },
    }),
    allowedWorkspaceIds: new Set<string>(),
    mediaHosts: HOSTS,
  }, OWNER, { youtube_thumbnail_media_id: "media-1" });
  assertEquals(result, { ok: false, reason: "not_image" });
  assertEquals(calls.signs, 0);
  assertEquals(calls.reads, 0);
});

Deno.test("an SVG thumbnail is refused with zero side effects", async () => {
  const { client, calls } = signingSupabase();
  const result = await resolveYoutubeThumbnail({
    supabase: client,
    loadOwnedMedia: () => Promise.resolve({
      ok: true as const,
      row: { ...ownedRow, file_type: "image", mime_type: "image/svg+xml" },
    }),
    allowedWorkspaceIds: new Set<string>(),
    mediaHosts: HOSTS,
  }, OWNER, { youtube_thumbnail_media_id: "media-1" });
  assertEquals(result, { ok: false, reason: "not_image" });
  assertEquals(calls.signs, 0);
  assertEquals(calls.reads, 0);
});
