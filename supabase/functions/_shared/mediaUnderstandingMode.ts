// What an account does with inbound audio, images and documents.
//
// Split out of inboundMediaPipeline.ts so messaging-api can validate the setting
// without importing the pipeline, which pulls in the model fallback chain and
// every media fetcher. The pattern is the repo's own: the rule lives in a module
// with no dependencies, so both the writer and the reader can share it and a test
// can assert it without a server.

export const MEDIA_UNDERSTANDING_MODES = [
  "off",
  "audio",
  "audio+image",
  "audio+image+document",
] as const;
export type MediaUnderstandingMode = (typeof MEDIA_UNDERSTANDING_MODES)[number];

/**
 * Default "off", matching resolveCommentAutomationHandler: this spends money per inbound
 * message and reaches customers, so it is opted into deliberately rather than inherited.
 *
 * An unrecognised stored value also reads as "off" rather than throwing. A typo in the
 * column must not start spending money, and it must not break the inbox either.
 */
export function resolveMediaUnderstandingMode(metadata: unknown): MediaUnderstandingMode {
  if (!metadata || typeof metadata !== "object") return "off";
  const value = (metadata as Record<string, unknown>).media_understanding;
  return (MEDIA_UNDERSTANDING_MODES as readonly unknown[]).includes(value)
    ? value as MediaUnderstandingMode
    : "off";
}
