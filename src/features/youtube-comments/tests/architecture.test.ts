import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FEATURE_ROOT = "src/features/youtube-comments";

function allFiles(dir: string): string[] {
  const fs = require("node:fs");
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allFiles(full));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const INFRA_IMPORT = /from\s+["'][^"']*infrastructure[^"']*["']|import\(["'][^"']*infrastructure[^"']*["']\)/;

describe("youtube-comments layering", () => {
  it("application and domain do not import infrastructure", () => {
    const files = allFiles(join(FEATURE_ROOT, "application")).concat(allFiles(join(FEATURE_ROOT, "domain")));
    const offenders = files.filter((f) => INFRA_IMPORT.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
  it("only YouTubeCommentsScreen in ui/ imports infrastructure for default wiring", () => {
    const uiFiles = allFiles(join(FEATURE_ROOT, "ui"));
    const nonScreen = uiFiles.filter((f) => !f.replace(/\\/g, "/").endsWith("/ui/YouTubeCommentsScreen.tsx"));
    const offenders = nonScreen.filter((f) => INFRA_IMPORT.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
  it("only infrastructure imports the Supabase client", () => {
    const all = allFiles(FEATURE_ROOT);
    const nonInfra = all.filter((f) => !f.replace(/\\/g, "/").includes("/infrastructure/"));
    const offenders = nonInfra.filter((f) =>
      /from\s+["']@\/integrations\/supabase\/client["']/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
