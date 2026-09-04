/**
 * Plain-English readings of the errors a funnel records on a failed send.
 *
 * The raw message is Meta's, or one of commentWorkflow.ts's own reason codes, and neither
 * tells the account owner what to do. The first production failure was Meta refusing a private
 * reply because the *commenter* was a Facebook Page — invisible on the card, and the owner had
 * no way to learn it short of the server logs.
 */
const KNOWN: ReadonlyArray<{ matches: (raw: string) => boolean; explanation: string }> = [
  {
    matches: (raw) => raw.includes("Private replies to Facebook Pages are not allowed"),
    explanation: "The commenter is a Facebook Page. Meta only allows private replies to personal profiles.",
  },
  {
    matches: (raw) => raw.includes("private_reply_window_elapsed"),
    explanation: "The comment was older than 7 days, which is Meta's limit for a private reply.",
  },
  {
    matches: (raw) => raw.includes("usage_claim_failed"),
    explanation: "Postora could not record the send-once claim, so nothing was sent.",
  },
];

/** The message to show on the card, or null when there is nothing to show. */
export function explainWorkflowError(raw: string | null | undefined): string | null {
  const text = raw?.trim() ?? "";
  if (text.length === 0) return null;
  return KNOWN.find((entry) => entry.matches(text))?.explanation ?? text;
}
