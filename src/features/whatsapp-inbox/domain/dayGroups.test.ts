import { describe, expect, it } from "vitest";
import { formatListTime, groupByDay } from "./dayGroups";

describe("groupByDay", () => {
  it("groups consecutive messages by local day and labels today/yesterday", () => {
    const now = new Date();
    const today = new Date(now);
    today.setHours(9, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const groups = groupByDay([
      { id: "1", created_time: yesterday.toISOString() },
      { id: "2", created_time: today.toISOString() },
      { id: "3", created_time: today.toISOString() },
    ], now);
    expect(groups.map((g) => [g.label, g.rows.length])).toEqual([["Yesterday", 1], ["Today", 2]]);
  });

  it("labels older days with a medium date", () => {
    const now = new Date(2026, 8, 6, 12, 0, 0);
    const groups = groupByDay([{ id: "1", created_time: new Date(2026, 7, 30, 9, 0, 0).toISOString() }], now);
    expect(groups[0].label).toBe(new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(2026, 7, 30, 9, 0, 0)));
  });
});

describe("formatListTime", () => {
  it("uses the time today and the short date otherwise", () => {
    const now = new Date(2026, 8, 6, 15, 0, 0);
    expect(formatListTime(new Date(2026, 8, 6, 9, 5, 0).toISOString(), now)).toMatch(/09:05/);
    expect(formatListTime(new Date(2026, 7, 30, 9, 5, 0).toISOString(), now)).toBe("30/08/26");
  });
});
