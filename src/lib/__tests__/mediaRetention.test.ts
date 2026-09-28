import { describe, expect, it, vi } from "vitest";
import { daysUntilDeletion, retentionBadgeTone, setMediaKeep } from "@/lib/mediaRetention";

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

describe("media_set_keep", () => {
  it("Keep calls media_set_keep for one file", async () => {
    rpc.mockResolvedValue({ error: null });
    await setMediaKeep(["file-1"], true);
    expect(rpc).toHaveBeenCalledWith("media_set_keep", { p_ids: ["file-1"], p_keep: true });
  });

  it("Keep forever bulk sends every selected id", async () => {
    rpc.mockResolvedValue({ error: null });
    await setMediaKeep(["a", "b", "c"], true);
    expect(rpc).toHaveBeenCalledWith("media_set_keep", { p_ids: ["a", "b", "c"], p_keep: true });
    await setMediaKeep(["a", "b"], false);
    expect(rpc).toHaveBeenCalledWith("media_set_keep", { p_ids: ["a", "b"], p_keep: false });
  });
});
