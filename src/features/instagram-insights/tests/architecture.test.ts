import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const FEATURE_ROOT = "src/features/instagram-insights";
const INFRA_IMPORT = /from\s+["'][^"']*infrastructure[^"']*["']|import\(["'][^"']*infrastructure[^"']*["']\)/;

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

function filesImportingInfrastructure(files: string[]): string[] {
  return files
    .filter((filePath) => INFRA_IMPORT.test(readFileSync(filePath, "utf8")))
    .map((filePath) => relative(process.cwd(), filePath).replace(/\\/g, "/"));
}

describe("instagram-insights layering", () => {
  it("application and domain do not import infrastructure", () => {
    const applicationFiles = collectSourceFiles(join(FEATURE_ROOT, "application"));
    const domainFiles = collectSourceFiles(join(FEATURE_ROOT, "domain"));

    expect(applicationFiles.length).toBeGreaterThan(0);
    expect(domainFiles.length).toBeGreaterThan(0);

    const files = [...applicationFiles, ...domainFiles];
    expect(filesImportingInfrastructure(files)).toEqual([]);
  });

  it("only InstagramPerformanceScreen in ui/ imports infrastructure for default wiring", () => {
    const allUiFiles = collectSourceFiles(join(FEATURE_ROOT, "ui"));
    expect(allUiFiles.length).toBeGreaterThan(0);

    const nonScreenUiFiles = allUiFiles.filter(
      (filePath) => !filePath.replace(/\\/g, "/").endsWith("/ui/InstagramPerformanceScreen.tsx"),
    );
    expect(filesImportingInfrastructure(nonScreenUiFiles)).toEqual([]);

    expect(
      filesImportingInfrastructure([join(FEATURE_ROOT, "ui", "InstagramPerformanceScreen.tsx")]),
    ).toHaveLength(1);
  });

  it("only infrastructure imports the Supabase client", () => {
    const nonInfraFiles = [
      ...collectSourceFiles(join(FEATURE_ROOT, "domain")),
      ...collectSourceFiles(join(FEATURE_ROOT, "application")),
      ...collectSourceFiles(join(FEATURE_ROOT, "ui")),
    ];
    const supabaseClientImports = nonInfraFiles.filter((file) =>
      /from\s+["']@\/integrations\/supabase\/client["']/.test(readFileSync(file, "utf8")),
    );
    expect(supabaseClientImports).toEqual([]);
  });
});
