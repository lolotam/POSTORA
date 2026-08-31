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
