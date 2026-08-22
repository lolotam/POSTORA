// Away/keyword rule matching, extracted from facebook-instagram-webhook so the public-comment
// surface can reuse it. Only the matching is shared: DMs send through the Meta Send API and
// comments through the comment API, and the two have different cooldown and precedence needs.
//
// Pure by design (no Deno or network imports) so it is unit-testable — the schedule logic has
// three off-by-one traps in it (day index, HH:MM slicing, windows that wrap midnight) and had
// no test coverage while it lived inline in the webhook.

export interface AutoReplyRule {
  id: string;
  rule_type: string;
  keywords: string[] | null;
  reply_message: string;
  schedule_days: number[] | null;
  schedule_start: string | null;
  schedule_end: string | null;
  created_at?: string | null;
}

export interface AutoReplyMatch {
  ruleId: string;
  replyMessage: string;
  ruleType: "away" | "keyword";
}

// Rules are stored without an ordering constraint, so "the first matching rule" was whatever
// order Postgres happened to return — different rules could win on different days for the
// same message. Oldest rule wins, ties broken by id. Rows with no created_at sort last so a
// backfilled row cannot silently jump the queue.
function byAgeThenId(left: AutoReplyRule, right: AutoReplyRule): number {
  const leftAge = left.created_at || "";
  const rightAge = right.created_at || "";
  if (leftAge !== rightAge) {
    if (!leftAge) return 1;
    if (!rightAge) return -1;
    return leftAge < rightAge ? -1 : 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function isWithinSchedule(rule: AutoReplyRule, now: Date): boolean {
  if (rule.schedule_days && !rule.schedule_days.includes(now.getDay())) return false;
  if (!rule.schedule_start || !rule.schedule_end) return true;

  const current = now.toTimeString().slice(0, 5);
  const start = rule.schedule_start.slice(0, 5);
  const end = rule.schedule_end.slice(0, 5);

  // A window that wraps midnight (22:00–06:00) is outside only when the clock is past the end
  // AND before the start, which is the same-day gap between them.
  return start <= end
    ? current >= start && current <= end
    : !(current < start && current > end);
}

// Blank keywords are dropped, not matched. "".includes() is true for every string, so a
// single empty or whitespace-only entry -- easy to save from the rules UI -- would make that
// rule claim every message and every public comment, silencing the AI agent entirely.
function matchesKeyword(rule: AutoReplyRule, lowerText: string): boolean {
  if (!rule.keywords?.length) return false;
  return rule.keywords.some((keyword) => {
    const needle = keyword.trim().toLowerCase();
    return needle.length > 0 && lowerText.includes(needle);
  });
}

// Away rules outrank keyword rules: when the business is closed, saying so beats answering
// the question. Returns null when nothing claims the message.
export function matchAutoReplyRule(
  rules: AutoReplyRule[],
  inboundText: string,
  now: Date,
): AutoReplyMatch | null {
  const ordered = [...rules].sort(byAgeThenId);

  const away = ordered.find((rule) => rule.rule_type === "away" && isWithinSchedule(rule, now));
  if (away) return { ruleId: away.id, replyMessage: away.reply_message, ruleType: "away" };

  const lowerText = inboundText.toLowerCase();
  const keyword = ordered.find((rule) => rule.rule_type === "keyword" && matchesKeyword(rule, lowerText));
  if (keyword) return { ruleId: keyword.id, replyMessage: keyword.reply_message, ruleType: "keyword" };

  return null;
}
