export interface KnowledgeChunk {
  content: string;
  metadata: Record<string, unknown>;
}

export function rowToText(row: Record<string, unknown>): string {
  return Object.entries(row)
    .filter(([, value]) => value != null && String(value).trim())
    .map(([header, value]) => `${header}: ${String(value).trim()}`)
    .join("\n");
}

export function chunkRows(
  rows: Array<{ text: string; sheet: string; row: number }>,
  maxLength = 1200,
): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  let content = "";
  let sheet = "";
  let startRow = 0;
  let endRow = 0;
  const push = () => {
    if (content)
      chunks.push({
        content,
        metadata: { sheet, row_range: `${startRow}-${endRow}` },
      });
    content = "";
  };
  for (const row of rows) {
    if (!row.text) continue;
    if (
      content &&
      (sheet !== row.sheet || content.length + row.text.length + 2 > maxLength)
    )
      push();
    if (!content) {
      sheet = row.sheet;
      startRow = row.row;
    }
    content += `${content ? "\n\n" : ""}${row.text}`;
    endRow = row.row;
    if (row.text.length > maxLength) push();
  }
  push();
  return chunks;
}

export function chunkProfileText(
  text: string,
  maxLength = 1200,
  overlap = 150,
): KnowledgeChunk[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  const chunks: KnowledgeChunk[] = [];
  let current = "";
  for (const paragraph of paragraphs.length ? paragraphs : [text.trim()]) {
    if (current && current.length + paragraph.length + 2 > maxLength) {
      chunks.push({ content: current, metadata: {} });
      current = `${current.slice(-overlap)}\n\n${paragraph}`;
    } else current += `${current ? "\n\n" : ""}${paragraph}`;
  }
  if (current) chunks.push({ content: current, metadata: {} });
  return chunks;
}
