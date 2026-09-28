import { describe, expect, it, vi } from "vitest";
import { daysUntilDeletion, keepUpdateNotice, readDeleteEnabled, retentionBadgeTone, setMediaKeep } from "@/lib/mediaRetention";

const rpc = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc },
}));

describe("retention badge thresholds", () => {
  const now = new Date("2026-09-28T12:00:00.000Z");

  it("stays amber past one day and turns red at one day or less", () => {
    const inTwoDays = new Date(now.getTime() + 25 * 60 * 60 * 1000).toISOString();
    const inOneDay = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const inOneHour = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const already = new Date(now.getTime() - 60 * 1000).toISOString();

    expect(daysUntilDeletion(inTwoDays, now)).toBe(2);
    expect(retentionBadgeTone(daysUntilDeletion(inTwoDays, now))).toBe("amber");
    expect(daysUntilDeletion(inOneDay, now)).toBe(1);
    expect(retentionBadgeTone(daysUntilDeletion(inOneDay, now))).toBe("red");
    expect(daysUntilDeletion(inOneHour, now)).toBe(1);
    expect(retentionBadgeTone(1)).toBe("red");
    expect(daysUntilDeletion(already, now)).toBe(0);
    expect(retentionBadgeTone(0)).toBe("red");
  });
});

describe("delete_enabled reading", () => {
  it("stays unknown when the read fails or returns no row", () => {
    expect(readDeleteEnabled({ error: { message: "permission denied" }, data: null })).toBe("unknown");
    expect(readDeleteEnabled({ error: null, data: null })).toBe("unknown");
    expect(readDeleteEnabled({ error: null, data: {} })).toBe("unknown");
  });

  it("returns the boolean only from a successful row", () => {
    expect(readDeleteEnabled({ error: null, data: { delete_enabled: false } })).toBe(false);
    expect(readDeleteEnabled({ error: null, data: { delete_enabled: true } })).toBe(true);
  });
});

describe("media_set_keep", () => {
  it("Keep calls media_set_keep for one file", async () => {
    rpc.mockResolvedValue({ data: 1, error: null });
    await expect(setMediaKeep(["file-1"], true)).resolves.toEqual({ error: null, updated: 1 });
    expect(rpc).toHaveBeenCalledWith("media_set_keep", { p_ids: ["file-1"], p_keep: true });
  });

  it("Keep forever bulk sends every selected id and returns the updated count", async () => {
    rpc.mockResolvedValue({ data: 2, error: null });
    await expect(setMediaKeep(["a", "b", "c"], true)).resolves.toEqual({ error: null, updated: 2 });
    expect(rpc).toHaveBeenCalledWith("media_set_keep", { p_ids: ["a", "b", "c"], p_keep: true });
    expect(keepUpdateNotice(3, 2)).toBe("partial");
    rpc.mockResolvedValue({ data: 0, error: null });
    await expect(setMediaKeep(["a", "b"], false)).resolves.toEqual({ error: null, updated: 0 });
    expect(keepUpdateNotice(2, 0)).toBe("partial");
    expect(keepUpdateNotice(2, 2)).toBe("success");
  });
});
