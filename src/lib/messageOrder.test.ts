import { describe, expect, it } from "vitest";
import { sortMessagesForDisplay } from "./messageOrder";

const OLD = { id: "old", created_time: "2026-08-21T17:06:46Z" };
const NEW = { id: "new", created_time: "2026-08-21T18:46:48Z" };

describe("sortMessagesForDisplay", () => {
  it("reverses Graph results, which arrive newest-first", () => {
    expect(sortMessagesForDisplay([NEW, OLD], "facebook").map((m) => m.id)).toEqual(["old", "new"]);
  });

  // Regression, 2026-08-21: the pane reversed WhatsApp the same way it reverses Graph, so the
  // newest bubble landed at the top while auto-scroll went to the bottom and the chat looked
  // frozen. WhatsApp must end up oldest-first whichever order the API served.
  it.each([
    ["newest-first", [NEW, OLD]],
    ["oldest-first", [OLD, NEW]],
  ])("puts the newest WhatsApp message last when served %s", (_order, served) => {
    expect(sortMessagesForDisplay(served, "whatsapp").map((m) => m.id)).toEqual(["old", "new"]);
  });

  // CodeRabbit review on PR #14: messaging-api breaks same-second ties on the row uuid
  // DESCENDING. Array.sort is stable, so a comparator returning 0 for equal timestamps kept
  // that descending run intact — rendering a same-second burst newest-first inside an
  // otherwise oldest-first pane.
  it("orders a same-second burst oldest-first, matching the API's id tie-break", () => {
    const served = [
      { id: "ccc", created_time: "2026-08-21T17:06:46Z" },
      { id: "bbb", created_time: "2026-08-21T17:06:46Z" },
      { id: "aaa", created_time: "2026-08-21T17:06:46Z" },
    ];
    expect(sortMessagesForDisplay(served, "whatsapp").map((m) => m.id)).toEqual([
      "aaa",
      "bbb",
      "ccc",
    ]);
  });

  it("still orders across seconds before falling back to the id", () => {
    const served = [NEW, { id: "zzz", created_time: OLD.created_time }, OLD];
    expect(sortMessagesForDisplay(served, "whatsapp").map((m) => m.id)).toEqual([
      "old",
      "zzz",
      "new",
    ]);
  });

  it("leaves the caller's array untouched, since it is React Query's cached copy", () => {
    const cached = [NEW, OLD];
    sortMessagesForDisplay(cached, "whatsapp");
    expect(cached.map((m) => m.id)).toEqual(["new", "old"]);
  });
});
