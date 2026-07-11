export type AiKnowledgeSourceType = "csv" | "excel";
export function getKnowledgeSourceType(
  fileName: string,
): AiKnowledgeSourceType | null {
  const extension = fileName.split(".").pop()?.toLowerCase();
  return extension === "csv"
    ? "csv"
    : extension === "xlsx" || extension === "xls"
      ? "excel"
      : null;
}
export function buildAiKnowledgeStoragePath(
  userId: string,
  fileId: string,
  fileName: string,
) {
  return `${userId}/${fileId}-${fileName}`;
}
