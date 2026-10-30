/**
 * Where an admin-inbox email attachment (inbound or outbound) is stored.
 *
 * Openinary is the store. The Cloudinary account is disabled, so Cloudinary is used
 * only when Openinary is not configured at all, and an Openinary failure is never
 * retried there: the call fails, loudly, so the caller can log it.
 *
 * Shared by cloudinary-email-upload (compose), resend-webhook and fetch-email-content
 * (inbound). The Library's `cdn_storage` write policy is deliberately not consulted:
 * it defaults to "Openinary disabled" when unreadable, which would route an
 * attachment to the dead provider on a transient read error.
 */

import {
  deleteFromOpeninary,
  openinaryTarget,
  uploadBytesToOpeninary,
  getOpeninaryConfig,
  type OpeninaryConfig,
} from "./openinary.ts";
import { extensionOfName, mediaTypeForFileName, mediaTypeForMime, originalBasename } from "./mediaTypes.ts";
import { deleteFromCloudinary, uploadToCloudinaryEmail } from "./cloudinary-email-helper.ts";
import type { CloudinaryCredentials } from "./cloudinaryDestroy.ts";

export type EmailAttachmentErrorCode = "invalid_request" | "no_provider" | "unsupported_type" | "provider_failed";

/** `message` is for logs; `publicMessage` is safe to return to a browser. */
export class EmailAttachmentStorageError extends Error {
  readonly code: EmailAttachmentErrorCode;
  readonly publicMessage: string;

  constructor(code: EmailAttachmentErrorCode, message: string, publicMessage: string) {
    super(message);
    this.name = "EmailAttachmentStorageError";
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

/** The HTTP status each failure maps to at the compose endpoint. */
export const EMAIL_ATTACHMENT_ERROR_STATUS: Record<EmailAttachmentErrorCode, number> = {
  invalid_request: 400,
  unsupported_type: 415,
  no_provider: 503,
  provider_failed: 502,
};

export interface EmailAttachmentProviders {
  openinary: OpeninaryConfig | null;
  cloudinary: CloudinaryCredentials | null;
}

export function emailAttachmentProvidersFromEnv(): EmailAttachmentProviders {
  const cloudName = Deno.env.get("CLOUDINARY_CLOUD_NAME");
  const apiKey = Deno.env.get("CLOUDINARY_API_KEY");
  const apiSecret = Deno.env.get("CLOUDINARY_API_SECRET");
  return {
    openinary: getOpeninaryConfig(),
    cloudinary: cloudName && apiKey && apiSecret ? { cloudName, apiKey, apiSecret } : null,
  };
}

/** The network boundary, injectable so a test fakes the providers and nothing else. */
export interface EmailAttachmentStorageDeps {
  uploadBytesToOpeninary: typeof uploadBytesToOpeninary;
  deleteFromOpeninary: typeof deleteFromOpeninary;
  uploadToCloudinaryEmail: typeof uploadToCloudinaryEmail;
  deleteFromCloudinary: typeof deleteFromCloudinary;
}

const defaultDeps: EmailAttachmentStorageDeps = {
  uploadBytesToOpeninary,
  deleteFromOpeninary,
  uploadToCloudinaryEmail,
  deleteFromCloudinary,
};

export interface StoreEmailAttachmentInput {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
  /** Provider-neutral folder, e.g. `admin/email/inbound/<emailId>`. */
  folder: string;
  /**
   * Makes the object name unique within the folder. Openinary never overwrites, and two
   * attachments called `invoice.pdf` are ordinary. For inbound mail pass the Resend
   * attachment id, so a webhook retry recomputes the same path and adopts the stored object.
   */
  uniqueKey: string;
}

/** The shape callers have always received from the Cloudinary helper. */
export interface StoredEmailAttachment {
  url: string;
  publicId: string;
  filename: string;
  size: number;
  contentType: string;
}

/**
 * Extension and MIME type Openinary will accept for this attachment, or null.
 * A named extension decides: `evil.exe` labelled `application/pdf` is still refused.
 * The content type is consulted only for a name with no usable extension.
 */
export function resolveAttachmentType(filename: string, contentType: string): { ext: string; mime: string } | null {
  const named = extensionOfName(filename);
  if (named) {
    const entry = mediaTypeForFileName(filename);
    return entry ? { ext: named, mime: entry.mime } : null;
  }
  const byMime = mediaTypeForMime(contentType);
  return byMime ? { ext: byMime.ext, mime: byMime.entry.mime } : null;
}

/** `<uniqueKey>-<stem>`: path-safe, bounded, and never empty. */
export function attachmentObjectName(uniqueKey: string, filename: string): string {
  const base = originalBasename(filename);
  const stem = extensionOfName(filename) ? base.slice(0, base.lastIndexOf(".")) : base;
  const safeStem = stem.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "attachment";
  const safeKey = uniqueKey.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "0";
  return `${safeKey}-${safeStem}`;
}

export async function storeEmailAttachment(
  input: StoreEmailAttachmentInput,
  providers: EmailAttachmentProviders = emailAttachmentProvidersFromEnv(),
  deps: EmailAttachmentStorageDeps = defaultDeps,
): Promise<StoredEmailAttachment> {
  const { bytes, filename, contentType, folder, uniqueKey } = input;
  // The folder carries a caller's email id; a `.` or `..` segment would leave the email tree.
  if (folder.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new EmailAttachmentStorageError("invalid_request", "Invalid attachment folder", "Invalid email id for the attachment folder");
  }
  if (!providers.openinary && !providers.cloudinary) {
    throw new EmailAttachmentStorageError(
      "no_provider",
      "No attachment storage configured (set OPENINARY_SERVER_URL and OPENINARY_API_KEY)",
      "Attachment storage is not configured",
    );
  }

  // Checked before either provider: inbound mail is untrusted whichever store takes it.
  const type = resolveAttachmentType(filename, contentType);
  if (!type) {
    const ext = extensionOfName(filename);
    throw new EmailAttachmentStorageError(
      "unsupported_type",
      `Attachment type not storable (extension ${ext ? `.${ext}` : "none"}, content-type ${contentType || "unknown"})`,
      ext ? `Files of type .${ext} cannot be attached` : "This file type cannot be attached",
    );
  }
  const objectName = attachmentObjectName(uniqueKey, filename);

  if (providers.openinary) {
    const { folder: targetFolder, baseName } = openinaryTarget(`${folder}/${objectName}`, providers.openinary.folderPrefix);
    const result = await deps.uploadBytesToOpeninary(
      providers.openinary,
      bytes,
      targetFolder,
      baseName,
      type.ext,
      type.mime,
      bytes.byteLength,
    );
    if (!result.success || !result.path || !result.url) {
      throw new EmailAttachmentStorageError(
        "provider_failed",
        result.error || "Openinary upload failed",
        "The attachment could not be stored",
      );
    }
    return { url: result.url, publicId: result.path, filename, size: bytes.byteLength, contentType };
  }

  // Legacy fallback for a deployment that never configured Openinary. The helper derives
  // the public id from the name it is given, so it gets the unique object name.
  const cloudinary = providers.cloudinary as CloudinaryCredentials;
  try {
    const stored = await deps.uploadToCloudinaryEmail(
      bytes,
      `${objectName}.${type.ext}`,
      type.mime,
      folder,
      cloudinary.cloudName,
      cloudinary.apiKey,
      cloudinary.apiSecret,
    );
    return { ...stored, filename };
  } catch (error) {
    throw new EmailAttachmentStorageError(
      "provider_failed",
      error instanceof Error ? error.message : String(error),
      "The attachment could not be stored",
    );
  }
}

/** Compose-window uploads live here; only these may be deleted through the API. */
const DELETABLE_FOLDER = "admin/email/outbound";

export type DeletableAttachment = { provider: "openinary" | "cloudinary"; path: string };

/**
 * Whether `publicId` names a single outbound attachment file, and on which provider.
 *
 * Openinary's delete endpoint removes folders as readily as files, so the id must sit
 * inside `<date>/<file>` under the outbound folder, with no empty, `.` or `..` segment.
 * Inbound attachments are refused: the compose window copies an inbound `publicId` onto
 * a forwarded attachment, and removing that chip must not delete the original.
 */
export function parseDeletablePublicId(publicId: unknown, folderPrefix: string | null): DeletableAttachment | null {
  if (typeof publicId !== "string" || !publicId || publicId.includes("\\")) return null;
  const segments = publicId.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;

  const openinaryRoot = folderPrefix ? `${folderPrefix}/${DELETABLE_FOLDER}/` : null;
  const cloudinaryRoot = `${DELETABLE_FOLDER}/`;
  let rest: string;
  let provider: DeletableAttachment["provider"];
  if (openinaryRoot && publicId.startsWith(openinaryRoot)) {
    rest = publicId.slice(openinaryRoot.length);
    provider = "openinary";
  } else if (publicId.startsWith(cloudinaryRoot)) {
    rest = publicId.slice(cloudinaryRoot.length);
    provider = "cloudinary";
  } else {
    return null;
  }
  // Exactly `<date>/<file>`. An Openinary file always carries its extension, so a path
  // without one could name a folder there; Cloudinary public ids have none and its
  // destroy endpoint removes single assets only.
  const parts = rest.split("/");
  if (parts.length !== 2) return null;
  if (provider === "openinary" && !extensionOfName(parts[1])) return null;
  return { provider, path: publicId };
}

export async function deleteEmailAttachment(
  publicId: unknown,
  providers: EmailAttachmentProviders = emailAttachmentProvidersFromEnv(),
  deps: EmailAttachmentStorageDeps = defaultDeps,
): Promise<{ success: boolean; error?: string }> {
  const target = parseDeletablePublicId(publicId, providers.openinary?.folderPrefix ?? null);
  if (!target) return { success: false, error: "Attachment is not a deletable outbound file" };

  if (target.provider === "openinary") {
    // parseDeletablePublicId only yields "openinary" when a config (and so a prefix) exists.
    return await deps.deleteFromOpeninary(providers.openinary as OpeninaryConfig, target.path);
  }

  if (!providers.cloudinary) return { success: false, error: "Legacy Cloudinary attachment: Cloudinary is not configured" };
  try {
    const deleted = await deps.deleteFromCloudinary(
      target.path,
      providers.cloudinary.cloudName,
      providers.cloudinary.apiKey,
      providers.cloudinary.apiSecret,
    );
    return deleted ? { success: true } : { success: false, error: "Cloudinary refused the delete" };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** A provider message with any quoted object path removed: a path carries the file name. */
function redactPaths(message: string): string {
  return message.replace(/"[^"]*"/g, '"<path>"');
}

/**
 * What a failed attachment writes to `system_logs`: the failure code, the extension and
 * the provider's message with paths redacted. Never the file name (it can carry a
 * customer's name) or bytes.
 */
export function attachmentFailureLogMetadata(filename: string, error: unknown): Record<string, unknown> {
  return {
    code: error instanceof EmailAttachmentStorageError ? error.code : "unexpected",
    extension: extensionOfName(filename) || null,
    detail: redactPaths(error instanceof Error ? error.message : String(error)),
  };
}

/** The `system_logs` metadata for an attachment that could not be downloaded from Resend. */
export function attachmentDownloadFailureLogMetadata(filename: string, status: number | null): Record<string, unknown> {
  return { code: "download_failed", extension: extensionOfName(filename) || null, status };
}
