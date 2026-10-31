#!/usr/bin/env node
/**
 * SessionStart hook: turn on the ultracave voice for every session in this repo.
 *
 * Reads .claude/hooks/caveman/ultracave.md (vendored from
 * github.com/JuliusBrussee/caveman, Apache-2.0), drops its frontmatter, and
 * hands the body to Claude Code as SessionStart additional context. The skill
 * lives here rather than in .claude/skills/ because only settings.json and
 * hooks/ are shared in this repo (see .gitignore).
 *
 * Opt out for one session: CAVEMAN_DEFAULT_MODE=off. In chat, "stop caveman"
 * or "normal mode" switches it off, as the skill says.
 *
 * Silent on any failure: a missing skill file must never break session start.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_PATH = join(dirname(fileURLToPath(import.meta.url)), "caveman", "ultracave.md");

/** Returns the skill text without its leading `---` frontmatter block. */
function stripFrontmatter(text) {
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  return match ? text.slice(match[0].length) : text;
}

function main() {
  if ((process.env.CAVEMAN_DEFAULT_MODE ?? "").trim().toLowerCase() === "off") return;

  let body;
  try {
    body = stripFrontmatter(readFileSync(SKILL_PATH, "utf8")).trim();
  } catch {
    return;
  }
  if (!body) return;

  const context = [
    "Caveman mode: ultracave (on by default in this repo).",
    "Follow these rules for every chat reply until the user says \"stop caveman\" or \"normal mode\".",
    "They govern chat prose only: CLAUDE.md workflow steps, commits, PRs, docs and memory stay in plain full sentences.",
    "",
    body,
  ].join("\n");

  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }),
  );
}

main();
