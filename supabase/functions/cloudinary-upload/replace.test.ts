import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  mergeReplaceMetadata,
  nextObjectVersion,
  planProviderRetirement,
  replaceKindsMatch,
  scheduledMatchUrls,
  targetMediaKind,
  type ReplaceProviderRow,
} from "./replace.ts";

Deno.test("replace kind follows metadata.kind, and a legacy row without it follows mime and file_type", () => {
  assertEquals(replaceKindsMatch(targetMediaKind({
    metadata: { kind: "video" },
    file_type: "image",
    mime_type: "image/png",
  }), "video"), true);

  assertEquals(replaceKindsMatch(targetMediaKind({
    metadata: null,
    file_type: "gif",
    mime_type: "image/gif",
  }), "image"), true);

  assertEquals(replaceKindsMatch(targetMediaKind({
    metadata: {},
    file_type: "image",
    mime_type: null,
  }), "image"), true);

  const legacyZip = targetMediaKind({ metadata: null, file_type: "document", mime_type: "application/zip" });
  assertEquals(legacyZip, "archive");
  assertEquals(replaceKindsMatch(legacyZip, "document"), false);

  assertEquals(targetMediaKind({
    metadata: { kind: "archive" },
    file_type: "document",
    mime_type: "application/pdf",
  }), "archive");
});

Deno.test("next object version is one past the highest stored version", () => {
  assertEquals(nextObjectVersion(2, [1, 2, 4]), 5);
  assertEquals(nextObjectVersion(null, []), 2);
  assertEquals(nextObjectVersion(1, [7]), 8);
  assertEquals(nextObjectVersion(undefined, [null]), 2);
});

Deno.test("retirement skips deleted, failed, and the version just written, and refuses an Openinary key mismatch", () => {
  const nextVersion = 3;
  const matchingKey = "postora.cloud/media/old.png";
  const rows: ReplaceProviderRow[] = [
    { id: "gone", provider: "cloudinary", object_version: 1, object_key: "old-cloud", status: "deleted", delivery_url: "https://cdn.example/old" },
    { id: "never-stored", provider: "openinary", object_version: 1, object_key: matchingKey, status: "failed", delivery_url: null },
    { id: "just-written", provider: "cloudinary", object_version: 3, object_key: "new-cloud", status: "ready", delivery_url: "https://cdn.example/new" },
    { id: "old-cloud", provider: "cloudinary", object_version: 2, object_key: "cloud-2", status: "ready", delivery_url: "https://cdn.example/cloud-2" },
    {
      id: "old-open",
      provider: "openinary",
      object_version: 2,
      object_key: matchingKey,
      status: "ready",
      delivery_url: "https://cdn.example/t/postora.cloud/media/old.png",
    },
    {
      id: "mismatch",
      provider: "openinary",
      object_version: 2,
      object_key: "postora.cloud/media/someone-else.png",
      status: "ready",
      delivery_url: "https://cdn.example/t/postora.cloud/media/old.png",
    },
  ];

  assertEquals(planProviderRetirement(rows, nextVersion, "https://cdn.example/t/postora.cloud/media/old.png"), [
    { action: "skip", id: "gone", reason: "deleted" },
    { action: "skip", id: "never-stored", reason: "failed" },
    { action: "skip", id: "just-written", reason: "current_version" },
    { action: "retire", id: "old-cloud" },
    { action: "retire", id: "old-open" },
    { action: "refuse", id: "mismatch", reason: "key_mismatch" },
  ]);
});

Deno.test("pending scheduled messages match the old file path and every old delivery URL once", () => {
  assertEquals(scheduledMatchUrls(" https://cdn.example/file.png ", [
    "https://cdn.example/file.png",
    " https://cdn.example/openinary.png ",
    "",
    null,
    "https://cdn.example/cloud.png",
  ]), [
    "https://cdn.example/file.png",
    "https://cdn.example/openinary.png",
    "https://cdn.example/cloud.png",
  ]);
});

Deno.test("metadata merge keeps the display name and replaces the new file's own fields", () => {
  assertEquals(mergeReplaceMetadata(
    { original_filename: "holiday.png", width: 10, folder: "trips" },
    { width: 640, height: 480, format: "png", duration: null, kind: "image" },
  ), {
    original_filename: "holiday.png",
    width: 640,
    height: 480,
    format: "png",
    duration: null,
    kind: "image",
    folder: "trips",
  });
});
