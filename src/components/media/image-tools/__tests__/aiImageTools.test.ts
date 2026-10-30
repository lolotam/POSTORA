import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiImageToolError,
  PROVIDER_UNAVAILABLE_CODE,
  isCloudinaryTransformsAvailable,
  isProviderUnavailable,
  runBackgroundRemoval,
  runUpscale,
} from "../aiImageTools";
import { DEFAULT_CDN_STORAGE_CONFIG } from "@/lib/cdnConfig";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke } } }));

/** What supabase-js hands back for a non-2xx function answer: an error whose `context` is the Response. */
function httpFailure(status: number, body: unknown) {
  const error = new Error("Edge Function returned a non-2xx status code") as Error & { context: Response };
  error.context = new Response(JSON.stringify(body), { status });
  return { data: null, error };
}

describe("isCloudinaryTransformsAvailable", () => {
  it("is false under the default policy (Openinary only) and before the config has loaded", () => {
    expect(isCloudinaryTransformsAvailable(DEFAULT_CDN_STORAGE_CONFIG)).toBe(false);
    expect(isCloudinaryTransformsAvailable(undefined)).toBe(false);
  });

  it("is true when the admin policy still writes to Cloudinary", () => {
    expect(
      isCloudinaryTransformsAvailable({ ...DEFAULT_CDN_STORAGE_CONFIG, write_policy: { providers: ["openinary", "cloudinary"], required: ["openinary"] } }),
    ).toBe(true);
  });
});

describe("AI image tool calls", () => {
  beforeEach(() => invoke.mockReset());

  it("background removal posts the image URL to remove-background and returns processed_url", async () => {
    invoke.mockResolvedValue({ data: { success: true, processed_url: "https://o.example/t/out.png" }, error: null });
    await expect(runBackgroundRemoval("https://o.example/t/in.jpg")).resolves.toBe("https://o.example/t/out.png");
    expect(invoke).toHaveBeenCalledWith("remove-background", { body: { image_url: "https://o.example/t/in.jpg" } });
  });

  it("upscale asks AtlasCloud for 4K and returns upscaled_url", async () => {
    invoke.mockResolvedValue({ data: { success: true, upscaled_url: "https://o.example/t/up.jpg" }, error: null });
    await expect(runUpscale("https://o.example/t/in.jpg")).resolves.toBe("https://o.example/t/up.jpg");
    expect(invoke).toHaveBeenCalledWith("upscale-image", { body: { image_url: "https://o.example/t/in.jpg", platform: "atlascloud", scale: 4 } });
  });

  it("a 503 PROVIDER_UNAVAILABLE keeps the server's message and is recognised as 'unavailable'", async () => {
    invoke.mockResolvedValue(httpFailure(503, { success: false, error: "Background removal is temporarily unavailable", code: PROVIDER_UNAVAILABLE_CODE }));
    const failure = await runBackgroundRemoval("https://o.example/in.jpg").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AiImageToolError);
    expect((failure as Error).message).toBe("Background removal is temporarily unavailable");
    expect(isProviderUnavailable(failure)).toBe(true);
  });

  it("other failures carry the server's message but are not 'unavailable'", async () => {
    invoke.mockResolvedValue(httpFailure(502, { success: false, error: "Upscaling failed. Please try again.", code: "UPSCALE_FAILED" }));
    const failure = await runUpscale("https://o.example/in.jpg").catch((e: unknown) => e);
    expect((failure as Error).message).toBe("Upscaling failed. Please try again.");
    expect(isProviderUnavailable(failure)).toBe(false);
  });

  it("a network error without a response body still surfaces its own message", async () => {
    invoke.mockResolvedValue({ data: null, error: new Error("Failed to send a request to the Edge Function") });
    await expect(runUpscale("https://o.example/in.jpg")).rejects.toThrow("Failed to send a request to the Edge Function");
  });

  it("a success answer without a result URL is an error, never a silent success", async () => {
    invoke.mockResolvedValue({ data: { success: true }, error: null });
    await expect(runBackgroundRemoval("https://o.example/in.jpg")).rejects.toBeInstanceOf(AiImageToolError);
    invoke.mockResolvedValue({ data: { success: false, error: "nope" }, error: null });
    await expect(runUpscale("https://o.example/in.jpg")).rejects.toThrow("nope");
  });
});
