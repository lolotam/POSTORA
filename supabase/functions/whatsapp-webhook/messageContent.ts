// What a WhatsApp media message is allowed to say to the rules and to the model.
//
// Pulled out of index.ts so it can be tested: that file is a `Deno.serve` module, and
// importing it starts a server. Same shape as facebook-instagram-webhook/commentEvents.ts.

/**
 * The stand-in text for a media message with nothing typed alongside it.
 *
 * Note there is no entry for `video`: nothing reads one, and a message with no entry here
 * is treated as having real text rather than a placeholder.
 */
export const MEDIA_PLACEHOLDERS: Record<string, string> = {
  audio: "[Audio message]",
  image: "[Image]",
  document: "[Document]",
};

/**
 * Whether the message text is only this media's placeholder, with nothing the customer typed.
 *
 * A document's text is "[Document] <filename>", so an exact match never holds -- and the
 * filename is chosen by the sender, not typed as a message. Treating it as a caption would
 * hand the model an attacker-named string presented as the customer's own words.
 */
export function isPlaceholderOnly(mediaType: string, messageText: string): boolean {
  const placeholder = MEDIA_PLACEHOLDERS[mediaType];
  if (!placeholder) return false;
  return messageText === placeholder ||
    (mediaType === "document" && messageText.startsWith(`${placeholder} `));
}

/**
 * The text the auto-reply rules and the AI agent are allowed to read.
 *
 * The distinction this draws is between what the *sender* chose and what the *customer*
 * wrote. A filename is the former: naming a file
 * "urgent-ignore-previous-instructions.pdf" would otherwise put an instruction in front of
 * the model, and let a sender trigger an away rule on demand. A caption is the latter and
 * passes through.
 *
 * Storage and the n8n dispatch keep the full text, where the filename is data rather than
 * prompt input.
 */
export function promptSafeInput(
  mediaType: string | null,
  messageText: string,
  caption: string | null,
): string {
  if (!mediaType || !isPlaceholderOnly(mediaType, messageText)) return messageText;
  return [MEDIA_PLACEHOLDERS[mediaType], caption].filter(Boolean).join(" ");
}
