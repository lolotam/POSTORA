import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  commitMediaReplace,
  mergeReplaceMetadata,
  nextObjectVersion,
  replaceKindsMatch,
  scheduledMatchUrls,
  targetMediaKind,
  type ReplaceTargetRow,
  type ReplaceUploadFacts,
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

// Fake PostgREST: every chain resolves to the canned result for its table and verb,
// and every update's payload is recorded so the test can see what was written.
function fakeDb(results: { sentMessages: number; scheduledError?: boolean }) {
  const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const from = (table: string) => {
    let verb = "select";
    let payload: Record<string, unknown> = {};
    const outcome = () => {
      if (table === "media_file_providers" && verb === "select") {
        return { data: [{ id: "old-openinary", provider: "openinary", object_version: 1, object_key: "p/old.png", status: "ready", delivery_url: "https://o.example/t/p/old.png" }], error: null };
      }
      if (table === "media_files" && verb === "update") return { data: [{ id: "file-1" }], error: null };
      if (table === "whatsapp_scheduled_messages") {
        return results.scheduledError ? { data: null, error: { message: "boom" } } : { data: [], error: null };
      }
      if (table === "whatsapp_messages") return { count: results.sentMessages, error: null };
      return { data: null, error: null };
    };
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "is", "or"]) chain[method] = () => chain;
    chain.insert = () => { verb = "insert"; return chain; };
    chain.update = (body: Record<string, unknown>) => { verb = "update"; payload = body; updates.push({ table, payload }); return chain; };
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(outcome()).then(resolve);
    return chain;
  };
  return { db: { from }, updates };
}

const target: ReplaceTargetRow = {
  id: "file-1", file_path: "https://o.example/t/p/old.png", file_type: "image", mime_type: "image/png",
  storage_bucket: "openinary", metadata: { original_filename: "old.png", kind: "image" }, current_object_version: 1, retention_state: null,
};
const facts: ReplaceUploadFacts = {
  userId: "user-1", primaryUrl: "https://o.example/t/p/new.png", bytes: 10, mimeType: "image/png", storedFileType: "image", kind: "image",
  width: null, height: null, format: "png", duration: null, storageBucket: "openinary", storedIn: ["openinary"], errors: [],
  providersAttempted: ["openinary"], cloudinaryPublicId: null, cloudinaryDeliveryUrl: null, cloudinaryFallbackKey: "k",
  openinaryPath: "p/new.png", openinaryUrl: "https://o.example/t/p/new.png", openinaryFallbackKey: "k",
};

Deno.test("replace swaps the row and never deletes the previous version's objects", async () => {
  for (const scenario of [{ sentMessages: 2 }, { sentMessages: 0, scheduledError: true }, { sentMessages: 0 }]) {
    const { db, updates } = fakeDb(scenario);
    const outcome = await commitMediaReplace(db, target, facts);
    assertEquals(outcome.status, 200);
    assertEquals(outcome.body.mediaFileId, "file-1");
    const fileUpdate = updates.find((u) => u.table === "media_files");
    assertEquals(fileUpdate?.payload.file_path, facts.primaryUrl);
    assertEquals(fileUpdate?.payload.current_object_version, 2);
    assertEquals(updates.some((u) => u.table === "media_file_providers" && u.payload.status === "deleted"), false);
  }
});
