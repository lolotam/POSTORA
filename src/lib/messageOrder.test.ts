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

  it("leaves the caller's array untouched, since it is React Query's cached copy", () => {
    const cached = [NEW, OLD];
    sortMessagesForDisplay(cached, "whatsapp");
    expect(cached.map((m) => m.id)).toEqual(["new", "old"]);
  });
});
