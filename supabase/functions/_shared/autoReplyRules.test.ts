import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { matchAutoReplyRule, type AutoReplyRule } from "./autoReplyRules.ts";

function rule(overrides: Partial<AutoReplyRule> & { id: string }): AutoReplyRule {
  return {
    rule_type: "keyword",
    keywords: null,
    reply_message: `reply-${overrides.id}`,
    schedule_days: null,
    schedule_start: null,
    schedule_end: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// Wednesday 2026-08-19, 14:30 local. getDay()/toTimeString() both read local time, which is
// what the rule schedules are authored against.
const WEDNESDAY_AFTERNOON = new Date(2026, 7, 19, 14, 30);

Deno.test("an in-schedule away rule wins over a matching keyword rule", () => {
  const match = matchAutoReplyRule([
    rule({ id: "kw", rule_type: "keyword", keywords: ["price"] }),
    rule({ id: "away", rule_type: "away" }),
  ], "what is the price", WEDNESDAY_AFTERNOON);
  assertEquals(match, { ruleId: "away", replyMessage: "reply-away", ruleType: "away" });
});

Deno.test("an away rule scheduled for other days lets the keyword rule through", () => {
  const match = matchAutoReplyRule([
    rule({ id: "away", rule_type: "away", schedule_days: [0, 6] }),
    rule({ id: "kw", rule_type: "keyword", keywords: ["price"] }),
  ], "what is the price", WEDNESDAY_AFTERNOON);
  assertEquals(match?.ruleId, "kw");
});

Deno.test("an away rule with no schedule at all is always in force", () => {
  const match = matchAutoReplyRule(
    [rule({ id: "away", rule_type: "away" })],
    "hello",
    WEDNESDAY_AFTERNOON,
  );
  assertEquals(match?.ruleType, "away");
});

Deno.test("away schedule windows include their bounds and exclude everything outside", () => {
  const cases: Array<{ start: string; end: string; at: Date; expected: boolean }> = [
    { start: "09:00", end: "17:00", at: new Date(2026, 7, 19, 14, 30), expected: true },
    { start: "09:00", end: "17:00", at: new Date(2026, 7, 19, 8, 59), expected: false },
    { start: "09:00", end: "17:00", at: new Date(2026, 7, 19, 17, 0), expected: true },
    { start: "09:00", end: "17:00", at: new Date(2026, 7, 19, 17, 1), expected: false },
    // Overnight window: in force late at night and early morning, off during the day.
    { start: "22:00", end: "06:00", at: new Date(2026, 7, 19, 23, 30), expected: true },
    { start: "22:00", end: "06:00", at: new Date(2026, 7, 19, 5, 0), expected: true },
    { start: "22:00", end: "06:00", at: new Date(2026, 7, 19, 14, 0), expected: false },
  ];

  for (const { start, end, at, expected } of cases) {
    const match = matchAutoReplyRule(
      [rule({ id: "away", rule_type: "away", schedule_start: start, schedule_end: end })],
      "hello",
      at,
    );
    assertEquals(
      match !== null,
      expected,
      `${start}-${end} at ${at.toTimeString().slice(0, 5)} should be ${expected ? "in" : "out of"} window`,
    );
  }
});

Deno.test("seconds on stored schedule times do not break the comparison", () => {
  const match = matchAutoReplyRule(
    [rule({ id: "away", rule_type: "away", schedule_start: "09:00:00", schedule_end: "17:00:00" })],
    "hello",
    WEDNESDAY_AFTERNOON,
  );
  assertEquals(match?.ruleId, "away");
});

Deno.test("keywords match as case-insensitive substrings, not whole words", () => {
  const match = matchAutoReplyRule(
    [rule({ id: "kw", rule_type: "keyword", keywords: ["PRICE"] })],
    "Whats the priceless option",
    WEDNESDAY_AFTERNOON,
  );
  assertEquals(match?.ruleId, "kw");
});

Deno.test("the oldest matching rule wins regardless of input order", () => {
  const newer = rule({ id: "b", rule_type: "keyword", keywords: ["price"], created_at: "2026-05-01T00:00:00Z" });
  const older = rule({ id: "a", rule_type: "keyword", keywords: ["price"], created_at: "2026-01-01T00:00:00Z" });
  assertEquals(matchAutoReplyRule([newer, older], "price?", WEDNESDAY_AFTERNOON)?.ruleId, "a");
  assertEquals(matchAutoReplyRule([older, newer], "price?", WEDNESDAY_AFTERNOON)?.ruleId, "a");
});

Deno.test("a rule with no created_at sorts behind one that has it", () => {
  const undated = rule({ id: "a", rule_type: "keyword", keywords: ["price"], created_at: null });
  const dated = rule({ id: "z", rule_type: "keyword", keywords: ["price"], created_at: "2026-05-01T00:00:00Z" });
  assertEquals(matchAutoReplyRule([undated, dated], "price?", WEDNESDAY_AFTERNOON)?.ruleId, "z");
});

Deno.test("matching does not reorder the caller's array", () => {
  const rules = [
    rule({ id: "b", rule_type: "keyword", keywords: ["price"], created_at: "2026-05-01T00:00:00Z" }),
    rule({ id: "a", rule_type: "keyword", keywords: ["price"], created_at: "2026-01-01T00:00:00Z" }),
  ];
  matchAutoReplyRule(rules, "price?", WEDNESDAY_AFTERNOON);
  assertEquals(rules.map((r) => r.id), ["b", "a"]);
});

Deno.test("keyword rules with empty or null keywords are skipped rather than matching everything", () => {
  assertEquals(
    matchAutoReplyRule([
      rule({ id: "null", rule_type: "keyword", keywords: null }),
      rule({ id: "empty", rule_type: "keyword", keywords: [] }),
    ], "anything at all", WEDNESDAY_AFTERNOON),
    null,
  );
});

Deno.test("no rule claiming the message returns null", () => {
  assertEquals(
    matchAutoReplyRule([rule({ id: "kw", rule_type: "keyword", keywords: ["refund"] })], "hello there", WEDNESDAY_AFTERNOON),
    null,
  );
  assertEquals(matchAutoReplyRule([], "hello", WEDNESDAY_AFTERNOON), null);
});
