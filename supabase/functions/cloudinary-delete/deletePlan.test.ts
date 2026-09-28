import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { authorisedPublicIds, cloudinaryResourceTypeFor, deleteAuthorisedMediaFiles, isDisabledCloudResponse, openinaryObjectKeyMatches } from "./deletePlan.ts";

Deno.test("a foreign id is refused and a row with no provider is not deleted", async () => {
  const calls: string[] = [];
  const outcome = await deleteAuthorisedMediaFiles({
    requestedIds: ["foreign", "orphan", "ok"],
    rows: [
      { id: "orphan", user_id: "user", file_type: "document" },
      { id: "ok", user_id: "user", file_type: "image" },
    ],
    providers: [{ id: "p1", media_file_id: "ok", provider: "openinary", object_key: "a.png", status: "ready" }],
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
      { id: "p-img", media_file_id: "img", provider: "cloudinary", object_key: "img", status: "ready" },
      { id: "p-vid", media_file_id: "vid", provider: "cloudinary", object_key: "vid", status: "ready" },
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

Deno.test("a disabled Cloudinary account counts as nothing left, a failed provider row is skipped, a legacy row falls back", async () => {
  const reasons: string[] = [];
  const cloudinaryKeys: string[] = [];
  const outcome = await deleteAuthorisedMediaFiles({
    requestedIds: ["disabled", "never-stored", "legacy"],
    rows: [
      { id: "disabled", user_id: "user", file_type: "image" },
      { id: "never-stored", user_id: "user", file_type: "image" },
      { id: "legacy", user_id: "user", file_type: "video", cloudinary_public_id: "old/vid" },
    ],
    providers: [
      { id: "p-cld", media_file_id: "disabled", provider: "cloudinary", object_key: "c1", status: "ready" },
      { id: "p-oi", media_file_id: "disabled", provider: "openinary", object_key: "o1", status: "ready" },
      { id: "p-failed", media_file_id: "never-stored", provider: "cloudinary", object_key: "c2", status: "failed" },
    ],
    destroyOpeninary: async () => ({ success: true, reason: "removed" }),
    destroyCloudinary: async (key, resourceType) => {
      cloudinaryKeys.push(`${key}:${resourceType}`);
      return { success: true, reason: "provider_disabled" };
    },
    markDeleted: async (_id, reason) => { reasons.push(reason); return {}; },
  });
  assertEquals(outcome.results.map((result) => result.status), ["deleted", "deleted", "deleted"]);
  assertEquals(cloudinaryKeys, ["c1:image", "old/vid:video"]);
  assertEquals(reasons, ["provider_disabled", "user delete"]);
});

Deno.test("an openinary object key that does not match its delivery url is not destroyed", async () => {
  const destroyed: string[] = [];
  const marked: string[] = [];
  const outcome = await deleteAuthorisedMediaFiles({
    requestedIds: ["bad", "good"],
    rows: [
      { id: "bad", user_id: "user", file_type: "image", file_path: "https://cdn.example/t/postora.cloud/mine.png" },
      { id: "good", user_id: "user", file_type: "image", file_path: "https://cdn.example/t/postora.cloud/good.png" },
    ],
    providers: [
      {
        id: "p-bad",
        media_file_id: "bad",
        provider: "openinary",
        object_key: "postora.cloud/other-user/secret.png",
        status: "ready",
        delivery_url: "https://cdn.example/t/postora.cloud/mine.png",
      },
      {
        id: "p-good",
        media_file_id: "good",
        provider: "openinary",
        object_key: "postora.cloud/good.png",
        status: "ready",
        delivery_url: "https://cdn.example/t/postora.cloud/good.png",
      },
    ],
    destroyOpeninary: async (key) => {
      destroyed.push(key);
      return { success: true };
    },
    destroyCloudinary: async () => {
      throw new Error("unused");
    },
    markDeleted: async (id) => {
      marked.push(id);
      return {};
    },
  });
  assertEquals(destroyed, ["postora.cloud/good.png"]);
  assertEquals(marked, ["p-good"]);
  assertEquals(outcome.results[0], { id: "bad", status: "failed", error: "provider object mismatch" });
  assertEquals(outcome.results[1].status, "deleted");
  assertEquals(outcome.mismatchCount, 1);
  assertEquals(openinaryObjectKeyMatches("postora.cloud/a.png", null, null), true);
  assertEquals(openinaryObjectKeyMatches("postora.cloud/a.png", null, "postora.cloud/a.png"), true);
  assertEquals(openinaryObjectKeyMatches("postora.cloud/secret.png", "https://cdn.example/t/postora.cloud/mine.png", "postora.cloud/secret.png"), false);
});

Deno.test("missing Cloudinary credentials are a real failure, not a disabled account", async () => {
  const outcome = await deleteAuthorisedMediaFiles({
    requestedIds: ["img"],
    rows: [{ id: "img", user_id: "user", file_type: "image" }],
    providers: [{ id: "p", media_file_id: "img", provider: "cloudinary", object_key: "c", status: "ready" }],
    destroyOpeninary: async () => ({ success: true }),
    destroyCloudinary: async () => ({ success: false, error: "cloudinary credentials unavailable" }),
    markDeleted: async () => ({}),
  });
  assertEquals(outcome.results[0].status, "failed");
  assertEquals(isDisabledCloudResponse(401, "cloud_name is disabled"), true);
  assertEquals(isDisabledCloudResponse(401, "Invalid Signature"), false);
  assertEquals(isDisabledCloudResponse(500, "disabled"), false);
});
