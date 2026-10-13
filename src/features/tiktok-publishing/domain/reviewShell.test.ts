import { describe, expect, it } from "vitest";
import {
  draftStatus,
  hashtagsToAppend,
  parseApprovalsTab,
  settingsNeedAttention,
  statesForTab,
  tiktokSummary,
} from "./approvals";
import { dayKey, parseCalendarView, parseDayKey, periodTitle, shiftAnchor, visibleDays } from "./calendarGrid";
import { activityGroup, countByFilter, toPipelineItem } from "./pipelineItems";
import { isReviewPathAllowed } from "./shellRoutes";
import type { PublishStatus, ReviewDraft, TikTokSettings } from "./types";

const settings: TikTokSettings = {
  privacy: null,
  allowComment: false,
  allowDuet: false,
  allowStitch: false,
  disclose: false,
  yourBrand: false,
  brandedContent: false,
  aiGenerated: false,
};

function draft(overrides: Partial<ReviewDraft> = {}): ReviewDraft {
  return {
    id: "d1",
    accountId: "a1",
    revision: 1,
    state: "pending_review",
    caption: "Hello",
    mediaFileId: null,
    mediaDurationSec: null,
    settings,
    rejectionReason: null,
    updatedAt: "2026-10-14T10:00:00.000Z",
    submission: null,
    ...overrides,
  };
}

function status(state: PublishStatus["state"], reason: string | null = null): PublishStatus {
  return { state, updatedAt: "2026-10-14T10:00:00.000Z", reason, postUrl: state === "published" ? "https://tiktok.com/v/1" : null };
}

describe("approvals tabs", () => {
  it("maps each tab to the review states it lists", () => {
    expect(statesForTab("pending")).toEqual(["pending_review"]);
    expect(statesForTab("approved")).toEqual(["submitted"]);
    expect(statesForTab("rejected")).toEqual(["rejected"]);
    expect(statesForTab("all")).toEqual(["pending_review", "submitted", "rejected", "archived"]);
  });

  it("falls back to pending for a missing or unknown ?tab=", () => {
    expect(parseApprovalsTab(null)).toBe("pending");
    expect(parseApprovalsTab("bogus")).toBe("pending");
    expect(parseApprovalsTab("all")).toBe("all");
  });
});

describe("settingsNeedAttention", () => {
  it("is true for blockers only the settings popover can fix", () => {
    expect(settingsNeedAttention([{ code: "CONSENT_REQUIRED", message: "" }])).toBe(true);
    expect(settingsNeedAttention([{ code: "PRIVACY_REQUIRED", message: "" }])).toBe(true);
  });

  it("is false for blockers fixed elsewhere", () => {
    expect(settingsNeedAttention([{ code: "MEDIA_REQUIRED", message: "" }, { code: "SCHEDULE_TIME_REQUIRED", message: "" }])).toBe(false);
    expect(settingsNeedAttention([])).toBe(false);
  });
});

describe("draftStatus", () => {
  it("labels review states", () => {
    expect(draftStatus("pending_review", null)).toEqual({ pill: "Pending", tag: "Awaiting review", tone: "highlight" });
    expect(draftStatus("rejected", null).pill).toBe("Rejected");
    expect(draftStatus("archived", null).pill).toBe("Archived");
  });

  it("folds the publish outcome into a sent draft", () => {
    expect(draftStatus("submitted", "published").pill).toBe("Published");
    expect(draftStatus("submitted", "failed").pill).toBe("Publish failed");
    expect(draftStatus("submitted", "needs_attention").pill).toBe("Publish failed");
    expect(draftStatus("submitted", "scheduled").pill).toBe("Scheduled");
    expect(draftStatus("submitted", "processing").pill).toBe("Publishing");
    expect(draftStatus("submitted", null).pill).toBe("Approved");
  });
});

describe("tiktokSummary", () => {
  it("reads audience, type and comments", () => {
    expect(tiktokSummary(settings)).toBe("Choose audience · Video · Comments off");
    expect(tiktokSummary({ ...settings, privacy: "MUTUAL_FOLLOW_FRIENDS", allowComment: true })).toBe("Friends · Video · Comments on");
  });
});

describe("hashtagsToAppend", () => {
  it("turns comma or space separated words into tags", () => {
    expect(hashtagsToAppend("brand, launch story", "")).toBe("#brand #launch #story");
  });

  it("skips tags the caption already has, duplicates and junk", () => {
    expect(hashtagsToAppend("#Brand, brand, new!, ok", "Hi #brand")).toBe("#ok");
    expect(hashtagsToAppend("   ", "x")).toBe("");
  });
});

describe("calendar grid", () => {
  const anchor = new Date(2026, 9, 14); // Wed 14 Oct 2026

  it("parses ?date= and ?view= with safe fallbacks", () => {
    expect(dayKey(parseDayKey("2026-10-12", anchor))).toBe("2026-10-12");
    expect(dayKey(parseDayKey("2026-02-30", anchor))).toBe("2026-10-14");
    expect(dayKey(parseDayKey(null, anchor))).toBe("2026-10-14");
    expect(parseCalendarView("week")).toBe("week");
    expect(parseCalendarView("year")).toBe("month");
  });

  it("shows six Sunday-first weeks for a month", () => {
    const days = visibleDays(anchor, "month");
    expect(days).toHaveLength(42);
    expect(dayKey(days[0]!)).toBe("2026-09-27");
    expect(days[0]!.getDay()).toBe(0);
  });

  it("shows the Sunday-first week and the single day", () => {
    expect(visibleDays(anchor, "week").map(dayKey)).toEqual([
      "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17",
    ]);
    expect(visibleDays(anchor, "day").map(dayKey)).toEqual(["2026-10-14"]);
  });

  it("moves by one period and titles it", () => {
    expect(dayKey(shiftAnchor(anchor, "month", 1))).toBe("2026-11-01");
    expect(dayKey(shiftAnchor(anchor, "week", -1))).toBe("2026-10-07");
    expect(dayKey(shiftAnchor(anchor, "day", 1))).toBe("2026-10-15");
    expect(periodTitle(anchor, "month")).toBe("October 2026");
    expect(periodTitle(anchor, "week")).toBe("Oct 11 – 17, 2026");
    expect(periodTitle(anchor, "day")).toBe("Wednesday, October 14, 2026");
    expect(periodTitle(new Date(2026, 8, 30), "week")).toBe("Sep 27 – Oct 3, 2026");
  });
});

describe("pipeline items", () => {
  const sent = draft({
    state: "submitted",
    submission: { id: "s1", postId: "p1", mode: "scheduled", scheduledAt: "2026-10-20T09:00:00.000Z" },
  });

  it("places a scheduled post on its publish time and keeps the failure reason", () => {
    const item = toPipelineItem(sent, status("failed", "tiktok_init_http_403"));
    expect(item.when).toBe("2026-10-20T09:00:00.000Z");
    expect(item.filter).toBe("failed");
    expect(item.failureReason).toBe("tiktok_init_http_403");
    expect(item.postUrl).toBeNull();
  });

  it("counts drafts per Activity filter", () => {
    const items = [
      toPipelineItem(draft(), null),
      toPipelineItem(sent, status("published")),
      toPipelineItem(sent, null),
      toPipelineItem(draft({ state: "archived" }), null),
    ];
    expect(countByFilter(items)).toEqual({
      all: 4, pending: 1, scheduled: 1, published: 1, failed: 0, rejected: 0, archived: 1,
    });
    expect(items[1]!.postUrl).toBe("https://tiktok.com/v/1");
  });

  it("groups Activity by today, the past week and earlier", () => {
    const now = new Date(2026, 9, 14, 15, 0);
    expect(activityGroup(new Date(2026, 9, 14, 1, 0).toISOString(), now)).toBe("Today");
    expect(activityGroup(new Date(2026, 9, 8, 12, 0).toISOString(), now)).toBe("This week");
    expect(activityGroup(new Date(2026, 9, 7, 23, 0).toISOString(), now)).toBe("Earlier");
  });
});

describe("review shell routes", () => {
  it("allows the pipeline pages and the TikTok OAuth return", () => {
    for (const path of ["/approvals", "/calendar", "/activity", "/settings", "/integrations", "/pricing", "/tiktok-callback", "/approvals/"]) {
      expect(isReviewPathAllowed(path)).toBe(true);
    }
  });

  it("keeps everything else out", () => {
    for (const path of ["/dashboard", "/post", "/history", "/tiktok-publish", "/tiktok-auth", "/profiles", "/admin", "/approvals/x"]) {
      expect(isReviewPathAllowed(path)).toBe(false);
    }
  });
});
