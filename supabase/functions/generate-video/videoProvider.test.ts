// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { pickVideoProvider, VercelVideoInput, type VideoModelRow } from "./videoProvider.ts";

const row = (provider_code: string, overrides: Partial<VideoModelRow> = {}): VideoModelRow => ({
  model_id: "shared-video", metadata: null, is_active: true, capabilities: ["video"],
  ai_providers: { provider_code, is_active: true }, ...overrides,
});

Deno.test("the provider is resolved from the model row, higgsfield before vercel whatever the row order", () => {
  assertEquals(pickVideoProvider([row("vercel")])?.provider, "vercel");
  assertEquals(pickVideoProvider([row("higgsfield")])?.provider, "higgsfield");
  assertEquals(pickVideoProvider([row("vercel"), row("higgsfield")])?.provider, "higgsfield");
});

Deno.test("inactive, non-video and unsupported-provider rows resolve to no provider", () => {
  for (
    const rows of [
      [],
      [row("vercel", { is_active: false })],
      [row("vercel", { capabilities: ["chat"] })],
      [row("vercel", { ai_providers: { provider_code: "vercel", is_active: false } })],
      [row("openai")],
    ]
  ) assertEquals(pickVideoProvider(rows), null);
});

Deno.test("Vercel video inputs accept sane values and reject the rest", () => {
  assertEquals(VercelVideoInput.safeParse({}).success, true);
  assertEquals(VercelVideoInput.safeParse({ duration: 8, aspect_ratio: "16:9", image_url: "https://cdn.test/a.png" }).success, true);
  for (
    const bad of [
      { duration: 0 }, { duration: 61 }, { duration: 2.5 }, { aspect_ratio: "wide" }, { image_url: "http://cdn.test/a.png" },
      { image_url: "not a url" },
    ]
  ) assertEquals(VercelVideoInput.safeParse(bad).success, false, JSON.stringify(bad));
});

// ---------------------------------------------------------------------------
// Admin Video ladder (2026-10-05): used only when the request names no model.
// ---------------------------------------------------------------------------
import { DEFAULT_VIDEO_MODEL_ID, videoModelFromLadder } from "./videoProvider.ts";

const ladder = (rungs: Array<[string, string]>) => ({
  primaryProvider: rungs[0]?.[0] ?? "", primaryModel: rungs[0]?.[1] ?? "",
  fallbackProvider: rungs[1]?.[0] ?? "", fallbackModel: rungs[1]?.[1] ?? "",
  lastResortProvider: rungs[2]?.[0] ?? "", lastResortModel: rungs[2]?.[1] ?? "",
});

Deno.test("the first ladder rung this function can run wins; xAI and MiniMax rungs are skipped", () => {
  assertEquals(
    videoModelFromLadder(ladder([["xai", "grok-imagine-video"], ["higgsfield", "kling_3_0"], ["vercel", "v"]])),
    "kling_3_0",
  );
});

Deno.test("with no runnable rung the previous default stays", () => {
  assertEquals(
    videoModelFromLadder(ladder([["xai", "grok-imagine-video"], ["minimax", "hailuo-2.3-fast"]])),
    DEFAULT_VIDEO_MODEL_ID,
  );
  assertEquals(videoModelFromLadder(ladder([])), DEFAULT_VIDEO_MODEL_ID);
});
