import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CSV_COLUMNS,
  TRUNCATION_NOTICE,
  estimateMediaBytes,
  safeFileName,
  toCsv,
  toCsvRows,
  toMarkdown,
  type TranscriptConversation,
  type TranscriptMessage,
} from "./conversationTranscript";

const conversation: TranscriptConversation = {
  id: "wa_acct_96551111111",
  participantName: "Ada",
  participantPhone: "96551111111",
  accountLabel: "Support",
};

function message(overrides: Partial<TranscriptMessage> = {}): TranscriptMessage {
  return {
    id: "m1",
    message: "hello",
    from: { name: "Ada", id: "96551111111" },
    created_time: "2026-08-24T09:04:00.000Z",
    direction: "inbound",
    status: "delivered",
    provider_message_id: "wamid.1",
    attachments: [],
    ...overrides,
  };
}

describe("conversationTranscript", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a mixed conversation with day boundaries, media, and revocation", () => {
    const messages: TranscriptMessage[] = [
      message({
        id: "img-1",
        message: "see this",
        created_time: "2026-08-24T09:04:00.000Z",
        attachments: [{
          kind: "image",
          message_row_id: "img-1",
          mime_type: "image/jpeg",
          name: "photo.jpg",
        }],
      }),
      message({
        id: "voice-1",
        message: "",
        created_time: "2026-08-24T09:05:00.000Z",
        attachments: [{
          kind: "audio",
          message_row_id: "voice-1",
          mime_type: "audio/ogg",
          name: "note.ogg",
          duration_seconds: 7,
        }],
      }),
      message({
        id: "text-1",
        message: "next day",
        created_time: "2026-08-25T08:00:00.000Z",
        from: { name: "Support", id: "96550000000" },
        direction: "outbound",
      }),
      message({
        id: "del-1",
        message: "gone",
        created_time: "2026-08-25T08:01:00.000Z",
        revoked_at: "2026-08-25T08:02:00.000Z",
      }),
    ];
    const mediaIndex = new Map([
      ["img-1", "img-1.jpg"],
      ["voice-1", "voice-1.ogg"],
    ]);

    const markdown = toMarkdown(conversation, messages, { mediaIndex });

    expect(markdown).toContain("participant: Ada");
    expect(markdown).toContain("phone: 96551111111");
    expect(markdown).toContain("account: Support");
    expect(markdown).toContain("exported_at: 2026-08-25T12:00:00.000Z");
    expect(markdown).toContain("message_count: 4");
    expect(markdown).toContain("truncated: false");
    expect(markdown).toContain("## 2026-08-24");
    expect(markdown).toContain("## 2026-08-25");
    expect(markdown).toContain("**09:04** — Ada: see this");
    expect(markdown).toContain("![img](media/img-1.jpg)");
    expect(markdown).toContain("[voice note 0:07](media/voice-1.ogg)");
    expect(markdown).toContain("**08:00** — Support: next day");
    expect(markdown).toContain("~~deleted~~");
    expect(markdown).not.toContain("gone");
  });

  it("uses placeholders when media is not included", () => {
    const markdown = toMarkdown(conversation, [
      message({
        id: "img-1",
        message: "",
        attachments: [{ kind: "image", message_row_id: "img-1", mime_type: "image/jpeg", name: null }],
      }),
    ]);
    expect(markdown).toContain("_[image]_");
    expect(markdown).not.toContain("![img]");
  });

  it("puts a visible truncation notice in the transcript, not only in logs", () => {
    const markdown = toMarkdown(conversation, [message()], { truncated: true });
    expect(markdown).toContain("truncated: true");
    expect(markdown).toContain(TRUNCATION_NOTICE);
  });

  it("emits CSV columns in stable order and quotes commas", () => {
    const rows = toCsvRows(conversation, [
      message({
        id: "m1",
        message: "hello, world",
        created_time: "2026-08-24T09:04:00.000Z",
      }),
    ]);
    expect(Object.keys(rows[0])).toEqual([...CSV_COLUMNS]);
    expect(rows[0]?.message_text).toBe("hello, world");
    expect(rows[0]?.direction).toBe("inbound");
    expect(rows[0]?.message_type).toBe("text");

    const csv = toCsv(conversation, [
      message({ id: "m1", message: "hello, world" }),
    ]);
    // Papa emits CRLF, which is what RFC 4180 and Excel want. Split on either so the
    // assertion is about column order rather than the line terminator.
    expect(csv.split(/\r?\n/)[0]).toBe(CSV_COLUMNS.join(","));
    expect(csv).toContain('"hello, world"');
  });

  it("estimates media payload from attachment kinds", () => {
    const bytes = estimateMediaBytes([
      message({
        attachments: [{ kind: "image", message_row_id: "a", mime_type: "image/jpeg", name: null }],
      }),
    ]);
    expect(bytes).toBe(400_000);
  });
});

describe("safeFileName", () => {
  it("strips path traversal to a filesystem-safe non-empty name", () => {
    const name = safeFileName("../../etc/passwd", "96551111111");
    expect(name).not.toMatch(/\.\./);
    expect(name).not.toMatch(/[/\\]/);
    expect(name.length).toBeGreaterThan(0);
    expect(name).toMatch(/-1111$/);
  });

  it("keeps Arabic and other non-Latin letters", () => {
    expect(safeFileName("محمد", "96552222222")).toBe("محمد-2222");
  });

  it("falls back when the participant name is empty", () => {
    expect(safeFileName("", "96553333333")).toBe("chat-3333");
    expect(safeFileName("   ", "")).toBe("chat-0000");
  });

  it("gives distinct names to two chats whose display names collide", () => {
    expect(safeFileName("Ada", "96551111111")).not.toBe(safeFileName("Ada", "96552222222"));
    expect(safeFileName("Ada", "96551111111")).toBe("Ada-1111");
    expect(safeFileName("Ada", "96552222222")).toBe("Ada-2222");
  });
});
