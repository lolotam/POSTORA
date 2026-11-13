import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// The catalogue is keyed by credential kind: UNIQUE (provider_id, model_id,
// auth_method). The same model_id therefore exists once per auth_method, and a
// reader that does not pin the kind sees two rows for one model.
//
// That is not a cosmetic problem:
//   - `.maybeSingle()` throws "multiple rows returned" (ai-fallback, generate-image)
//   - a plain pick takes an arbitrary row (generate-image catalogue metadata)
//   - a list shows the same model twice (useAIConfiguration, ai-config list)
//
// So every reader of the API-key catalogue must say which credential kind it
// wants. A row addressed by its primary key is already unambiguous and needs no
// kind filter.
const SCAN_ROOTS = ["src", "supabase/functions"];
const READER = /from\(\s*["']ai_models["']\s*\)/g;

function collectSourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(fullPath);
    if (!entry.isFile()) return [];
    if (!/\.tsx?$/.test(entry.name)) return [];
    if (/\.(?:test|spec)\./.test(entry.name)) return [];
    return [fullPath];
  });
}

/**
 * The comments are blanked out, keeping the offsets: a `;` inside a comment is not
 * the end of a query chain. A `//` that follows a `:` is not a comment -- it is
 * the scheme of a URL.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, lead: string) => `${lead}${" ".repeat(match.length - lead.length)}`);
}

/** The query chain that starts at the `from("ai_models")` call. */
function chainAt(source: string, index: number): string {
  const rest = source.slice(index);
  const end = rest.indexOf(";");
  return end === -1 ? rest.slice(0, 1200) : rest.slice(0, end);
}

function unscopedReaders(source: string): string[] {
  const violations: string[] = [];
  const readable = stripComments(source);
  for (const match of readable.matchAll(READER)) {
    const index = match.index ?? 0;
    const chain = chainAt(readable, index);
    const isWrite = /\.(?:insert|upsert)\(/.test(chain);
    const pinnedByKind = isWrite
      ? /\bauth_method\s*[:,]/.test(chain) || /onConflict:\s*["'][^"']*\bauth_method\b/.test(chain)
      : /\.(?:eq|in)\(\s*["']auth_method["']\s*,/.test(chain);
    // A row addressed by its primary key is unambiguous: the key is unique
    // across the credential kinds.
    const pinnedByPrimaryKey = /\.(?:eq|in)\(\s*["']id["']/.test(chain);
    // The admin list intentionally reads every kind, including unknown legacy
    // values. Accept only a query whose own continuation groups those returned
    // rows; an unrelated grouping call elsewhere cannot exempt an unscoped read.
    const groupedByKind = /\.then\(\(\{\s*data\s*,\s*error\s*\}\)\s*=>\s*\(\{\s*\.\.\.groupCatalogueRows\(data\s*\?\?\s*\[\]\)/.test(chain);
    if (!pinnedByKind && !pinnedByPrimaryKey && !groupedByKind) violations.push(chain.split("\n")[0]);
  }
  return violations;
}

describe("ai_models readers pin the credential kind", () => {
  it("every reader scopes by auth_method or addresses the row by id", () => {
    const files = SCAN_ROOTS.flatMap((root) => collectSourceFiles(root));
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const filePath of files) {
      const source = readFileSync(filePath, "utf8");
      for (const chain of unscopedReaders(source)) {
        violations.push(`${relative(process.cwd(), filePath).replace(/\\/g, "/")}: ${chain.trim()}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("the reader list is not empty, so the rule cannot pass vacuously", () => {
    const files = SCAN_ROOTS.flatMap((root) => collectSourceFiles(root));
    const readers = files.filter((filePath) => READER.test(readFileSync(filePath, "utf8")));
    expect(readers.length).toBeGreaterThan(0);
  });
});

// The scanner is the guard, so the guard needs its own controls: it must flag an
// unscoped reader and accept every shape that is already unambiguous.
const UNSCOPED_READER = [
  `const rows = await admin.from("ai_models")`,
  `  .select("model_id")`,
  `  .eq("model_id", "gpt-4o")`,
  `  .maybeSingle();`,
].join("\n");

const SCOPED_READER = [
  `const rows = await admin.from("ai_models")`,
  `  .select("model_id")`,
  `  .eq("auth_method", "api_key")`,
  `  .maybeSingle();`,
].join("\n");

const READER_BY_ID = [
  `await supabase.from("ai_models")`,
  `  .update({ is_active: true })`,
  `  .eq("id", rowId);`,
].join("\n");

const READER_BY_ID_LIST = [
  `await db.from("ai_models")`,
  `  .update({ is_active: false })`,
  `  .in("id", ids);`,
].join("\n");

// A `;` inside a comment is not the end of the chain: the filter that follows it
// still counts. This was a real miss in the first version of the scanner.
const READER_AFTER_A_COMMENT = [
  `await supabase.from("ai_models").insert({`,
  `  provider_id: provider.id,`,
  `  // The catalogue is keyed by credential kind; an admin adds an API-key model.`,
  `  auth_method: "api_key",`,
  `}).select().single();`,
].join("\n");

describe("the ai_models reader scanner", () => {
  const cases: Array<[string, string, number]> = [
    ["an unscoped reader", UNSCOPED_READER, 1],
    ["a selected credential column without a filter", `db.from('ai_models').select('model_id, auth_method').eq('model_id', id).maybeSingle();`, 1],
    ["an update mentioning auth_method without a filter", `db.from('ai_models').update({ auth_method: 'oauth' }).eq('model_id', id);`, 1],
    ["a kind-scoped reader", SCOPED_READER, 0],
    ["an explicit mixed-kind admin list", `db.from('ai_models').select('*').in('auth_method', ['api_key', 'oauth']).order('name');`, 0],
    ["a kind-keyed bulk upsert", `db.from('ai_models').upsert(rows, { onConflict: 'provider_id,model_id,auth_method' });`, 0],
    ["a reader addressed by one id", READER_BY_ID, 0],
    ["a reader addressed by a list of ids", READER_BY_ID_LIST, 0],
    ["a reader whose filter follows a comment", READER_AFTER_A_COMMENT, 0],
    ["an admin list grouping its own rows", `db.from('ai_models').select('*').then(({ data, error }) => ({ ...groupCatalogueRows(data ?? []), error }));`, 0],
    ["an unscoped read with unrelated grouping", `${UNSCOPED_READER}\ngroupCatalogueRows(otherRows);`, 1],
  ];

  it.each(cases)("flags %s", (_label, source, expected) => {
    expect(unscopedReaders(source)).toHaveLength(expected);
  });
});
