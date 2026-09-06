import { describe, expect, it } from "vitest";
import { describeSyncOutcome } from "./whatsappSyncOutcome";

describe("describeSyncOutcome", () => {
  it("summarises a complete sweep", () => {
    const result = describeSyncOutcome({
      finished_at: "x",
      chatsImported: 12,
      messagesWritten: 340,
      chatsAwaitingLid: 0,
      truncated: false,
    });
    expect(result.title).toBe("Chats imported");
    expect(result.description).toBe("12 chats, 340 messages.");
    expect(result.variant).toBe("default");
  });

  it("asks for another run when truncated and mentions waiting LID chats", () => {
    const result = describeSyncOutcome({
      finished_at: "x",
      chatsImported: 25,
      messagesWritten: 900,
      chatsAwaitingLid: 7,
      truncated: true,
    });
    expect(result.title).toBe("Partial import");
    expect(result.description).toBe(
      "25 chats, 900 messages. Run again to continue. 7 chats are waiting for a first message from the contact.",
    );
  });

  it("surfaces an error", () => {
    const result = describeSyncOutcome({ finished_at: "x", error: "Evolution unreachable" });
    expect(result.title).toBe("Import failed");
    expect(result.description).toBe("Evolution unreachable");
    expect(result.variant).toBe("destructive");
  });
});
