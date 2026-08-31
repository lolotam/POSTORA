// What the model is told about a connector, assembled from two sources.
//
// The registry's guide describes the connector TYPE -- when to reach for it, what
// a good request looks like, what it cannot do. The user's own `description`
// describes THEIR instance ("our Kuwait store, prices in KWD"). Both are sent,
// guide first: the guide decides whether to call the tool at all, the user's text
// says which shop it is. Replacing the user's text with a generic guide would be
// a regression for every connector already configured.
//
// This is the "skill file" the request asked for, placed where it actually
// reaches the model. A markdown file under docs/ would satisfy the letter of it
// and none of the intent -- the runtime never reads docs/.

import type { UsageGuide } from "./connectorRegistry.ts";

/**
 * Every tool description is resent on every turn of every conversation, and this
 * worker is killed by the supervisor at 60 seconds -- a ceiling this repo has
 * already hit once. An unbounded description is a slow, invisible tax paid on
 * every inbound message, so the budget is a correctness constraint rather than
 * a style preference.
 */
export const TOOL_DESCRIPTION_BUDGET = 600;

/**
 * Cut at the last sentence boundary inside the budget. A description severed
 * mid-sentence reads to the model as a different claim than the one written:
 * "Cannot place, refund or mod" is not a limit.
 *
 * When no boundary fits -- an authored guide longer than the whole budget -- a
 * hard cut is the honest fallback. The registry is authored rather than user
 * input, so that case is a bug in the registry, and the test that pins it says so.
 */
function truncateAtSentence(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const window = text.slice(0, budget);
  const boundary = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("! "),
    window.lastIndexOf("? "),
  );
  return boundary > 0 ? window.slice(0, boundary + 1) : window.trimEnd();
}

export function composeToolDescription(
  userDescription: string,
  guide: UsageGuide | null | undefined,
): string {
  // Byte-identical to today when the type has no guide. custom_rest has no
  // vendor semantics to describe, and every connector in production right now
  // takes this path -- it must not throw, prepend an empty section, or add so
  // much as a space.
  if (!guide) return userDescription;

  const own = userDescription.trim();
  const examples = guide.requestExamples.filter((example) => example.trim() !== "");
  const parts = [
    guide.whenToUse.trim(),
    examples.length ? `Examples: ${examples.join("; ")}.` : "",
    guide.limits.trim() ? `Limits: ${guide.limits.trim()}` : "",
    own,
  ].filter((part) => part !== "");

  return truncateAtSentence(parts.join(" "), TOOL_DESCRIPTION_BUDGET);
}
