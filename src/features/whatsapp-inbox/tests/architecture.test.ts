import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const FEATURE_ROOT = "src/features/whatsapp-inbox";
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

describe("whatsapp-inbox layering", () => {
  it("application and domain do not import infrastructure", () => {
    const applicationFiles = collectSourceFiles(join(FEATURE_ROOT, "application"));
    const domainFiles = collectSourceFiles(join(FEATURE_ROOT, "domain"));
    // collectSourceFiles answers [] for a directory that does not exist, so without this the
    // whole rule would pass vacuously the day someone renames application/ or domain/.
    expect(applicationFiles.length).toBeGreaterThan(0);
    expect(domainFiles.length).toBeGreaterThan(0);

    const files = [...applicationFiles, ...domainFiles];
    expect(filesImportingInfrastructure(files)).toEqual([]);
  });

  // Regression, 2026-08-25: the composition root is the only UI file allowed to
  // construct the adapter. A second import of infrastructure from a bubble or
  // composer reintroduces the layering hole this task exists to close.
  it("only WhatsAppInboxScreen in ui/ imports infrastructure", () => {
    const allUiFiles = collectSourceFiles(join(FEATURE_ROOT, "ui"));
    expect(allUiFiles.length).toBeGreaterThan(0);

    const uiFiles = allUiFiles.filter(
      (filePath) => !filePath.replace(/\\/g, "/").endsWith("/ui/WhatsAppInboxScreen.tsx"),
    );
    expect(filesImportingInfrastructure(uiFiles)).toEqual([]);

    // The exemption has to be real, or the rule above is satisfied by nobody wiring the
    // adapter at all -- which is exactly the state this test was written to prevent.
    expect(filesImportingInfrastructure([join(FEATURE_ROOT, "ui", "WhatsAppInboxScreen.tsx")]))
      .toHaveLength(1);
  });
});
