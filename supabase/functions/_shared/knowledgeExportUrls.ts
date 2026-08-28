// Durable references + short-TTL signed URLs for AI knowledge graph exports.
// The ai-knowledge bucket is private, so /object/public/... no longer works:
// export rows store a "supabase://<bucket>/<path>" reference and the owner
// gets a freshly signed URL each time they open one.

export const STORAGE_REF_SCHEME = "supabase://";

// Long enough to comfortably view/download, short enough that a leaked link
// stops working quickly. The exposure-remediation plan caps this at 60 minutes.
export const SIGNED_URL_TTL_SECONDS = 30 * 60;

export interface StorageClient {
  storage: {
    from: (bucket: string) => {
      createSignedUrl: (
        path: string,
        expiresIn: number,
      ) => Promise<{
        data: { signedUrl: string | null } | null;
        error: { message?: string } | null;
      }>;
    };
  };
}

export type ExportUrlTarget =
  | { kind: "storage"; path: string }
  | { kind: "external"; url: string };

function storagePathTarget(raw: string): ExportUrlTarget | null {
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    return null;
  }
  // Export rows are user-writable via RLS, so a corrupted or hostile value
  // must never resolve to a signable arbitrary object path.
  if (!path || path.startsWith("/") || path.split("/").includes("..")) {
    return null;
  }
  return { kind: "storage", path };
}

/**
 * Classifies a stored export value. Three accepted forms:
 *  - "supabase://<expectedBucket>/<path>" — the durable reference written since
 *    the bucket went private;
 *  - a legacy "https://<host>/storage/v1/object/public/<expectedBucket>/<path>"
 *    URL from rows that predate it — the object still lives at the same path,
 *    so it resolves back to that path instead of becoming a dead link;
 *  - any other http(s) URL — an external delivery URL (Openinary/Cloudinary),
 *    passed through unchanged.
 * Anything else (including a foreign bucket or traversal-shaped path) is null.
 */
export function parseExportUrlTarget(
  value: string,
  expectedBucket: string,
): ExportUrlTarget | null {
  if (value.startsWith(STORAGE_REF_SCHEME)) {
    const rest = value.slice(STORAGE_REF_SCHEME.length);
    const slash = rest.indexOf("/");
    if (slash <= 0 || rest.slice(0, slash) !== expectedBucket) return null;
    return storagePathTarget(rest.slice(slash + 1));
  }
  if (/^https?:\/\//.test(value)) {
    const marker = `/storage/v1/object/public/${expectedBucket}/`;
    const index = value.indexOf(marker);
    if (index !== -1) return storagePathTarget(value.slice(index + marker.length));
    return { kind: "external", url: value };
  }
  return null;
}

/**
 * Turns a stored export value into a browser-usable URL for its owner, or null
 * when it cannot be served (missing, unparseable, outside the caller's folder,
 * or signing failed). Never accepts a caller-supplied path — only the value
 * already stored on the caller's own export row.
 */
export async function resolveExportUrl(
  admin: StorageClient,
  stored: string | null,
  opts: { bucket: string; ownerFolder: string },
): Promise<string | null> {
  if (!stored) return null;
  const target = parseExportUrlTarget(stored, opts.bucket);
  if (!target) return null;
  if (target.kind === "external") return target.url;
  // html_url/vault_url are user-writable via RLS: without this scope check a
  // caller could repoint their own row at another user's folder and have the
  // service role sign it. Same guard class as the Cloudinary destroy scope in
  // ai-knowledge-ingest's deleteSourceFile.
  if (!target.path.startsWith(`${opts.ownerFolder}/`)) {
    console.warn(
      "[knowledgeExportUrls] Refusing to sign export outside caller folder:",
      target.path,
    );
    return null;
  }
  const { data, error } = await admin
    .storage
    .from(opts.bucket)
    .createSignedUrl(target.path, SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    console.warn(
      "[knowledgeExportUrls] Signed URL failed for",
      target.path,
      "-",
      error?.message ?? "no URL returned",
    );
    return null;
  }
  return data.signedUrl;
}
