import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

// Regression guard for the 2026-08-21 reset-password 500. PostgREST query
// builders (`.rpc()`, `.from().select()`, ...) are `PromiseLike` — they expose
// `then` but NOT `catch`. Calling `.catch()` on one is a synchronous
// TypeError, not a rejection handler. In verify-reset-otp that TypeError fired
// AFTER the password had already been updated, so a successful reset was
// reported to the user as a failure.
//
// Use `try { await builder } catch {}` instead.

const FUNCTIONS_DIR = "supabase/functions";
// The optional `<...>` matches TypeScript type arguments, e.g.
// `.rpc<"cleanup_expired_otps">(...)`, which the builder methods accept.
const BUILDER_CATCH =
  /\.(?:rpc|select|insert|update|upsert|delete|maybeSingle|single)\s*(?:<[^>()]*>)?\s*\([^;]*?\)\s*\.catch\s*\(/s;

function collectFunctionSources(dir: string): string[] {
  const absolute = path.resolve(process.cwd(), dir);
  const found: string[] = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectFunctionSources(child));
    else if (entry.name.endsWith(".ts")) found.push(child);
  }
  return found;
}

it("no edge function calls .catch() on a PostgREST builder", () => {
  const offenders = collectFunctionSources(FUNCTIONS_DIR).filter((file) =>
    BUILDER_CATCH.test(fs.readFileSync(path.resolve(process.cwd(), file), "utf8")),
  );

  if (offenders.length > 0) {
    throw new Error(
      `PostgREST builders are PromiseLike and have no .catch(); wrap in try/await instead. Offenders:\n${offenders.join("\n")}`,
    );
  }
});

it.each([
  ['admin.rpc("cleanup_expired_otps").catch(() => undefined)'],
  ['admin.rpc<"cleanup_expired_otps">("cleanup_expired_otps").catch(() => undefined)'],
])("the guard pattern recognises %s", (source) => {
  expect(BUILDER_CATCH.test(source)).toBe(true);
});

it("the guard pattern ignores a correctly awaited builder", () => {
  expect(BUILDER_CATCH.test('await admin.rpc("cleanup_expired_otps");')).toBe(false);
});
