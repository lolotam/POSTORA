import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  invoke: vi.fn(),
  resolveAiImageResponse: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: fake.invoke } },
}));

vi.mock("@/lib/aiGenerationJobWatcher", () => ({
  resolveAiImageResponse: fake.resolveAiImageResponse,
}));

import { SupabaseYouTubeThumbnailAiGateway } from "../supabaseYouTubeThumbnailAiGateway";

beforeEach(() => {
  fake.invoke.mockReset();
  fake.resolveAiImageResponse.mockReset();
});

describe("generating a thumbnail with AI", () => {
  it("sends the request the app's own image generator expects", async () => {
    fake.invoke.mockResolvedValue({ data: { imageUrl: "https://images.test/thumb.jpg" }, error: null });
    fake.resolveAiImageResponse.mockResolvedValue({ imageUrl: "https://images.test/thumb.jpg" });

    const result = await new SupabaseYouTubeThumbnailAiGateway().generate({
      prompt: "a calm studio desk",
      referenceImage: "data:image/png;base64,AAA",
    });

    expect(fake.invoke).toHaveBeenCalledWith("generate-image", {
      body: {
        prompt: "a calm studio desk",
        aspectRatio: "16:9",
        referenceImage: "data:image/png;base64,AAA",
        async: true,
      },
    });
    expect(result).toEqual({ imageUrl: "https://images.test/thumb.jpg" });
  });

  it("sends no reference image when there is none", async () => {
    fake.invoke.mockResolvedValue({ data: { imageUrl: "https://images.test/thumb.jpg" }, error: null });
    fake.resolveAiImageResponse.mockResolvedValue({ imageUrl: "https://images.test/thumb.jpg" });

    await new SupabaseYouTubeThumbnailAiGateway().generate({ prompt: "a calm studio desk" });

    expect(fake.invoke.mock.calls[0][1].body.referenceImage).toBeUndefined();
  });

  it("fails when the generator answers with an error", async () => {
    fake.invoke.mockResolvedValue({ data: null, error: new Error("provider refused") });

    await expect(new SupabaseYouTubeThumbnailAiGateway().generate({ prompt: "a desk" }))
      .rejects.toThrow(/provider refused/);
  });

  it("fails when the generator answers without an image", async () => {
    fake.invoke.mockResolvedValue({ data: { success: false, message: "Image generation failed" }, error: null });
    fake.resolveAiImageResponse.mockResolvedValue({ success: false, message: "Image generation failed" });

    await expect(new SupabaseYouTubeThumbnailAiGateway().generate({ prompt: "a desk" }))
      .rejects.toThrow(/Image generation failed/);
  });

  it("refuses a request that was cancelled before it was sent", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(new SupabaseYouTubeThumbnailAiGateway().generate({
      prompt: "a desk",
      signal: controller.signal,
    })).rejects.toThrow(/cancelled/);

    expect(fake.invoke).not.toHaveBeenCalled();
  });
});
