/**
 * Where an `ai_knowledge_sources` row's bytes live, and how the server reads
 * them back.
 *
 * Uploads made since the private-asset migration write into the private
 * `ai-knowledge` bucket at `<user_id>/sources/<uuid>.<ext>` and store the
 * durable reference `supabase://ai-knowledge/<path>`. Earlier uploads left a
 * public Cloudinary delivery URL in `file_path`, which is still read here until
 * those rows are migrated.
 *
 * Every value passed in is untrusted. `ai_knowledge_sources.file_path` is
 * writable by its owner through RLS, while both readers run as the service role
 * and therefore bypass RLS entirely — so a row pointed at another user's asset
 * would otherwise be fetched and indexed into the pointing user's knowledge
 * base. Each accepted shape below carries an owner-scope rule for that reason,
 * and anything that does not resolve inside the owner's own folder is refused
 * rather than fetched.
 */

export const KNOWLEDGE_BUCKET = "ai-knowledge";
export const KNOWLEDGE_STORAGE_REF_SCHEME = "supabase://";

const CLOUDINARY_CDN_PREFIX = "https://res.cloudinary.com/";
// Raw public_ids keep their file extension, so the tail is captured whole.
const CLOUDINARY_RAW_URL = /^https:\/\/res\.cloudinary\.com\/[^/]+\/raw\/upload\/v\d+\/(.+)$/;

export type KnowledgeFileLocation =
  | { kind: "storage"; bucket: string; path: string }
  | { kind: "cloudinary"; url: string; publicId: string };

/** The row owner, as the scope rules need them. */
export interface KnowledgeFileOwner {
  userId: string;
  /** Only legacy Cloudinary assets are addressed by email folder. */
  email?: string | null;
}

/**
 * The Cloudinary folder segment for a user, matching what `cloudinary-upload`
 * writes. Both sides must derive it identically or the scope check rejects the
 * user's own assets.
 */
export function cloudinaryFolderForEmail(email: string): string {
  return email
    .toLowerCase()
    .replace(/@/g, "_at_")
    .replace(/\./g, "_")
    .replace(/[^a-z0-9_-]/g, "_");
}

/** The object path a new upload is written to. Carries no email, only ids. */
export function knowledgeStorageObjectPath(
  userId: string,
  fileName: string,
  objectId: string,
): string {
  const extension = fileName.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1];
  return `${userId}/sources/${objectId}${extension ? `.${extension}` : ""}`;
}

/** The durable value stored in `file_path` for a bucket object. */
export function knowledgeStorageRef(path: string): string {
  return `${KNOWLEDGE_STORAGE_REF_SCHEME}${KNOWLEDGE_BUCKET}/${path}`;
}

function ownedStoragePath(path: string, owner: KnowledgeFileOwner): KnowledgeFileLocation | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (!decoded || decoded.startsWith("/") || decoded.split("/").includes("..")) return null;

  // Current uploads live under the owner's id. Objects written before that
  // (graph exports, and any pre-Cloudinary source) live under the email folder,
  // which is equally the owner's own space.
  const ownedPrefixes = [`${owner.userId}/`];
  if (owner.email) ownedPrefixes.push(`media/${cloudinaryFolderForEmail(owner.email)}/`);
  if (!ownedPrefixes.some((prefix) => decoded.startsWith(prefix))) return null;

  return { kind: "storage", bucket: KNOWLEDGE_BUCKET, path: decoded };
}

/**
 * Resolves a stored `file_path` to a location the service role may read on this
 * owner's behalf, or null when it is unreadable, unrecognised, or points
 * outside the owner's own folder.
 */
export function locateKnowledgeFile(
  filePath: string | null | undefined,
  owner: KnowledgeFileOwner,
): KnowledgeFileLocation | null {
  if (!filePath) return null;

  if (filePath.startsWith(KNOWLEDGE_STORAGE_REF_SCHEME)) {
    const rest = filePath.slice(KNOWLEDGE_STORAGE_REF_SCHEME.length);
    const slash = rest.indexOf("/");
    if (slash <= 0 || rest.slice(0, slash) !== KNOWLEDGE_BUCKET) return null;
    return ownedStoragePath(rest.slice(slash + 1), owner);
  }

  if (filePath.startsWith(CLOUDINARY_CDN_PREFIX)) {
    const match = filePath.match(CLOUDINARY_RAW_URL);
    if (!match || !owner.email) return null;
    let publicId: string;
    try {
      publicId = decodeURIComponent(match[1]);
    } catch {
      return null;
    }
    if (!publicId.startsWith(`media/${cloudinaryFolderForEmail(owner.email)}/`)) return null;
    return { kind: "cloudinary", url: filePath, publicId };
  }

  // A public storage URL from before the bucket went private: the object is
  // still at that path, so resolve it back rather than treating it as external.
  const publicMarker = `/storage/v1/object/public/${KNOWLEDGE_BUCKET}/`;
  const markerAt = filePath.indexOf(publicMarker);
  if (markerAt !== -1) {
    return ownedStoragePath(filePath.slice(markerAt + publicMarker.length), owner);
  }

  // Any other absolute URL is an SSRF vector for the service role.
  if (/^[a-z][a-z0-9+.-]*:/i.test(filePath)) return null;

  return ownedStoragePath(filePath, owner);
}

export interface KnowledgeStorageReader {
  storage: {
    from: (bucket: string) => {
      download: (path: string) => Promise<{
        data: Blob | null;
        error: { message?: string } | null;
      }>;
    };
  };
}

/**
 * Reads the bytes at an already-resolved location. Takes a location rather than
 * a raw `file_path` so that a caller cannot skip {@link locateKnowledgeFile} and
 * the scope check it performs.
 */
export async function downloadKnowledgeFile(
  admin: KnowledgeStorageReader,
  location: KnowledgeFileLocation,
  fetchImpl: typeof fetch = fetch,
): Promise<Blob> {
  if (location.kind === "cloudinary") {
    const response = await fetchImpl(location.url);
    if (!response.ok) throw new Error(`Knowledge file download failed (${response.status})`);
    return await response.blob();
  }
  const { data, error } = await admin.storage.from(location.bucket).download(location.path);
  if (error || !data) throw new Error(error?.message || "Knowledge file not found");
  return data;
}
