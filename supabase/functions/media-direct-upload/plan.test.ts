import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { cloudinaryPublicIdMatches, planDirectUpload } from "./plan.ts";
import { parseCdnPolicy } from "../cloudinary-upload/providerPolicy.ts";

const MB = 1024 * 1024;
const OPENINARY_ONLY = parseCdnPolicy({ write_policy: { providers: ["openinary"], required: ["openinary"] }, openinary: { enabled: true } });
const CLOUDINARY_ONLY = parseCdnPolicy({ write_policy: { providers: ["cloudinary"], required: ["cloudinary"] }, read_preference: "cloudinary" });
const BOTH = parseCdnPolicy({ write_policy: { providers: ["cloudinary", "openinary"], required: ["openinary"] }, openinary: { enabled: true } });
const ALL_USABLE = { cloudinary: true, openinaryConfigured: true };

Deno.test("a 500 MB video is allowed and one byte more is refused with 413", () => {
  const ok = planDirectUpload({ fileName: "clip.mp4", size: 500 * MB, mimeType: "video/mp4" }, OPENINARY_ONLY, ALL_USABLE);
  assertEquals(ok.ok, true);
  const over = planDirectUpload({ fileName: "clip.mp4", size: 500 * MB + 1, mimeType: "video/mp4" }, OPENINARY_ONLY, ALL_USABLE);
  assertEquals(over, { ok: false, status: 413, error: "File exceeds the 500 MB limit", reason: "kind_cap" });
});

Deno.test("images are capped at 20 MB", () => {
  assertEquals(planDirectUpload({ fileName: "photo.jpg", size: 20 * MB, mimeType: "image/jpeg" }, OPENINARY_ONLY, ALL_USABLE).ok, true);
  const over = planDirectUpload({ fileName: "photo.jpg", size: 20 * MB + 1, mimeType: "image/jpeg" }, OPENINARY_ONLY, ALL_USABLE);
  assertEquals(over.ok ? null : over.error, "File exceeds the 20 MB limit");
});

Deno.test("documents, audio and excluded types have no direct path", () => {
  for (const [fileName, mimeType] of [["deck.pdf", "application/pdf"], ["song.mp3", "audio/mpeg"], ["bundle.zip", "application/zip"]]) {
    const plan = planDirectUpload({ fileName, size: 11 * MB, mimeType }, OPENINARY_ONLY, ALL_USABLE);
    assertEquals(plan.ok ? null : plan.reason, "kind", fileName);
  }
  const excluded = planDirectUpload({ fileName: "clip.avi", size: 11 * MB, mimeType: "video/x-msvideo" }, OPENINARY_ONLY, ALL_USABLE);
  assertEquals(excluded.ok ? null : excluded.reason, "type");
});

Deno.test("zero, negative and fractional sizes are refused", () => {
  for (const size of [0, -1, 1.5, Number.NaN]) {
    const plan = planDirectUpload({ fileName: "clip.mp4", size, mimeType: "video/mp4" }, OPENINARY_ONLY, ALL_USABLE);
    assertEquals(plan.ok ? null : plan.reason, "size", String(size));
  }
});

Deno.test("the admin's provider setting decides the targets, Openinary first", () => {
  const openinary = planDirectUpload({ fileName: "clip.mp4", size: 50 * MB }, OPENINARY_ONLY, ALL_USABLE);
  assertEquals(openinary.ok && openinary.providers, ["openinary"]);
  const cloudinary = planDirectUpload({ fileName: "clip.mp4", size: 50 * MB }, CLOUDINARY_ONLY, ALL_USABLE);
  assertEquals(cloudinary.ok && cloudinary.providers, ["cloudinary"]);
  const both = planDirectUpload({ fileName: "clip.mp4", size: 50 * MB }, BOTH, ALL_USABLE);
  assertEquals(both.ok && both.providers, ["openinary", "cloudinary"]);
});

Deno.test("an unreachable chosen provider falls back to the usable one", () => {
  const plan = planDirectUpload({ fileName: "clip.mp4", size: 50 * MB }, OPENINARY_ONLY, { cloudinary: true, openinaryConfigured: false });
  assertEquals(plan.ok && plan.providers, ["cloudinary"]);
  const none = planDirectUpload({ fileName: "clip.mp4", size: 50 * MB }, OPENINARY_ONLY, { cloudinary: false, openinaryConfigured: false });
  assertEquals(none.ok ? null : none.status, 503);
});

Deno.test("Cloudinary public ids match with or without the folder", () => {
  assertEquals(cloudinaryPublicIdMatches("media/u/2026-10-29/postora_x_1", "postora_x_1"), true);
  assertEquals(cloudinaryPublicIdMatches("postora_x_1", "postora_x_1"), true);
  assertEquals(cloudinaryPublicIdMatches("media/u/postora_x_12", "postora_x_1"), false);
  assertEquals(cloudinaryPublicIdMatches("evil/postora_x_1_copy", "postora_x_1"), false);
});

Deno.test("the admin's limits replace the defaults", () => {
  const limits = { image_max_mb: 50, video_max_mb: 100 };
  const over = planDirectUpload({ fileName: "clip.mp4", size: 150 * MB, mimeType: "video/mp4" }, OPENINARY_ONLY, ALL_USABLE, limits);
  assertEquals(over.ok ? null : over.error, "File exceeds the 100 MB limit");
  assertEquals(planDirectUpload({ fileName: "photo.jpg", size: 50 * MB }, OPENINARY_ONLY, ALL_USABLE, limits).ok, true);
  const huge = { image_max_mb: 20, video_max_mb: 2000 };
  assertEquals(planDirectUpload({ fileName: "clip.mp4", size: 2000 * MB }, OPENINARY_ONLY, ALL_USABLE, huge).ok, true);
  assertEquals(planDirectUpload({ fileName: "clip.mp4", size: 2000 * MB + 1 }, OPENINARY_ONLY, ALL_USABLE, huge).ok, false);
});

Deno.test("a 10 MB image limit refuses every image on the direct path", () => {
  const plan = planDirectUpload({ fileName: "photo.jpg", size: 11 * MB }, OPENINARY_ONLY, ALL_USABLE, { image_max_mb: 10, video_max_mb: 500 });
  assertEquals(plan.ok ? null : plan.error, "File exceeds the 10 MB limit");
});
