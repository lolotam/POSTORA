// supabase/functions/ai-agent-reply/historyWindow.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { historyWindow, type StoredTurn } from "./logic.ts";

const now = Date.parse("2026-09-30T16:31:52Z");
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(now - ms).toISOString();

// Newest first, as the ai_thread_messages query returns them.
const turnsAt = (ms: number, user: string, assistant: string): StoredTurn[] => [
  { role: "assistant", content: assistant, created_at: ago(ms) },
  { role: "user", content: user, created_at: ago(ms) },
];

Deno.test("historyWindow: a greeting 23 days after a disease question replays nothing (2026-09-28 regression)", () => {
  const rows = turnsAt(23 * 24 * HOUR, "ماهي للامراض للكتاكيت", "من أشهر الأمراض: الجمبورو، المارك، النيوكاسل...");

  assertEquals(historyWindow(rows, now), { turns: [], staleNote: null });
});

Deno.test("historyWindow: turns between 12 hours and 7 days stay, oldest first, under an earlier-conversation note", () => {
  const rows = [...turnsAt(3 * 24 * HOUR, "كم سعر الساسو", "الساسو 23 جنيه"), ...turnsAt(4 * 24 * HOUR, "السلام عليكم", "وعليكم السلام")];

  const window = historyWindow(rows, now);

  assertEquals(window.turns.map((turn) => turn.content), ["السلام عليكم", "وعليكم السلام", "كم سعر الساسو", "الساسو 23 جنيه"]);
  assert(window.staleNote?.includes("3 days ago"), window.staleNote ?? "no note");
});

Deno.test("historyWindow: turns under 12 hours old replay with no note", () => {
  const rows = turnsAt(11 * HOUR, "عايز 1000 ساسو", "تمام، هبعتلك التفاصيل");

  assertEquals(historyWindow(rows, now), {
    turns: [{ role: "user", content: "عايز 1000 ساسو" }, { role: "assistant", content: "تمام، هبعتلك التفاصيل" }],
    staleNote: null,
  });
});

Deno.test("historyWindow: only turns past 7 days are cut, and the gap is measured from the newest kept turn", () => {
  const rows = [...turnsAt(2 * HOUR, "الاسعار", "كب 28 جنيه"), ...turnsAt(10 * 24 * HOUR, "ماهي للامراض للكتاكيت", "الجمبورو...")];

  assertEquals(historyWindow(rows, now), {
    turns: [{ role: "user", content: "الاسعار" }, { role: "assistant", content: "كب 28 جنيه" }],
    staleNote: null,
  });
});
