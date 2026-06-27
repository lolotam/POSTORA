import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * Regression guard for the Threads → Instagram Story cross-share bug.
 *
 * Meta's Threads Graph API uses the parameter name `crossreshare_to_ig`
 * (their spelling — verified against
 * https://developers.facebook.com/docs/threads/reference/publishing/ and
 * meta-mcp PR #152). The previous name `crosspost_to_instagram` was silently
 * ignored by Meta: the Thread published successfully but the IG Story was
 * never created.
 *
 * This test fails if anyone reintroduces the wrong parameter name in the
 * Threads publish path.
 */
describe("Threads cross-share parameter name", () => {
  const src = readFileSync(
    join(process.cwd(), "supabase/functions/process-post/index.ts"),
    "utf8"
  );

  it("uses Meta's crossreshare_to_ig parameter name", () => {
    expect(src).toMatch(/containerParams\.crossreshare_to_ig\s*=\s*"true"/);
    expect(src).toMatch(/containerParams\.crossreshare_to_ig_dark_mode\s*=\s*"true"/);
  });

  it("does not use the legacy crosspost_to_instagram parameter (Meta silently ignores it)", () => {
    expect(src).not.toMatch(/containerParams\.crosspost_to_instagram/);
    expect(src).not.toMatch(/["']crosspost_to_instagram["']/);
  });

  it("requests crossreshare_to_ig_status on the post-publish verify fetch", () => {
    expect(src).toMatch(/crossreshare_to_ig_status/);
  });
});
