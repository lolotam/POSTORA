import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  attachmentFailureLogMetadata,
  attachmentObjectName,
  deleteEmailAttachment,
  EmailAttachmentStorageError,
  parseDeletablePublicId,
  resolveAttachmentType,
  storeEmailAttachment,
  type EmailAttachmentProviders,
  type EmailAttachmentStorageDeps,
} from "./emailAttachmentStorage.ts";
import type { OpeninaryUploadResult } from "./openinary.ts";

const OPENINARY = { serverUrl: "https://cdn.example", apiKey: "k", folderPrefix: "postora.cloud" };
const CLOUDINARY = { cloudName: "c", apiKey: "a", apiSecret: "s" };
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]);

/** Fakes the four provider calls; records them so a test can assert what was (not) called. */
function fakeProviders(overrides: Partial<EmailAttachmentStorageDeps> = {}) {
  const calls = {
    openinaryUploads: [] as { folder: string; baseName: string; ext: string; mime?: string; size?: number }[],
    openinaryDeletes: [] as string[],
    cloudinaryUploads: 0,
    cloudinaryDeletes: [] as string[],
  };
  const deps: EmailAttachmentStorageDeps = {
    uploadBytesToOpeninary: (_config, _data, folder, baseName, ext, mime, size): Promise<OpeninaryUploadResult> => {
      calls.openinaryUploads.push({ folder, baseName, ext, mime, size });
      const path = `${folder}/${baseName}.${ext}`;
      return Promise.resolve({ success: true, path, url: `https://cdn.example/t/${path}` });
    },
    deleteFromOpeninary: (_config, path) => {
      calls.openinaryDeletes.push(path);
      return Promise.resolve({ success: true });
    },
    uploadToCloudinaryEmail: (_buf, filename, contentType) => {
      calls.cloudinaryUploads++;
      return Promise.resolve({ url: "https://res.cloudinary.com/x", publicId: "admin/email/x", filename, size: 7, contentType });
    },
    deleteFromCloudinary: (publicId) => {
      calls.cloudinaryDeletes.push(publicId);
      return Promise.resolve(true);
    },
    ...overrides,
  };
  return { calls, deps };
}

const input = { bytes: PDF, filename: "Invoice 2026.pdf", contentType: "application/pdf", folder: "admin/email/inbound/em_1", uniqueKey: "att-1" };

Deno.test("with Openinary configured the attachment is stored there and Cloudinary is never called", async () => {
  const { calls, deps } = fakeProviders();
  const stored = await storeEmailAttachment(input, { openinary: OPENINARY, cloudinary: CLOUDINARY }, deps);
  assertEquals(stored, {
    url: "https://cdn.example/t/postora.cloud/admin/email/inbound/em_1/att-1-Invoice_2026.pdf",
    publicId: "postora.cloud/admin/email/inbound/em_1/att-1-Invoice_2026.pdf",
    filename: "Invoice 2026.pdf",
    size: PDF.byteLength,
    contentType: "application/pdf",
  });
  assertEquals(calls.openinaryUploads, [{ folder: "postora.cloud/admin/email/inbound/em_1", baseName: "att-1-Invoice_2026", ext: "pdf", mime: "application/pdf", size: PDF.byteLength }]);
  assertEquals(calls.cloudinaryUploads, 0);
});

Deno.test("an Openinary failure fails the call and does not fall back to Cloudinary", async () => {
  const { calls, deps } = fakeProviders({
    uploadBytesToOpeninary: () => Promise.resolve({ success: false, error: "Openinary upload failed: 500" }),
  });
  const error = await assertRejects(
    () => storeEmailAttachment(input, { openinary: OPENINARY, cloudinary: CLOUDINARY }, deps),
    EmailAttachmentStorageError,
    "Openinary upload failed: 500",
  );
  assertEquals(error.code, "provider_failed");
  assertEquals(calls.cloudinaryUploads, 0);
});

Deno.test("Cloudinary is the fallback only when Openinary is not configured", async () => {
  const { calls, deps } = fakeProviders();
  const stored = await storeEmailAttachment(input, { openinary: null, cloudinary: CLOUDINARY }, deps);
  assertEquals(stored.url, "https://res.cloudinary.com/x");
  assertEquals(calls.cloudinaryUploads, 1);
  assertEquals(calls.openinaryUploads, []);
});

Deno.test("a Cloudinary fallback error is reported as a provider failure", async () => {
  const { deps } = fakeProviders({ uploadToCloudinaryEmail: () => Promise.reject(new Error("Cloudinary upload failed: 401")) });
  const error = await assertRejects(
    () => storeEmailAttachment(input, { openinary: null, cloudinary: CLOUDINARY }, deps),
    EmailAttachmentStorageError,
    "Cloudinary upload failed: 401",
  );
  assertEquals(error.code, "provider_failed");
});

Deno.test("no configured provider is an explicit error, not a silent success", async () => {
  const { calls, deps } = fakeProviders();
  const error = await assertRejects(
    () => storeEmailAttachment(input, { openinary: null, cloudinary: null }, deps),
    EmailAttachmentStorageError,
  );
  assertEquals(error.code, "no_provider");
  assertEquals(calls, { openinaryUploads: [], openinaryDeletes: [], cloudinaryUploads: 0, cloudinaryDeletes: [] });
});

Deno.test("a type Openinary refuses is rejected before any upload", async () => {
  const { calls, deps } = fakeProviders();
  for (const filename of ["setup.exe", "page.html", "feed.xml", "invite.ics"]) {
    const error = await assertRejects(
      () => storeEmailAttachment({ ...input, filename, contentType: "application/octet-stream" }, { openinary: OPENINARY, cloudinary: null }, deps),
      EmailAttachmentStorageError,
    );
    assertEquals(error.code, "unsupported_type");
  }
  assertEquals(calls.openinaryUploads, []);
});

Deno.test("the file extension beats a lying content type", () => {
  assertEquals(resolveAttachmentType("evil.exe", "application/pdf"), null);
  assertEquals(resolveAttachmentType("photo.JPG", "application/octet-stream"), { ext: "jpg", mime: "image/jpeg" });
});

Deno.test("a name without an extension falls back to its content type", () => {
  assertEquals(resolveAttachmentType("scan", "application/pdf"), { ext: "pdf", mime: "application/pdf" });
  assertEquals(resolveAttachmentType("scan", "application/x-msdownload"), null);
});

Deno.test("two attachments with the same file name get different object paths", async () => {
  const { calls, deps } = fakeProviders();
  const providers: EmailAttachmentProviders = { openinary: OPENINARY, cloudinary: null };
  const a = await storeEmailAttachment({ ...input, uniqueKey: "att-1" }, providers, deps);
  const b = await storeEmailAttachment({ ...input, uniqueKey: "att-2" }, providers, deps);
  assert(a.publicId !== b.publicId);
  assertEquals(calls.openinaryUploads.length, 2);
});

Deno.test("a retry with the same attachment id requests the same path, so Openinary can adopt it", async () => {
  const { calls, deps } = fakeProviders();
  const providers: EmailAttachmentProviders = { openinary: OPENINARY, cloudinary: null };
  const first = await storeEmailAttachment(input, providers, deps);
  const retry = await storeEmailAttachment(input, providers, deps);
  assertEquals(first.publicId, retry.publicId);
  assertEquals(calls.openinaryUploads[0], calls.openinaryUploads[1]);
});

Deno.test("object names are path-safe, bounded and never empty", () => {
  assertEquals(attachmentObjectName("a/b", "../../etc/passwd.pdf"), "ab-passwd");
  assertEquals(attachmentObjectName("k", "فاتورة.pdf"), "k-attachment");
  assertEquals(attachmentObjectName("", "x.pdf"), "0-x");
  assert(attachmentObjectName("k", `${"a".repeat(300)}.pdf`).length <= 64 + 1 + 80);
});

Deno.test("delete accepts one outbound file per provider and nothing else", () => {
  const file = "postora.cloud/admin/email/outbound/2026-10-30/ab-report.pdf";
  assertEquals(parseDeletablePublicId(file, "postora.cloud"), { provider: "openinary", path: file });
  assertEquals(parseDeletablePublicId("admin/email/outbound/2026-10-30/report", "postora.cloud"), { provider: "cloudinary", path: "admin/email/outbound/2026-10-30/report" });

  const refused: unknown[] = [
    "postora.cloud/admin/email/outbound/2026-10-30", // a folder
    "postora.cloud/admin/email/outbound/",
    "postora.cloud/admin/email/outbound/2026-10-30/../../inbound/x.pdf",
    "postora.cloud/admin/email/inbound/em_1/att-1-x.pdf", // the original of a forwarded attachment
    "postora.cloud/media/user/post.jpg", // someone else's library file
    "postora.cloud/admin/email/outbound//x.pdf",
    "https://cdn.example/t/postora.cloud/admin/email/outbound/2026-10-30/x.pdf",
    "",
    42,
    null,
  ];
  for (const id of refused) assertEquals(parseDeletablePublicId(id, "postora.cloud"), null, String(id));
  // Without a configured prefix an Openinary path cannot be recognised, so it is refused.
  assertEquals(parseDeletablePublicId(file, null), null);
});

Deno.test("deleting an Openinary attachment goes to Openinary only", async () => {
  const { calls, deps } = fakeProviders();
  const file = "postora.cloud/admin/email/outbound/2026-10-30/ab-report.pdf";
  assertEquals(await deleteEmailAttachment(file, { openinary: OPENINARY, cloudinary: CLOUDINARY }, deps), { success: true });
  assertEquals(calls.openinaryDeletes, [file]);
  assertEquals(calls.cloudinaryDeletes, []);
});

Deno.test("deleting a legacy Cloudinary attachment needs Cloudinary, and says so when it is missing", async () => {
  const { calls, deps } = fakeProviders();
  const legacy = "admin/email/outbound/2026-10-30/report";
  assertEquals(await deleteEmailAttachment(legacy, { openinary: OPENINARY, cloudinary: CLOUDINARY }, deps), { success: true });
  assertEquals(calls.cloudinaryDeletes, [legacy]);
  const none = await deleteEmailAttachment(legacy, { openinary: OPENINARY, cloudinary: null }, deps);
  assertEquals(none.success, false);
  assert(none.error?.includes("Cloudinary is not configured"));
});

Deno.test("a refused or failed delete reports why and calls no provider", async () => {
  const { calls, deps } = fakeProviders({ deleteFromOpeninary: () => Promise.resolve({ success: false, error: "Openinary delete failed: 500" }) });
  const refused = await deleteEmailAttachment("postora.cloud/admin/email/inbound/em_1/x.pdf", { openinary: OPENINARY, cloudinary: null }, deps);
  assertEquals(refused.success, false);
  assertEquals(calls.openinaryDeletes, []);
  const failed = await deleteEmailAttachment("postora.cloud/admin/email/outbound/2026-10-30/x.pdf", { openinary: OPENINARY, cloudinary: null }, deps);
  assertEquals(failed, { success: false, error: "Openinary delete failed: 500" });
});

Deno.test("the failure log carries the code and extension but never the file name", () => {
  const metadata = attachmentFailureLogMetadata("Ahmed Salary Slip.pdf", new EmailAttachmentStorageError("provider_failed", "boom", "public"));
  assertEquals(metadata, { code: "provider_failed", extension: "pdf", detail: "boom" });
  assert(!JSON.stringify(metadata).includes("Ahmed"));
  assertEquals(attachmentFailureLogMetadata("x", new Error("net")).code, "unexpected");
});
