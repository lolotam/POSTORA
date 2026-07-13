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

function splitRowText(text: string, maxLength: number): string[] {
  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    const boundary = Math.max(
      remaining.lastIndexOf("\n", maxLength - 1),
      remaining.lastIndexOf(" ", maxLength - 1),
    );
    const end = boundary > 0 ? boundary + 1 : maxLength;
    parts.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining) parts.push(remaining);
  return parts;
}

export function chunkRows(
  rows: Array<{ text: string; sheet: string; row: number }>,
  maxLength = 3000,
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
    for (const text of splitRowText(row.text, maxLength)) {
      if (
        content &&
        (sheet !== row.sheet || content.length + text.length + 2 > maxLength)
      )
        push();
      if (!content) {
        sheet = row.sheet;
        startRow = row.row;
      }
      content += `${content ? "\n\n" : ""}${text}`;
      endRow = row.row;
    }
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
