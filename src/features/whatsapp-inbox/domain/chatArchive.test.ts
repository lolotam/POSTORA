import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { buildChatArchive, uniqueFileBaseName } from "./chatArchive";

describe("chatArchive", () => {
  const exportedAt = new Date("2026-08-25T12:00:00.000Z");

  it("packs README, transcripts, and media so unzipSync can read them back", () => {
    const zip = buildChatArchive({
      exportedAt,
      accountLabel: "Support",
      chats: [{
        conversationId: "c1",
        participantName: "Ada",
        participantPhone: "96551111111",
        fileBaseName: "Ada-1111",
        markdown: "# Ada\n",
        messageCount: 2,
        truncated: false,
      }],
      mediaFiles: [{ fileName: "img-1.jpg", bytes: new Uint8Array([1, 2, 3]) }],
    });

    const files = unzipSync(zip);
    const prefix = "postora-whatsapp-export-2026-08-25/";
    expect(strFromU8(files[`${prefix}README.md`])).toContain("Account: Support");
    expect(strFromU8(files[`${prefix}README.md`])).toContain("Ada-1111.md");
    expect(strFromU8(files[`${prefix}Ada-1111.md`])).toBe("# Ada\n");
    expect(files[`${prefix}media/img-1.jpg`]).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("records missing media without dropping the transcript", () => {
    const zip = buildChatArchive({
      exportedAt,
      accountLabel: "Support",
      chats: [{
        conversationId: "c1",
        participantName: "Ada",
        participantPhone: "96551111111",
        fileBaseName: "Ada-1111",
        markdown: "body\n",
        messageCount: 1,
        truncated: false,
      }],
      missingMedia: ["img-1.jpg"],
    });
    const files = unzipSync(zip);
    expect(strFromU8(files["postora-whatsapp-export-2026-08-25/media/_missing.txt"]))
      .toContain("img-1.jpg");
    expect(strFromU8(files["postora-whatsapp-export-2026-08-25/Ada-1111.md"])).toBe("body\n");
  });

  it("names colliding participant names distinctly", () => {
    const used = new Set<string>();
    const first = uniqueFileBaseName("Ada", "1111", used);
    const second = uniqueFileBaseName("Ada", "1111", used);
    expect(first).toBe("Ada-1111");
    expect(second).toBe("Ada-1111-2");
  });

  it("states truncation in the README when a chat is partial", () => {
    const zip = buildChatArchive({
      exportedAt,
      accountLabel: "Support",
      chats: [{
        conversationId: "c1",
        participantName: "Ada",
        participantPhone: "96551111111",
        fileBaseName: "Ada-1111",
        markdown: "partial\n",
        messageCount: 40,
        truncated: true,
      }],
    });
    const readme = strFromU8(unzipSync(zip)["postora-whatsapp-export-2026-08-25/README.md"]);
    expect(readme).toContain("| Ada-1111.md | Ada | 40 | yes |");
    expect(readme).toMatch(/truncated/i);
  });
});
