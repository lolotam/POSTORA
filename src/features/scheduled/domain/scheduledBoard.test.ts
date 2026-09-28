import { describe, expect, it } from "vitest";
import { displayMediaName } from "./displayMediaName";
import { maskRecipient } from "./maskRecipient";
import {
  buildCalendarEntries,
  buildScheduledBoard,
  compareScheduledWhen,
  selectablePostIds,
  toWhatsAppCardModel,
  type ScheduledPostSource,
  type ScheduledWhatsAppSource,
} from "./scheduledBoard";
import { whatsAppScheduleAction } from "./whatsAppSchedule";
import { moveKeepingLocalWallClock, movePostToDay } from "./wallClockMove";

const NOW = new Date("2026-09-29T12:00:00.000Z");
const PHONE = "96550001111";

function post(partial: Partial<ScheduledPostSource> & Pick<ScheduledPostSource, "id" | "scheduled_at">): ScheduledPostSource {
  return {
    caption: "Launch",
    platforms: ["instagram"],
    status: "scheduled",
    ...partial,
  };
}

function message(partial: Partial<ScheduledWhatsAppSource> = {}): ScheduledWhatsAppSource {
  return {
    id: "wa-1",
    recipient_phone: PHONE,
    recipient_name: null,
    message_text: "See you then",
    media_url: null,
    media_type: null,
    media_filename: null,
    scheduled_at: "2026-09-29T15:00:00.000Z",
    status: "pending",
    account_name: "Clinic",
    avatar_url: null,
    ...partial,
  };
}

function board(overrides: Partial<Parameters<typeof buildScheduledBoard>[0]> = {}) {
  return buildScheduledBoard({
    posts: [],
    messages: [],
    search: "",
    platform: "all",
    profileId: "all",
    status: "all",
    now: NOW,
    accountFallback: "WhatsApp account",
    profileIdsForPost: () => [],
    ...overrides,
  });
}

describe("scheduled board", () => {
  it("sorts upcoming items ahead of overdue ones and hides cancelled messages", () => {
    const entries = board({
      posts: [
        post({ id: "later", scheduled_at: "2026-09-29T18:00:00.000Z" }),
        post({ id: "overdue", scheduled_at: "2026-09-29T08:00:00.000Z" }),
      ],
      messages: [
        message({ id: "soon", scheduled_at: "2026-09-29T13:00:00.000Z" }),
        message({ id: "gone", status: "cancelled", scheduled_at: "2026-09-29T13:30:00.000Z" }),
      ],
    });
    expect(entries.map((entry) => entry.id)).toEqual(["soon", "later", "overdue"]);
    expect(compareScheduledWhen("2026-09-29T18:00:00.000Z", "2026-09-29T13:00:00.000Z", NOW)).toBeGreaterThan(0);
  });

  it("keeps terminal WhatsApp statuses off the scheduled list and on the calendar", () => {
    const sent = message({ id: "sent", status: "sent" });
    expect(board({ messages: [sent] })).toEqual([]);
    expect(buildCalendarEntries([], [sent], "WhatsApp account").map((entry) => entry.id)).toEqual(["sent"]);
    expect(buildCalendarEntries([], [message({ status: "cancelled" })], "WhatsApp account")).toEqual([]);
  });

  it.each([
    ["claimed"],
    ["sending"],
    ["sent"],
    ["failed"],
    ["skipped"],
  ])("treats %s WhatsApp messages as read-only", (status) => {
    expect(whatsAppScheduleAction(status)).not.toBe("editable");
  });

  it("filters WhatsApp by platform, search, and profile", () => {
    const messages = [message()];
    const posts = [post({ id: "post-1", scheduled_at: "2026-09-29T16:00:00.000Z", caption: "Launch" })];
    expect(board({ posts, messages, platform: "whatsapp" }).every((entry) => entry.kind === "whatsapp")).toBe(true);
    expect(board({ posts, messages, platform: "instagram" }).every((entry) => entry.kind === "post")).toBe(true);
    expect(board({ posts, messages, search: "clinic" }).map((entry) => entry.id)).toEqual(["wa-1"]);
    expect(board({ posts, messages, search: "see you" }).map((entry) => entry.id)).toEqual(["wa-1"]);
    expect(board({ posts, messages, search: PHONE })).toEqual([]);
    expect(board({
      posts,
      messages,
      profileId: "profile-1",
      profileIdsForPost: () => ["profile-1"],
    }).every((entry) => entry.kind === "post")).toBe(true);
  });

  it("selects posts only for bulk actions", () => {
    const entries = board({
      posts: [post({ id: "post-1", scheduled_at: "2026-09-29T16:00:00.000Z" })],
      messages: [message()],
    });
    expect(selectablePostIds(entries)).toEqual(["post-1"]);
  });

  it("masks the recipient and never puts the full number on the card model", () => {
    const named = toWhatsAppCardModel(message({ recipient_name: "Noura" }), "WhatsApp account");
    const masked = toWhatsAppCardModel(message(), "WhatsApp account");
    expect(named.recipientLabel).toBe("Noura");
    expect(masked.recipientLabel).toBe("•••• 1111");
    expect(maskRecipient("", "  ")).toBe("••••");
    expect(JSON.stringify(masked)).not.toContain(PHONE);
    expect(JSON.stringify(named)).not.toContain(PHONE);
  });

  it("uses the stored file name, otherwise the sanitised URL leaf", () => {
    expect(displayMediaName("visit.pdf", "https://cdn.example/ignored.png")).toBe("visit.pdf");
    expect(displayMediaName(null, "https://cdn.example/folder/scan%20result.pdf")).toBe("scan result.pdf");
    expect(displayMediaName("../secret.txt", null)).toBe("secret.txt");
    expect(displayMediaName("bad\u0000name.png", null)).toBe("badname.png");
  });

  it("moves a post to another day without refusing a past time", () => {
    const moved = movePostToDay("2026-09-29T15:45:00.000Z", new Date(2020, 0, 2));
    expect(moved.getFullYear()).toBe(2020);
    expect(moved.getDate()).toBe(2);
    expect(moved.getHours()).toBe(new Date("2026-09-29T15:45:00.000Z").getHours());
    expect(moved.getMinutes()).toBe(new Date("2026-09-29T15:45:00.000Z").getMinutes());
  });

  it("refuses a WhatsApp drop that is under a minute ahead and keeps the local clock", () => {
    const source = "2026-09-29T15:45:30.000Z";
    const target = new Date(2026, 8, 30);
    const moved = moveKeepingLocalWallClock(source, target, NOW.getTime());
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const resolved = new Date(moved.iso);
    const original = new Date(source);
    expect(resolved.getHours()).toBe(original.getHours());
    expect(resolved.getMinutes()).toBe(original.getMinutes());
    expect(resolved.getSeconds()).toBe(0);
    expect(resolved.getDate()).toBe(30);
    expect(moveKeepingLocalWallClock(source, new Date(2020, 0, 1), NOW.getTime())).toEqual({ ok: false, reason: "tooSoon" });
  });
});
