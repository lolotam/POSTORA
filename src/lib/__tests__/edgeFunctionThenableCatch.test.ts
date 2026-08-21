import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Regression guard for the 2026-08-21 reset-password 500. PostgREST query
// builders (`.rpc()`, `.from().select()`, ...) are `PromiseLike` — they expose
// `then` but NOT `catch`. Calling `.catch()` on one is a synchronous
// TypeError, not a rejection handler. In verify-reset-otp that TypeError fired
// AFTER the password had already been updated, so a successful reset was
// reported to the user as a failure.
//
// Use `try { await builder } catch {}` instead.

const FUNCTIONS_DIR = "supabase/functions";

const BUILDER_METHODS = new Set([
  "rpc",
  "select",
  "insert",
  "update",
  "upsert",
  "delete",
  "maybeSingle",
  "single",
]);

/**
 * True when `expression` resolves to a raw PostgREST builder, e.g. `admin.rpc("f")`
 * or `admin.from("t").select("*").eq("a", 1)` — the chain is walked because
 * `.catch()` is usually attached after filter methods like `.eq()`.
 *
 * Walking stops at `.then()`: PostgrestBuilder.then() executes the request and
 * returns a real Promise, so `.insert(...).then(...).catch(...)` is safe and must
 * not be reported.
 */
function chainCallsBuilderMethod(expression: ts.Expression): boolean {
  let current: ts.Node = expression;
  while (true) {
    if (ts.isCallExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isPropertyAccessExpression(current)) {
      if (current.name.text === "then") return false;
      if (BUILDER_METHODS.has(current.name.text)) return true;
      current = current.expression;
      continue;
    }
    if (ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    return false;
  }
}

/** Line numbers of every `.catch()` invoked on a PostgREST builder chain. */
function findBuilderCatches(source: string): number[] {
  const sourceFile = ts.createSourceFile(
    "source.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const hits: number[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "catch" &&
      chainCallsBuilderMethod(node.expression.expression)
    ) {
      hits.push(sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return hits;
}

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
  const offenders = collectFunctionSources(FUNCTIONS_DIR).flatMap((file) =>
    findBuilderCatches(
      fs.readFileSync(path.resolve(process.cwd(), file), "utf8"),
    ).map((line) => `${file}:${line}`),
  );

  if (offenders.length > 0) {
    throw new Error(
      `PostgREST builders are PromiseLike and have no .catch(); wrap in try/await instead. Offenders:\n${offenders.join("\n")}`,
    );
  }
});

describe("findBuilderCatches", () => {
  it.each([
    ['admin.rpc("cleanup_expired_otps").catch(() => undefined);'],
    ['admin.rpc<"cleanup_expired_otps">("cleanup_expired_otps").catch(() => undefined);'],
    ['admin.from("t").select("*").eq("a", 1).catch(() => undefined);'],
    // A semicolon inside a string literal used to end the old regex's scan early.
    ['admin.insert({ body: "a;b" }).catch(() => undefined);'],
  ])("detects %s", (source) => {
    expect(findBuilderCatches(source)).toHaveLength(1);
  });

  it.each([
    ['await admin.rpc("cleanup_expired_otps");'],
    // Statement boundaries relied on `;`, so an ASI-separated unrelated .catch()
    // used to match the preceding builder call.
    ['const rows = admin.select("*")\nfetchSomething().catch(() => undefined)'],
    ['fetch(url).catch(() => undefined);'],
    // .then() executes the builder and returns a real Promise, so its .catch()
    // is genuine. Two webhook functions rely on this and must not be reported.
    ['admin.from("t").insert({ a: 1 }).then(() => {}).catch(() => undefined);'],
  ])("ignores %s", (source) => {
    expect(findBuilderCatches(source)).toHaveLength(0);
  });
});
