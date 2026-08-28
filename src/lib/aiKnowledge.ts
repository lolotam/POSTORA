export type AiKnowledgeSourceType = "csv" | "excel" | "pdf" | "doc" | "image";

const SOURCE_TYPE_BY_EXTENSION: Record<string, AiKnowledgeSourceType> = {
  csv: "csv",
  xlsx: "excel",
  xls: "excel",
  pdf: "pdf",
  txt: "doc",
  md: "doc",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
};

export const AI_KNOWLEDGE_ACCEPT = Object.keys(SOURCE_TYPE_BY_EXTENSION)
  .map((extension) => `.${extension}`)
  .join(",");

export function getKnowledgeSourceType(
  fileName: string,
): AiKnowledgeSourceType | null {
  const extension = fileName.split(".").pop()?.toLowerCase();
  return (extension && SOURCE_TYPE_BY_EXTENSION[extension]) || null;
}

/** The private bucket knowledge uploads are written to. */
export const AI_KNOWLEDGE_BUCKET = "ai-knowledge";

/**
 * The object path for an uploaded knowledge file.
 *
 * The leading user id is the contract, not a convention: the bucket's INSERT
 * and SELECT policies both compare `storage.foldername(name)[1]` against
 * `auth.uid()`, and the server refuses to read any source outside its owner's
 * folder. It also keeps the owner's email address out of the path, which the
 * previous Cloudinary layout embedded.
 */
export function aiKnowledgeObjectPath(
  userId: string,
  fileName: string,
  objectId: string,
): string {
  const extension = fileName.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1];
  return `${userId}/sources/${objectId}${extension ? `.${extension}` : ""}`;
}

/**
 * The durable value stored in `ai_knowledge_sources.file_path`. A reference
 * rather than a URL: the bucket is private, so any URL would either be dead or
 * a short-lived signed link that outlives its own validity in the database.
 */
export function aiKnowledgeStorageRef(path: string): string {
  return `supabase://${AI_KNOWLEDGE_BUCKET}/${path}`;
}
