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

export function buildAiKnowledgeStoragePath(
  userId: string,
  fileId: string,
  fileName: string,
) {
  return `${userId}/${fileId}-${fileName}`;
}
