#!/usr/bin/env node
/**
 * PreToolUse guard: remind agents to read ARCHITECTURE.md before editing
 * production code.
 *
 * Fires on Edit/Write. If the target path is under src/ or supabase/functions/,
 * prints a reminder to stdout and exits 0 — Claude Code surfaces stdout from a
 * successful PreToolUse hook as additional context (same mechanism the graphify
 * hooks in .claude/settings.json use). Never blocks the edit.
 *
 * Silent for every other path, and silent on malformed input: a doc reminder
 * must never be the reason a tool call fails.
 */

const WATCHED = [/(^|\/)src\//, /(^|\/)supabase\/functions\//];

/**
 * Collects the PreToolUse payload from stdin.
 *
 * Resolves with whatever arrived — never rejects, and never resolves twice —
 * so a stdin problem cannot turn into a failed tool call. Caps the wait at 2s
 * because a stream that is never closed would otherwise hang the Edit/Write
 * this hook is gating; a late reminder is worth less than a blocked edit costs.
 *
 * @returns {Promise<string>} raw payload, or '' if none arrived in time.
 */
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve(data);
      }
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    // Never hang a tool call waiting on stdin that never closes.
    setTimeout(done, 2000).unref();
  });
}

const REMINDER = `📐 ARCHITECTURE.md applies to this file.

Before writing, confirm the change respects:
  • Dependency direction — ui -> application -> domain; domain imports no React,
    no Supabase, no browser APIs; application imports no UI components (§4)
  • Edge Functions are adapters — auth, validate, delegate to a use case,
    sanitize errors. No new provider implementations in index.ts (§12, §13, §41)
  • Identity comes from the Authorization header. Body user_id is untrusted (§14)
  • No raw Supabase queries added to pages or visual components (§11)
  • No secrets, tokens or raw provider errors in logs or responses (§16, §17, §24)
  • One canonical contract — do not add a 4th PlatformMetadata copy (§22)

Dependency rules are review-enforced only — no lint rule catches a violation.

If this change touches supabase/functions/**, editing the file deploys NOTHING.
Redeploy via ssh-contabo-mcp per CLAUDE.md. Never 'npx supabase functions deploy'.`;

const raw = await readStdin();

let filePath = '';
try {
  filePath = JSON.parse(raw)?.tool_input?.file_path ?? '';
} catch {
  process.exit(0);
}

if (typeof filePath !== 'string' || filePath === '') process.exit(0);

const normalized = filePath.replace(/\\/g, '/');
if (WATCHED.some((re) => re.test(normalized))) {
  console.log(REMINDER);
}

process.exit(0);
