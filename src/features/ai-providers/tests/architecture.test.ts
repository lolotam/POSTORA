import { existsSync, readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const FEATURE_ROOT = "src/features/ai-providers";
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

describe("ai-providers layering", () => {
  it("application and domain do not import infrastructure", () => {
    const applicationFiles = collectSourceFiles(join(FEATURE_ROOT, "application"));
    const domainFiles = collectSourceFiles(join(FEATURE_ROOT, "domain"));
    // collectSourceFiles answers [] for a directory that does not exist, so without this the
    // whole rule would pass vacuously the day someone renames application/.
    expect(applicationFiles.length).toBeGreaterThan(0);
    // This slice keeps its domain types in application/ports.ts, per its owned-file contract.

    const files = [...applicationFiles, ...domainFiles];
    expect(filesImportingInfrastructure(files)).toEqual([]);
  });

  // The panel alone constructs the adapter; cards and hooks receive the port.
  it("only AiProvidersPanel in ui/ imports infrastructure", () => {
    const allUiFiles = collectSourceFiles(join(FEATURE_ROOT, "ui"));
    expect(allUiFiles.length).toBeGreaterThan(0);

    const uiFiles = allUiFiles.filter(
      (filePath) => !filePath.replace(/\\/g, "/").endsWith("/ui/AiProvidersPanel.tsx"),
    );
    expect(filesImportingInfrastructure(uiFiles)).toEqual([]);

    // The exemption has to be real, or the rule above is satisfied by nobody wiring the
    // adapter at all -- which is exactly the state this test was written to prevent.
    expect(filesImportingInfrastructure([join(FEATURE_ROOT, "ui", "AiProvidersPanel.tsx")]))
      .toHaveLength(1);
  });
});

// Exercise the same scanner with an actual temporary violating source file.
describe("architecture scanner positive controls", () => {
  it("detects an infrastructure import in a non-composition UI file", () => {
    const directory = mkdtempSync(join(tmpdir(), "ai-providers-architecture-"));
    try {
      const file = join(directory, "AiRoutingCard.tsx");
      writeFileSync(file, 'import { adapter } from "../infrastructure/adapter";');
      expect(filesImportingInfrastructure(collectSourceFiles(directory))).toHaveLength(1);
      writeFileSync(file, 'import type { AiProvidersGateway } from "../application/ports";');
      expect(filesImportingInfrastructure(collectSourceFiles(directory))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("only infrastructure imports the Supabase client", () => {
    const files = [...collectSourceFiles(join(FEATURE_ROOT, "application")), ...collectSourceFiles(join(FEATURE_ROOT, "ui"))];
    expect(files.filter(file => /from\s+["']@\/integrations\/supabase\/client["']/.test(readFileSync(file, "utf8")))).toEqual([]);
  });
});
