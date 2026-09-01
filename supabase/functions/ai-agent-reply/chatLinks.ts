// Making a link survive delivery to a chat app.
//
// Production incident, 2026-08-31: the agent answered a WhatsApp customer with
//
//   [https://shop.example/](https://shop.example/)
//
// WhatsApp renders no markdown. It showed that text literally, and its own
// autolinker then ran from `https://` straight through the `](`, producing one
// address containing both halves -- which 404s. The customer saw "two links
// connected together". None of WhatsApp, Messenger, Instagram or Threads
// renders markdown, so this is every surface the agent writes to.
//
// buildSystemPrompt now tells the model to write bare URLs, but an instruction
// is a request. This is the guarantee: a broken link is customer-facing damage
// and must not depend on the model complying.

// A markdown link, with the label and target captured separately. The label is
// lazy and excludes `]` so nested brackets cannot swallow the rest of the
// message; the target excludes whitespace, `)` and `<>` for the same reason.
const MARKDOWN_LINK = /\[([^\]]*?)\]\(\s*<?([^\s)<>]+)>?\s*\)/g;

/**
 * Rewrites markdown links into what a chat app can actually deliver: the URL
 * on a line of its own, with any human-readable label kept on the line above.
 *
 * A label identical to the target (the common case, and the one that broke) is
 * dropped rather than repeated. Text containing no markdown link is returned
 * unchanged, so this never rewrites a reply it has no reason to touch.
 */
export function flattenChatLinks(text: string): string {
  return text.replace(MARKDOWN_LINK, (_match, rawLabel: string, target: string) => {
    const label = rawLabel.trim();
    const bare = target.trim();
    if (!bare) return label;
    // Angle brackets are also stripped by chat apps' autolinkers inconsistently,
    // hence <?…>? above; what is left must be the address and nothing else.
    if (!label || label === bare || label === bare.replace(/\/+$/, "")) return bare;
    return `${label}\n${bare}`;
  });
}

// ---------------------------------------------------------------------------
// Markdown beyond links. The prompt has told the model twice not to send
// markdown to chat apps, and a live price answer still went out as
// "| الصنف | السعر |" with **bold** (2026-09-01 11:10 UTC) -- the customer
// sees raw pipes and asterisks. An instruction is a request; this is the
// guarantee, at the same seam that already repairs links.
// ---------------------------------------------------------------------------

// A line that is only a table separator: | --- | :---: | etc.
const TABLE_SEPARATOR = /^\s*\|?[\s:|-]+\|?\s*$/;

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 2;
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "")
    .split("|").map((cell) => cell.trim());
}

/**
 * Rewrites what chat apps cannot render into what they can:
 *
 * - `**bold**` / `__bold__`  ->  `*bold*` (WhatsApp's own emphasis)
 * - `### heading`            ->  `*heading*`
 * - a markdown table         ->  one plain "cell: cell" line per row, the
 *                                header row dropped with its separator --
 *                                a price list reads as "كتاكيت جميزة: ١٨ جنيه"
 *
 * Text containing none of these comes back byte-identical.
 */
export function flattenChatMarkdown(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (TABLE_SEPARATOR.test(line) && i > 0 && isTableRow(lines[i - 1])) {
      // Separator row: drop it, and retroactively drop the header row above --
      // "الصنف: السعر" as a list entry would read as a product named الصنف.
      output.pop();
      continue;
    }
    if (isTableRow(line)) {
      const cells = tableCells(line).filter(Boolean);
      output.push(cells.join(": "));
      continue;
    }
    output.push(line.replace(/^\s*#{1,6}\s+(.+)$/, "*$1*"));
  }
  return output.join("\n")
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/__([^_\n]+)__/g, "*$1*");
}

/** The single repair pass a reply goes through before it is sent or stored. */
export function repairChatReply(text: string): string {
  return flattenChatMarkdown(flattenChatLinks(text));
}
