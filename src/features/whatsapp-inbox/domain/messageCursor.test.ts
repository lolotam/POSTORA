import { describe, expect, it } from "vitest";
import {
  mergeMessagePages,
  mergeMessageRecord,
  oldestMessageCursor,
  type CursorMessage,
} from "./messageCursor";

function msg(id: string, createdTime: string, extra: Partial<CursorMessage> = {}): CursorMessage {
  return { id, created_time: createdTime, message: id, ...extra };
}

const A = msg("A", "2026-08-25T12:00:03.000Z");
const B = msg("B", "2026-08-25T12:00:02.000Z");
const C = msg("C", "2026-08-25T12:00:01.000Z");

describe("mergeMessagePages", () => {
  it("dedupes a row that appears in both the latest and a history page", () => {
    // Plan snippet used `["C","B","A"].reverse()`, which is newest-first. The hook
    // contract is oldest-first, matching sortMessagesForDisplay.
    expect(mergeMessagePages([A, B], [[B, C]]).map((m) => m.id)).toEqual(["C", "B", "A"]);
  });
});

describe("oldestMessageCursor", () => {
  it("anchors history at the oldest loaded row, not the newest page", () => {
    expect(oldestMessageCursor([A, B, C])).toEqual({ timestamp: C.created_time, id: "C" });
  });
});

describe("mergeMessageRecord", () => {
  it("keeps a revoked latest copy when history still has the pre-revoke body", () => {
    const latest = msg("x", "2026-08-25T12:00:00.000Z", { revoked_at: "2026-08-25T10:00:00Z" });
    const history = msg("x", "2026-08-25T12:00:00.000Z", { revoked_at: null, message: "old" });
    expect(mergeMessageRecord(latest, history).revoked_at).toBe("2026-08-25T10:00:00Z");
  });
});
