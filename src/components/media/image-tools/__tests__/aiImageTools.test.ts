import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiImageToolError,
  CLIENT_TIMEOUT_CODE,
  PROVIDER_UNAVAILABLE_CODE,
  cloudinaryTransformsState,
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

const withCloudinary = { ...DEFAULT_CDN_STORAGE_CONFIG, write_policy: { providers: ["openinary", "cloudinary"] as ("openinary" | "cloudinary")[], required: ["openinary"] as ("openinary" | "cloudinary")[] } };

describe("Cloudinary transforms state", () => {
  it("is false under the default policy (Openinary only) and before the config has loaded", () => {
    expect(isCloudinaryTransformsAvailable(DEFAULT_CDN_STORAGE_CONFIG)).toBe(false);
    expect(isCloudinaryTransformsAvailable(undefined)).toBe(false);
  });

  it("is true when the admin policy still writes to Cloudinary", () => {
    expect(isCloudinaryTransformsAvailable(withCloudinary)).toBe(true);
  });

  it("tells 'still loading' apart from 'confirmed unavailable'", () => {
    expect(cloudinaryTransformsState({ data: undefined, isLoading: true })).toBe("loading");
    expect(cloudinaryTransformsState({ data: DEFAULT_CDN_STORAGE_CONFIG, isLoading: false })).toBe("unavailable");
    expect(cloudinaryTransformsState({ data: withCloudinary, isLoading: false })).toBe("available");
    // a failed read: the config reader's own fallback is the Openinary-only default
    expect(cloudinaryTransformsState({ data: undefined, isLoading: false })).toBe("unavailable");
  });
});

describe("AI image tool calls", () => {
  beforeEach(() => invoke.mockReset());

  it("background removal posts the image URL to remove-background and returns processed_url", async () => {
    invoke.mockResolvedValue({ data: { success: true, processed_url: "https://o.example/t/out.png" }, error: null });
    await expect(runBackgroundRemoval("https://o.example/t/in.jpg")).resolves.toBe("https://o.example/t/out.png");
    expect(invoke).toHaveBeenCalledWith("remove-background", { body: { image_url: "https://o.example/t/in.jpg" } });
  });

  it("upscale names no provider (the server decides) and returns upscaled_url", async () => {
    invoke.mockResolvedValue({ data: { success: true, upscaled_url: "https://o.example/t/up.jpg" }, error: null });
    await expect(runUpscale("https://o.example/t/in.jpg")).resolves.toBe("https://o.example/t/up.jpg");
    expect(invoke).toHaveBeenCalledWith("upscale-image", { body: { image_url: "https://o.example/t/in.jpg", scale: 4 } });
    expect(JSON.stringify(invoke.mock.calls[0][1])).not.toContain("platform");
  });

  it("upscale can ask for PNG, so a cut-out keeps its transparency", async () => {
    invoke.mockResolvedValue({ data: { success: true, upscaled_url: "https://o.example/t/up.png" }, error: null });
    await runUpscale("https://o.example/t/cutout.png", { outputFormat: "png" });
    expect(invoke).toHaveBeenCalledWith("upscale-image", { body: { image_url: "https://o.example/t/cutout.png", scale: 4, output_format: "png" } });
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

describe("a job that is still running when the first request answers (202)", () => {
  beforeEach(() => invoke.mockReset());

  const processing = (token: string, retry = 3) => ({ data: { success: true, status: "processing", prediction_id: token, retry_after_seconds: retry }, error: null });
  /** A clock the fake sleep advances. */
  function clock() {
    let t = 0;
    const waits: number[] = [];
    return { now: () => t, sleep: (ms: number) => { waits.push(ms); t += ms; return Promise.resolve(); }, waits };
  }

  it("asks again with only the prediction_id, at the server's pace, until the result is ready", async () => {
    invoke
      .mockResolvedValueOnce(processing("tok-1", 3))
      .mockResolvedValueOnce(processing("tok-1", 3))
      .mockResolvedValueOnce({ data: { success: true, status: "completed", processed_url: "https://o.example/t/out.png" }, error: null });
    const c = clock();
    await expect(runBackgroundRemoval("https://o.example/in.jpg", c)).resolves.toBe("https://o.example/t/out.png");
    expect(invoke.mock.calls.map((call) => call[1])).toEqual([
      { body: { image_url: "https://o.example/in.jpg" } },
      { body: { prediction_id: "tok-1" } },
      { body: { prediction_id: "tok-1" } },
    ]);
    expect(c.waits).toEqual([3000, 3000]);
    expect(invoke.mock.calls.every((call) => call[0] === "remove-background")).toBe(true);
  });

  it("follows up on the same function for upscale too", async () => {
    invoke
      .mockResolvedValueOnce(processing("tok-2"))
      .mockResolvedValueOnce({ data: { success: true, status: "completed", upscaled_url: "https://o.example/t/up.png" }, error: null });
    await expect(runUpscale("https://o.example/in.png", { ...clock(), outputFormat: "png" })).resolves.toBe("https://o.example/t/up.png");
    expect(invoke.mock.calls[1]).toEqual(["upscale-image", { body: { prediction_id: "tok-2" } }]);
  });

  it("gives up after the bounded wait with a clear 'timed out' error", async () => {
    invoke.mockResolvedValue(processing("tok-3", 3));
    const c = clock();
    const failure = await runBackgroundRemoval("https://o.example/in.jpg", { ...c, maxWaitMs: 10_000 }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AiImageToolError);
    expect((failure as AiImageToolError).code).toBe(CLIENT_TIMEOUT_CODE);
    expect((failure as Error).message).toMatch(/timed out/i);
    expect(invoke.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("never sleeps past the deadline: the last wait is cut to what is left, and no follow-up call follows it", async () => {
    invoke.mockResolvedValue(processing("tok-6", 4));
    const c = clock();
    const failure = await runBackgroundRemoval("https://o.example/in.jpg", { ...c, maxWaitMs: 10_000 }).catch((e: unknown) => e);
    expect((failure as AiImageToolError).code).toBe(CLIENT_TIMEOUT_CODE);
    expect(c.waits).toEqual([4000, 4000, 2000]); // 4 s, 4 s, then only the 2 s that were left
    expect(c.waits.reduce((a, b) => a + b, 0)).toBe(10_000);
    expect(invoke).toHaveBeenCalledTimes(3); // the first request and two follow-ups; none after the cut wait
  });

  it("re-checks the deadline right before each follow-up, even when the wait itself ran long", async () => {
    invoke.mockResolvedValue(processing("tok-7", 3));
    let t = 0;
    const overslept = { now: () => t, sleep: () => { t += 20_000; return Promise.resolve(); }, maxWaitMs: 10_000 };
    const failure = await runUpscale("https://o.example/in.jpg", overslept).catch((e: unknown) => e);
    expect((failure as AiImageToolError).code).toBe(CLIENT_TIMEOUT_CODE);
    expect(invoke).toHaveBeenCalledTimes(1); // the sleep overshot the deadline, so no follow-up was made
  });

  it("a failure on a follow-up reaches the caller with the server's message and code", async () => {
    invoke
      .mockResolvedValueOnce(processing("tok-4"))
      .mockResolvedValueOnce(httpFailure(503, { success: false, error: "Background removal is temporarily unavailable", code: PROVIDER_UNAVAILABLE_CODE }));
    const failure = await runBackgroundRemoval("https://o.example/in.jpg", clock()).catch((e: unknown) => e);
    expect(isProviderUnavailable(failure)).toBe(true);
  });

  it("without a retry hint it waits a default interval", async () => {
    invoke
      .mockResolvedValueOnce({ data: { success: true, status: "processing", prediction_id: "tok-5" }, error: null })
      .mockResolvedValueOnce({ data: { success: true, status: "completed", processed_url: "https://o.example/t/out.png" }, error: null });
    const c = clock();
    await runBackgroundRemoval("https://o.example/in.jpg", c);
    expect(c.waits).toEqual([3000]);
  });
});
