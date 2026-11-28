import { beforeEach, describe, expect, it, vi } from "vitest";
import { SupabaseYouTubeResourcesGateway } from "../supabaseYouTubeResourcesGateway";
import { YouTubeResourceError } from "../../domain/errors";

const invokeMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: {
      invoke: (...args: unknown[]) => invokeMock(...args),
    },
  },
}));

function makeEnvelope<T>(data: T) {
  return {
    schema_version: 1 as const,
    request_id: "req-1",
    freshness: { fetched_at: "2026-11-28T00:00:00.000Z" },
    data,
  };
}

describe("SupabaseYouTubeResourcesGateway", () => {
  const gateway = new SupabaseYouTubeResourcesGateway();

  beforeEach(() => {
    invokeMock.mockReset();
  });

  describe("getEditSnapshot", () => {
    it.each([false, true])(
      "preserves restrictions.scheduleProtected = %s from edit_snapshot response data",
      async (scheduleProtected) => {
        invokeMock.mockResolvedValueOnce({
          data: makeEnvelope({
            revision: "rev-1",
            values: {
              title: "My Video",
              description: "Desc",
              tags: ["tag1"],
              privacyStatus: "private",
              categoryId: "22",
            },
            restrictions: {
              scheduleProtected,
            },
          }),
          error: null,
        });

        const result = await gateway.getEditSnapshot({
          accountId: "acc-1",
          videoId: "AbcD1234eFg",
        });

        expect(invokeMock).toHaveBeenCalledWith("youtube-resources", {
          body: {
            operation: "edit_snapshot",
            account_id: "acc-1",
            video_id: "AbcD1234eFg",
          },
          timeout: 15000,
        });
        expect(result.data.revision).toBe("rev-1");
        expect(result.data.restrictions).toEqual({ scheduleProtected });
      },
    );

    it("rejects malformed restrictions when scheduleProtected is not a boolean", async () => {
      invokeMock.mockResolvedValueOnce({
        data: makeEnvelope({
          revision: "rev-1",
          values: {
            title: "My Video",
            privacyStatus: "private",
            categoryId: "22",
          },
          restrictions: {
            scheduleProtected: "yes",
          },
        }),
        error: null,
      });

      await expect(
        gateway.getEditSnapshot({
          accountId: "acc-1",
          videoId: "AbcD1234eFg",
        }),
      ).rejects.toBeInstanceOf(YouTubeResourceError);
    });
  });

  describe("updateVideo", () => {
    it("omits privacy_confirmation when privacyConfirmation is not provided", async () => {
      invokeMock.mockResolvedValueOnce({
        data: makeEnvelope({ revision: "rev-2" }),
        error: null,
      });

      const result = await gateway.updateVideo({
        accountId: "acc-1",
        videoId: "AbcD1234eFg",
        baseRevision: "rev-1",
        changes: { title: "Updated Title" },
      });

      expect(result.data.revision).toBe("rev-2");
      expect(invokeMock).toHaveBeenCalledWith("youtube-resources", {
        body: {
          operation: "update_video",
          account_id: "acc-1",
          video_id: "AbcD1234eFg",
          base_revision: "rev-1",
          changes: { title: "Updated Title" },
        },
        timeout: 15000,
      });
      const sentBody = invokeMock.mock.calls[0]?.[1]?.body as Record<string, unknown>;
      expect("privacy_confirmation" in sentBody).toBe(false);
    });

    it("sends both changes.privacy_status and privacy_confirmation: { to } when provided", async () => {
      invokeMock.mockResolvedValueOnce({
        data: makeEnvelope({ revision: "rev-3" }),
        error: null,
      });

      const result = await gateway.updateVideo({
        accountId: "acc-1",
        videoId: "AbcD1234eFg",
        baseRevision: "rev-1",
        changes: { privacy_status: "unlisted" },
        privacyConfirmation: { to: "unlisted" },
      });

      expect(result.data.revision).toBe("rev-3");
      expect(invokeMock).toHaveBeenCalledWith("youtube-resources", {
        body: {
          operation: "update_video",
          account_id: "acc-1",
          video_id: "AbcD1234eFg",
          base_revision: "rev-1",
          changes: { privacy_status: "unlisted" },
          privacy_confirmation: { to: "unlisted" },
        },
        timeout: 15000,
      });
    });
  });
});
