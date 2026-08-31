// D8 regression detector (Partner API programme, Phase 0 deliverable 0.11).
//
// DETECTION BOUNDARY, STATED FIRST BECAUSE IT IS THE MOST IMPORTANT THING HERE.
//
// This is a REGEX HEURISTIC over source text, not containment. It catches the
// canonical spelling of legacy-key authentication and nothing more. An
// adversarial review enumerated what evades it, and the list is not short:
// a table name held in a constant, `.filter()` or `.match()` instead of
// `.eq()`, the query moved into a helper, a wrapper split across more than the
// window it scans, an RPC or raw SQL path, or a migration-defined function.
// It also has false positives: a comment mentioning both terms, or two
// unrelated builders close together.
//
// So: a NEW surface written in the obvious way is caught. A new surface
// written any other way is not. Calling that "containment" would create an
// assurance stronger than the code -- which is worse than having no check,
// because it invites people to stop looking. It is a tripwire on the most
// likely mistake, and it is worth having on exactly those terms.
//
// Real containment needs the legacy path centralised behind one deprecated
// module with AST-level checks on imports and calls, plus a separate scan of
// SQL migrations and RPCs. That is a larger piece of work; it belongs with the
// credential lifecycle (1.3) or later, and is recorded here so nobody mistakes
// this file for it.
//
// WHAT THIS PROTECTS. Postora has two unrelated API-key systems (spec
// POSTORA-PARTNER-API-SPEC-v1.md, decision D8):
//
//   profiles.api_key   — plaintext UUID on the profiles table, NO scopes: it
//                        grants full user authority to whoever holds it.
//   partner_api_keys   — SHA-256 hash at rest, scoped, workspace-pinned,
//                        revocable, rate-limited, quota'd.
//
// D8's containment rule is binding on v1: NO NEW SURFACE may authenticate with
// `profiles.api_key`; every new integration point uses Partner API keys.
// Until this file existed that rule lived only in the risk register, so nothing
// could fail because of it — a rule with no enforcement hook is how the weaker
// credential outlives its own deprecation.
//
// HOW IT ENFORCES. Any non-test .ts file under supabase/functions/** that
// queries `profiles` filtered by `api_key` (the authenticate-by-legacy-key
// shape) fails this test unless it is on the explicit allowlist below. The
// allowlist is exactly the set of surfaces that already authenticated this way
// when D8 was recorded (2026-08-30), found by grepping the tree — five files,
// not the two the plan named by example. A check that fired on day one would be
// a check someone deletes on day two, so legacy surfaces are grandfathered,
// not flagged.
//
// The allowlist is allowed to SHRINK (a surface migrates off the legacy key —
// progress; delete its line). It must only GROW after a recorded decision
// accepts a genuinely new legacy-key surface — never to silence a Partner API
// violation. The second test in this file fails if an allowlisted path stops
// existing, so the list cannot silently outlive its files and green-light a
// recreated same-named path.
//
// NOTE on mcp/index.ts: it reads `profiles.api_key` (by user id, after
// authenticating an mcp_oauth_tokens bearer) and forwards it to n8n-api. It is
// deliberately NOT allowlisted because it does not authenticate the incoming
// request WITH the key — it does not match the from(profiles).eq(api_key)
// shape, and that is the distinction D8 draws.
//
// This test runs in the existing `edge-functions` CI job (.github/workflows/
// test.yml), which already executes `deno test --allow-read … supabase/functions/`
// on every push and PR. If the partner-api directory is ever reorganized, MOVE
// this file with the programme that owns D8 — do not delete it.

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { walkSync } from "https://deno.land/std@0.208.0/fs/walk.ts";
import { fromFileUrl, join, relative } from "https://deno.land/std@0.208.0/path/mod.ts";

/** Functions directory: one level up from this file, whatever the cwd is. */
const FUNCTIONS_DIR = fromFileUrl(new URL("../", import.meta.url));

/** The only surfaces permitted to authenticate with profiles.api_key.
 * See the file header before adding anything to this list. */
const LEGACY_PROFILES_KEY_USERS = new Set([
  "ecommerce-whatsapp-api/index.ts",
  "n8n-api/index.ts",
  "remove-background/index.ts",
  "upscale-image/index.ts",
  "upscale-image-atlas/index.ts",
]);

/** The authenticate-by-legacy-key shape: a query on `profiles` whose filter is
 * `api_key`. Window of 400 chars covers the multi-line supabase-js chains in
 * this repo (from → select → eq) without matching an unrelated `.eq("api_key")`
 * on some other table elsewhere in a large file. */
const PROFILES_API_KEY_AUTH =
  /\.from\(\s*(['"])profiles\1\s*\)[\s\S]{0,400}?\.eq\(\s*(['"])api_key\2/;

function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}

Deno.test("D8 containment: no new surface authenticates with profiles.api_key", () => {
  const violations: string[] = [];

  for (
    const entry of walkSync(FUNCTIONS_DIR, {
      includeDirs: false,
      exts: ["ts"],
      skip: [/node_modules/, /\.git/],
    })
  ) {
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith("_test.ts")) continue;

    const text = Deno.readTextFileSync(entry.path);
    const match = PROFILES_API_KEY_AUTH.exec(text);
    if (!match) continue;

    const rel = toPosix(relative(FUNCTIONS_DIR, entry.path));
    if (LEGACY_PROFILES_KEY_USERS.has(rel)) continue;

    const line = text.slice(0, match.index).split("\n").length;
    violations.push(`${rel}:${line}`);
  }

  assertEquals(
    violations,
    [],
    `D8 violation: new profiles.api_key authentication found in: ${
      violations.join(", ")
    }\n  profiles.api_key is the weaker legacy credential (plaintext at rest, no scopes,\n` +
      `  full user authority). New surfaces must authenticate with partner_api_keys\n` +
      `  (_shared/partnerApiKeys.ts). See spec decision D8 and\n` +
      `  docs/decisions/2026-08-30-partner-api-threat-review.md. To add a genuinely\n` +
      `  new LEGACY-key surface, record that decision first, then extend\n` +
      `  LEGACY_PROFILES_KEY_USERS in this file — never to silence this failure.`,
  );
});

Deno.test("D8 containment: the legacy allowlist names only files that exist", () => {
  const stale: string[] = [];
  for (const rel of LEGACY_PROFILES_KEY_USERS) {
    try {
      Deno.statSync(join(FUNCTIONS_DIR, rel));
    } catch {
      stale.push(rel);
    }
  }
  assertEquals(
    stale,
    [],
    `Stale allowlist entries (file no longer exists): ${stale.join(", ")}\n` +
      `  Delete them from LEGACY_PROFILES_KEY_USERS so the list cannot silently\n` +
      `  permit a recreated path at the same name.`,
  );
});
