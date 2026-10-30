import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { cloudinarySignature } from "../_shared/cloudinarySignature.ts";
import type { OpeninaryConfig, OpeninaryFile } from "../_shared/openinary.ts";
import {
  CLOUDINARY_CHUNK_BYTES,
  cloudinaryAssetMismatch,
  cloudinaryUploadTarget,
  confirmOpeninaryObject,
  fetchCloudinaryAsset,
  isGenuineCloudinaryResult,
  openinaryUploadBaseUrl,
  openinaryUploadTarget,
  presignOpeninary,
} from "./providers.ts";

const CONFIG: OpeninaryConfig = { serverUrl: "https://openinary.example", apiKey: "key", folderPrefix: "postora.cloud" };
const TARGET = { folder: "postora.cloud/media/u/2026-10-29", fileName: "postora_x_1.mp4" };

Deno.test("presign asks Openinary for the exact folder with the API key", async () => {
  let seen: { url: string; init?: RequestInit } | null = null;
  const fetcher = ((url: string, init?: RequestInit) => {
    seen = { url, init };
    return Promise.resolve(Response.json({ success: true, signature: "sig", expires: 123, folder: TARGET.folder }));
  }) as typeof fetch;
  const presign = await presignOpeninary(CONFIG, TARGET.folder, fetcher);
  assertEquals(presign, { ok: true, signature: "sig", expires: 123 });
  assertEquals(seen!.url, "https://openinary.example/api/upload/sign");
  assertEquals((seen!.init?.headers as Record<string, string>).Authorization, "Bearer key");
  assertEquals(JSON.parse(String(seen!.init?.body)).folder, TARGET.folder);
});

Deno.test("presign failures come back as errors, not throws", async () => {
  const refused = (() => Promise.resolve(Response.json({ success: false, error: "API_SECRET is not configured" }, { status: 500 }))) as typeof fetch;
  const down = (() => Promise.reject(new Error("connection refused"))) as typeof fetch;
  assertEquals(await presignOpeninary(CONFIG, TARGET.folder, refused), { ok: false, error: "Openinary presign failed: API_SECRET is not configured" });
  assertEquals(await presignOpeninary(CONFIG, TARGET.folder, down), { ok: false, error: "Openinary presign failed: connection refused" });
});

Deno.test("the Openinary target names the object and posts to the upload host", () => {
  const target = openinaryUploadTarget(openinaryUploadBaseUrl(CONFIG, "https://upload.openinary.example/"), TARGET, { signature: "sig", expires: 123 });
  assertEquals(target.url, "https://upload.openinary.example/api/upload");
  assertEquals(target.fields, { folder: TARGET.folder, signature: "sig", expires: "123", names: TARGET.fileName });
  assertEquals(openinaryUploadBaseUrl(CONFIG, ""), "https://openinary.example");
});

Deno.test("the Cloudinary target is signed over the same parameters as the edge upload", async () => {
  const target = await cloudinaryUploadTarget({
    cloudName: "demo", apiKey: "k", apiSecret: "s", resourceType: "video",
    folder: "media/u/2026-10-29", publicId: "postora_x_1", timestamp: 1700000000,
  });
  assertEquals(target.url, "https://api.cloudinary.com/v1_1/demo/video/upload");
  assertEquals(target.chunkSize, CLOUDINARY_CHUNK_BYTES);
  const expected = await cloudinarySignature("folder=media/u/2026-10-29&overwrite=false&public_id=postora_x_1&timestamp=1700000000s");
  assertEquals(target.fields.signature, expected);
  assertEquals(target.fields.api_key, "k");
  assertEquals(target.fields.overwrite, "false");
  assertEquals("api_secret" in target.fields, false);
});

Deno.test("only a Cloudinary-signed result is genuine", async () => {
  const signature = await cloudinarySignature("public_id=media/u/postora_x_1&version=42s");
  assertEquals(await isGenuineCloudinaryResult({ public_id: "media/u/postora_x_1", version: 42, signature }, "s"), true);
  assertEquals(await isGenuineCloudinaryResult({ public_id: "media/u/postora_x_2", version: 42, signature }, "s"), false);
  assertEquals(await isGenuineCloudinaryResult({ public_id: "media/u/postora_x_1", version: 42, signature: "0".repeat(40) }, "s"), false);
});

Deno.test("an Openinary object counts only at the exact path and size", async () => {
  const listed = (files: OpeninaryFile[]) => () => Promise.resolve(files);
  const path = `${TARGET.folder}/${TARGET.fileName}`;
  const good = await confirmOpeninaryObject(CONFIG, TARGET, path, 100, listed([{ name: TARGET.fileName, path, size: 100 }]));
  assertEquals(good, { ok: true, path, url: `https://openinary.example/t/${path}` });

  const renamed = await confirmOpeninaryObject(CONFIG, TARGET, `${TARGET.folder}/postora_x_1-1.mp4`, 100, listed([]));
  assertEquals(renamed.ok, false);
  const missing = await confirmOpeninaryObject(CONFIG, TARGET, path, 100, listed([]));
  assertEquals(missing, { ok: false, error: "openinary: object not found after upload" });
  const wrongSize = await confirmOpeninaryObject(CONFIG, TARGET, path, 100, listed([{ name: TARGET.fileName, path, size: 99 }]));
  assertEquals(wrongSize, { ok: false, error: "openinary: stored 99 bytes, expected 100" });
});

const CREDENTIALS = { cloudName: "demo", apiKey: "k", apiSecret: "s" };
const ASSET = { public_id: "media/u/postora_x_1", version: 42, secure_url: "https://res.cloudinary.com/demo/video/upload/v42/media/u/postora_x_1.mp4", bytes: 300, format: "mp4", duration: 12 };

Deno.test("the Admin API describes the stored asset with basic auth", async () => {
  let seen: { url: string; init?: RequestInit } | null = null;
  const fetcher = ((url: string, init?: RequestInit) => {
    seen = { url, init };
    return Promise.resolve(Response.json({ ...ASSET, resource_type: "video" }));
  }) as typeof fetch;
  const confirmed = await fetchCloudinaryAsset(CREDENTIALS, "video", ASSET.public_id, fetcher);
  assertEquals(confirmed, { ok: true, asset: { ...ASSET, width: undefined, height: undefined } });
  assertEquals(seen!.url, "https://api.cloudinary.com/v1_1/demo/resources/video/upload/media/u/postora_x_1");
  assertEquals((seen!.init?.headers as Record<string, string>).Authorization, `Basic ${btoa("k:s")}`);
});

Deno.test("a missing, failing or unreachable asset is not confirmed", async () => {
  const answer = (response: Response) => (() => Promise.resolve(response)) as typeof fetch;
  assertEquals(await fetchCloudinaryAsset(CREDENTIALS, "video", "x", answer(new Response("{}", { status: 404 }))), { ok: false, error: "cloudinary: object not found after upload" });
  assertEquals(await fetchCloudinaryAsset(CREDENTIALS, "video", "x", answer(new Response("{}", { status: 420 }))), { ok: false, error: "cloudinary: could not confirm the upload (HTTP 420)" });
  assertEquals((await fetchCloudinaryAsset(CREDENTIALS, "video", "x", answer(Response.json({ bytes: 1 })))).ok, false);
  const down = (() => Promise.reject(new Error("timed out"))) as typeof fetch;
  assertEquals(await fetchCloudinaryAsset(CREDENTIALS, "video", "x", down), { ok: false, error: "cloudinary: could not confirm the upload (timed out)" });
});

Deno.test("an asset counts only at the signed version and within the declared size", () => {
  assertEquals(cloudinaryAssetMismatch(ASSET, 42, 300), null);
  assertEquals(cloudinaryAssetMismatch(ASSET, "42", 300), null);
  assertEquals(cloudinaryAssetMismatch(ASSET, 41, 300), "cloudinary: the stored object changed after upload");
  assertEquals(cloudinaryAssetMismatch(ASSET, 42, 299), "cloudinary: stored 300 bytes, more than the 299 declared");
});
