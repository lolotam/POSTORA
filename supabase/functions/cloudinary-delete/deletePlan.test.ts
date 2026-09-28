import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { authorisedPublicIds, cloudinaryResourceTypeFor, deleteAuthorisedMediaFiles } from "./deletePlan.ts";

Deno.test("a foreign id is refused and a row with no provider is not deleted", async () => {
  const calls: string[] = [];
  const outcome = await deleteAuthorisedMediaFiles({
    requestedIds: ["foreign", "orphan", "ok"],
    rows: [
      { id: "orphan", user_id: "user", file_type: "document" },
      { id: "ok", user_id: "user", file_type: "image" },
    ],
    providers: [{ id: "p1", media_file_id: "ok", provider: "openinary", object_key: "a.png" }],
    destroyOpeninary: async (key) => { calls.push(key); return { success: true }; },
    destroyCloudinary: async () => { throw new Error("unused"); },
    markDeleted: async () => ({ }),
  });
  assertEquals(outcome.results.map((result) => result.status), ["refused", "failed", "deleted"]);
  assertEquals(outcome.deletedMediaFileIds, ["ok"]);
  assertEquals(calls, ["a.png"]);
});

Deno.test("a partial delete keeps the failed id and a mixed batch uses each resource type", async () => {
  const resources: string[] = [];
  const outcome = await deleteAuthorisedMediaFiles({
    requestedIds: ["img", "vid"],
    rows: [
      { id: "img", user_id: "user", file_type: "image" },
      { id: "vid", user_id: "user", file_type: "video" },
    ],
    providers: [
      { id: "p-img", media_file_id: "img", provider: "cloudinary", object_key: "img" },
      { id: "p-vid", media_file_id: "vid", provider: "cloudinary", object_key: "vid" },
    ],
    destroyOpeninary: async () => ({ success: true }),
    destroyCloudinary: async (key, resourceType) => {
      resources.push(`${key}:${resourceType}`);
      if (key === "vid") return { success: false, error: "no" };
      return { success: true };
    },
    markDeleted: async (id) => (id === "p-img" ? { error: "status failed" } : {}),
  });
  assertEquals(resources, ["img:image", "vid:video"]);
  assertEquals(outcome.deletedMediaFileIds, []);
  assertEquals(outcome.failedMediaFileIds, ["img", "vid"]);
  assertEquals(cloudinaryResourceTypeFor("document"), "raw");
});

Deno.test("a legacy public id is destroyed only when an authorised row owns it", () => {
  const plan = authorisedPublicIds(["owned-image", "owned-video", "foreign"], [
    { id: "1", user_id: "user", file_type: "image", cloudinary_public_id: "owned-image" },
    { id: "2", user_id: "user", file_type: "video", cloudinary_public_id: "owned-video" },
  ]);
  assertEquals(plan.refused, ["foreign"]);
  assertEquals(plan.allowed.map((item) => item.resourceType), ["image", "video"]);
});
