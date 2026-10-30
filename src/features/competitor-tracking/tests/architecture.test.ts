import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The import-boundary gate of the competitor tracking feature.
 *
 * These rules are the ones ARCHITECTURE.md §3, §4, §7, §11 and §22
 * state for a feature module. They are checked here rather than left to
 * review, because the sibling features do the same and the rules are
 * cheap to state and cheap to break.
 */

const FEATURE_ROOT = "src/features/competitor-tracking";

const INFRA_IMPORT =
  /from\s+["'][^"']*infrastructure[^"']*["']|import\(["'][^"']*infrastructure[^"']*["']\)/;

const SUPABASE_CLIENT_IMPORT = /from\s+["']@\/integrations\/supabase\/client["']/;

const SUPABASE_SDK_IMPORT = /from\s+["']@supabase\/supabase-js["']/;

const REACT_IMPORT = /from\s+["'](react|react-dom|react-router|react-router-dom|@tanstack\/react-query)["']/;

const EDGE_FUNCTION_IMPORT = /from\s+["'][^"']*supabase\/functions[^"']*["']/;

const CROSS_FEATURE_IMPORT = /from\s+["']@\/features\/[^"']+["']/;

/**
 * The tokens of a client-side analytics implementation.
 *
 * The server owns the growth, the weekly inventory and the outlier
 * score. A feature module that grew one of them would be a SECOND
 * algorithm, and the two would drift apart silently.
 */
const FORBIDDEN_ANALYTICS: ReadonlyArray<{ token: RegExp; why: string }> = [
  {
    token: /computeOutlierScores|_shared\/outlierScore|outlierScore\.ts/,
    why: "the outlier algorithm belongs to the server",
  },
  {
    token: /minBaseline|minAgeHours|baselineSize\s*[:=]\s*\d/,
    why: "the outlier baseline policy belongs to the server",
  },
  {
    token: /\*\s*100\b|\b100\s*\*/,
    why: "a growth percentage belongs to the server",
  },
];

/**
 * The only files that may wire the infrastructure adapter.
 *
 * Task 5 adds the two composition roots. Until then the list is empty
 * and the rule is vacuously satisfied - it is written so the next task
 * cannot widen the wiring by accident.
 */
const COMPOSITION_ROOTS = ["/ui/CompetitorTrackingScreen.tsx", "/ui/TrackCompetitorControl.tsx"];

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

function normalized(path: string): string {
  return relative(process.cwd(), path).replace(/\\/g, "/");
}

/**
 * The source without its comments.
 *
 * A doc comment that NAMES the canonical server module is not an
 * implementation of it. The gate therefore looks at the code, not at
 * the prose around it.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function filesImportingInfrastructure(files: string[]): string[] {
  return files
    .filter((filePath) => INFRA_IMPORT.test(readFileSync(filePath, "utf8")))
    .map(normalized);
}

describe("competitor-tracking layering", () => {
  it("has the feature folders the architecture requires", () => {
    expect(existsSync(join(FEATURE_ROOT, "domain"))).toBe(true);
    expect(existsSync(join(FEATURE_ROOT, "application"))).toBe(true);
    expect(existsSync(join(FEATURE_ROOT, "infrastructure"))).toBe(true);
    expect(existsSync(join(FEATURE_ROOT, "index.ts"))).toBe(true);
  });

  it("application and domain do not import infrastructure", () => {
    const files = [
      ...collectSourceFiles(join(FEATURE_ROOT, "application")),
      ...collectSourceFiles(join(FEATURE_ROOT, "domain")),
    ];

    expect(files.length).toBeGreaterThan(0);
    expect(filesImportingInfrastructure(files)).toEqual([]);
  });

  it("only infrastructure imports the Supabase client", () => {
    const nonInfraFiles = [
      ...collectSourceFiles(join(FEATURE_ROOT, "domain")),
      ...collectSourceFiles(join(FEATURE_ROOT, "application")),
      ...collectSourceFiles(join(FEATURE_ROOT, "ui")),
    ];

    const supabaseImports = nonInfraFiles.filter(
      (file) =>
        SUPABASE_CLIENT_IMPORT.test(readFileSync(file, "utf8")) ||
        SUPABASE_SDK_IMPORT.test(readFileSync(file, "utf8")),
    );

    expect(supabaseImports.map(normalized)).toEqual([]);
  });

  it("only the designated composition roots wire the infrastructure", () => {
    const uiFiles = collectSourceFiles(join(FEATURE_ROOT, "ui"));
    const offenders = filesImportingInfrastructure(uiFiles).filter(
      (file) => !COMPOSITION_ROOTS.some((root) => file.endsWith(root)),
    );

    expect(offenders).toEqual([]);
  });

  it("keeps React and the query layer out of domain and application", () => {
    const files = [
      ...collectSourceFiles(join(FEATURE_ROOT, "application")),
      ...collectSourceFiles(join(FEATURE_ROOT, "domain")),
    ];

    const reactImporters = files.filter((file) => REACT_IMPORT.test(readFileSync(file, "utf8")));

    expect(reactImporters.map(normalized)).toEqual([]);
  });

  it("does not import another feature's internals", () => {
    const files = [
      ...collectSourceFiles(join(FEATURE_ROOT, "domain")),
      ...collectSourceFiles(join(FEATURE_ROOT, "application")),
      ...collectSourceFiles(join(FEATURE_ROOT, "infrastructure")),
      ...collectSourceFiles(join(FEATURE_ROOT, "ui")),
    ];

    const crossFeature = files.filter((file) =>
      CROSS_FEATURE_IMPORT.test(readFileSync(file, "utf8")),
    );

    expect(crossFeature.map(normalized)).toEqual([]);
  });

  it("does not import the Deno edge functions into the browser bundle", () => {
    const files = [
      ...collectSourceFiles(join(FEATURE_ROOT, "domain")),
      ...collectSourceFiles(join(FEATURE_ROOT, "application")),
      ...collectSourceFiles(join(FEATURE_ROOT, "infrastructure")),
    ];

    const edgeImporters = files.filter((file) =>
      EDGE_FUNCTION_IMPORT.test(readFileSync(file, "utf8")),
    );

    expect(edgeImporters.map(normalized)).toEqual([]);
  });

  it("introduces no client-side growth, weekly or outlier implementation", () => {
    const files = [
      ...collectSourceFiles(join(FEATURE_ROOT, "domain")),
      ...collectSourceFiles(join(FEATURE_ROOT, "application")),
      ...collectSourceFiles(join(FEATURE_ROOT, "infrastructure")),
    ];

    for (const file of files) {
      const source = stripComments(readFileSync(file, "utf8"));
      for (const rule of FORBIDDEN_ANALYTICS) {
        expect(
          rule.token.test(source),
          `${normalized(file)} must not contain a client-side analytics implementation: ${rule.why}`,
        ).toBe(false);
      }
    }
  });

  it("publishes the feature through its public index and not through its internals", () => {
    const index = readFileSync(join(FEATURE_ROOT, "index.ts"), "utf8");

    // The public surface is the domain and the application. The adapter
    // is wired by the composition roots inside the feature, so it is not
    // re-exported to the outside world.
    expect(index).toContain("./domain/contracts");
    expect(index).toContain("./application/ports");
    expect(index).not.toContain("./infrastructure/");
  });
});
