import fs from "node:fs";
import path from "node:path";
import { it } from "vitest";

const root = path.resolve(import.meta.dirname, "..", "..", "..");

function read(file: string): string {
  return fs.readFileSync(path.join(root, file), "utf8");
}

it("process-post sends crossreshare_to_ig instead of legacy crosspost_to_instagram", () => {
  const src = read("supabase/functions/process-post/index.ts");
  if (!src.includes('crossreshare_to_ig = "true"'))
    throw new Error("Must send crossreshare_to_ig param to Meta");
  if (src.includes("crosspost_to_instagram"))
    throw new Error("Must not use legacy crosspost_to_instagram param");
});

it("process-post requests crossreshare_to_ig_status in verify fetch", () => {
  const src = read("supabase/functions/process-post/index.ts");
  if (!src.includes("crossreshare_to_ig_status"))
    throw new Error("Must request crossreshare_to_ig_status in verify fields");
});

it("process-post surfaces cross-share IG status in response", () => {
  const src = read("supabase/functions/process-post/index.ts");
  if (!src.includes("crossShareIgStatus"))
    throw new Error("Must track cross-share IG status variable");
  if (!src.includes("status: crossShareIgStatus"))
    throw new Error("Must include status field in cross_share response");
});

it("debug publish check already uses correct crossreshare_to_ig", () => {
  const src = read("supabase/functions/threads-debug-publish-check/index.ts");
  if (!src.includes('crossreshare_to_ig = "true"'))
    throw new Error("Debug check must use correct crossreshare_to_ig param");
  if (src.includes("crosspost_to_instagram"))
    throw new Error("Debug check must not use legacy crosspost_to_instagram param");
});
