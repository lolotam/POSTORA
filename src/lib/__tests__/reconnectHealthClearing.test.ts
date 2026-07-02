import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const sources = [
  ["Pinterest", "supabase/functions/pinterest-oauth/index.ts"],
  ["Twitter", "supabase/functions/twitter-oauth/index.ts"],
  ["TikTok", "supabase/functions/tiktok-oauth/index.ts"],
] as const;

function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

function reconnectUpdate(source: string): string {
  const accountMismatchGuard = source.indexOf(
    'throw new Error("RECONNECT_ACCOUNT_MISMATCH")',
  );
  const updateStart = source.indexOf(".update({", accountMismatchGuard);
  const ownershipFilter = source.indexOf('.eq("user_id",', updateStart);
  const updateEnd = source.indexOf(";", ownershipFilter);

  expect(accountMismatchGuard).toBeGreaterThanOrEqual(0);
  expect(updateStart).toBeGreaterThan(accountMismatchGuard);
  expect(ownershipFilter).toBeGreaterThan(updateStart);
  expect(updateEnd).toBeGreaterThan(ownershipFilter);

  return source.slice(updateStart, updateEnd + 1);
}

it.each(sources)(
  "%s reconnect clears health state without creating a duplicate account",
  (_platform, relativePath) => {
    const source = readSource(relativePath);
    const update = reconnectUpdate(source);

    expect(update).toContain("is_active: true");
    expect(update).toContain("needs_reauth: false");
    expect(update).toContain("failure_count: 0");
    expect(update).toContain("last_refresh_error: null");
    expect(update).toContain('.eq("id", row.id)');
    expect(update).toMatch(/\.eq\("user_id",\s*[^)]+\)/);
    expect(source).toContain("RECONNECT_FORBIDDEN");
    expect(source).toContain("RECONNECT_ACCOUNT_MISMATCH");
    expect(source).toContain(
      'onConflict: "user_id,platform,platform_user_id"',
    );
    expect(source).toContain('"reconnected", "1"');
  },
);

it("Twitter reconnect preserves the stored refresh token when none is returned", () => {
  const source = readSource("supabase/functions/twitter-oauth/index.ts");

  expect(reconnectUpdate(source)).not.toContain(
    "refresh_token: refresh_token ?? null",
  );
});
