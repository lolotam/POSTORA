import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = "src/features/youtube-analytics";
const INFRA_IMPORT = /from\s+["'][^"']*infrastructure[^"']*["']|import\(["'][^"']*infrastructure[^"']*["']\)/;
const SUPABASE_IMPORT = /@\/integrations\/supabase\/client/;
const DEEP_FEATURE_IMPORT = /@\/features\/[^/"']+\/(?:domain|application|infrastructure|ui)\//;

function sources(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name) ? [path] : [];
  });
}

function importing(files: string[], pattern: RegExp): string[] {
  return files.filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => relative(process.cwd(), file).replace(/\\/g, "/"));
}

describe("youtube-analytics dependency direction", () => {
  it("domain and application never import infrastructure or Supabase", () => {
    const files = [...sources(join(ROOT, "domain")), ...sources(join(ROOT, "application"))];
    expect(files.length).toBeGreaterThan(0);
    expect(importing(files, INFRA_IMPORT)).toEqual([]);
    expect(importing(files, SUPABASE_IMPORT)).toEqual([]);
  });

  it("only the composition root imports infrastructure for default wiring", () => {
    const uiFiles = sources(join(ROOT, "ui"));
    expect(importing(uiFiles, INFRA_IMPORT)).toEqual(["src/features/youtube-analytics/ui/YouTubeAnalyticsScreen.tsx"]);
    expect(importing(uiFiles, SUPABASE_IMPORT)).toEqual([]);
  });

  it("only infrastructure imports the Supabase client and no file deep-imports another feature's internals", () => {
    const infrastructure = importing(sources(join(ROOT, "infrastructure")), SUPABASE_IMPORT);
    expect(infrastructure).toEqual(["src/features/youtube-analytics/infrastructure/supabaseYouTubeAnalyticsGateway.ts"]);
    expect(importing(sources(ROOT), DEEP_FEATURE_IMPORT)).toEqual([]);
  });
});
