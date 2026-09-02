// deno-lint-ignore-file no-import-prefix
import { assertEquals, assertMatch } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildContext,
  buildLlmsTxt,
  CONTEXT_PATH,
  LLMS_PATH,
  PAGE_ORDER,
  parseRoutes,
  readInputs,
  RULES,
} from "./generate-agent-context.ts";

// ---------------------------------------------------------------------------
// The hand-off bundle is DERIVED: from the developer pages, the route table,
// the policy tables and the contract. These tests are what keep it that way —
// a committed bundle that is not what the generator produces is a bundle a
// partner's agent will implement against and be wrong.
// ---------------------------------------------------------------------------

const REGEN = "run `deno run --allow-read --allow-write scripts/generate-agent-context.ts` and commit the result";

/** A Windows checkout under autocrlf hands back CRLF; the comparison is on content. */
async function committed(url: URL): Promise<string> {
  return (await Deno.readTextFile(url)).replaceAll("\r\n", "\n");
}

Deno.test("the committed AGENT-CONTEXT.md is byte-identical to what the generator produces", async () => {
  const inputs = await readInputs();
  assertEquals(await committed(CONTEXT_PATH), buildContext(inputs), REGEN);
});

Deno.test("the committed llms.txt is byte-identical to what the generator produces", async () => {
  const inputs = await readInputs();
  assertEquals(await committed(LLMS_PATH), buildLlmsTxt(inputs), REGEN);
});

Deno.test("every developer page is in the bundle, once, in reading order, with the rules first", async () => {
  const inputs = await readInputs();
  const context = buildContext(inputs);
  const markers = PAGE_ORDER.map((name) => context.indexOf(`<!-- docs/developer/${name} -->`));
  for (const [i, at] of markers.entries()) {
    assertEquals(at > -1, true, `${PAGE_ORDER[i]} is missing from the bundle`);
    if (i > 0) assertEquals(at > markers[i - 1], true, `${PAGE_ORDER[i]} is out of reading order`);
  }
  const rulesAt = context.indexOf("## Rules and traps for the implementing agent");
  assertEquals(rulesAt > -1 && rulesAt < markers[0], true, "the rules must come before every page");
  // Exactly one H1, so an agent sees one document rather than 24.
  assertEquals(context.match(/^# /gm)?.length, 1);
});

Deno.test("every served /v1 route appears in the endpoint table, and nothing else does", async () => {
  const inputs = await readInputs();
  const context = buildContext(inputs);
  const served = parseRoutes(inputs.routerSource);
  assertEquals(served.length >= 20, true, "the route sweep found suspiciously few routes");
  const table = context.slice(context.indexOf("## Endpoints"), context.indexOf("## Error codes"));
  const rows = table.split("\n").filter((l) => l.startsWith("| `"));
  assertEquals(rows.length, served.length);
  for (const r of served) {
    assertMatch(table, new RegExp(`\\| \`${r.method}\` \\| \`${r.path.replace(/[{}]/g, "\\$&")}\` \\|`));
  }
});

Deno.test("the rules name the traps the bundle exists for", () => {
  for (const must of [
    "Idempotency-Key",
    "retryable",
    "idempotency_indeterminate",
    "X-Postora-Signature",
    "raw",
    "X-Postora-Event-Id",
    "resource_not_found",
    "never 403",
  ]) {
    assertEquals(RULES.includes(must), true, `rules no longer mention ${must}`);
  }
});

Deno.test("no real-looking credential, phone or workspace id in the bundle", async () => {
  const inputs = await readInputs();
  const context = buildContext(inputs) + buildLlmsTxt(inputs);
  assertEquals(/pk_(live|test)_[0-9A-Za-z]{20,}/.test(context), false, "a real-looking key");
  assertEquals(/whsec_[0-9A-Za-z]{20,}/.test(context), false, "a real-looking webhook secret");
  // The one sanctioned phone placeholder family.
  const phones = context.match(/\+\d{10,15}/g) ?? [];
  assertEquals(phones.every((p) => p.startsWith("+1555")), true, `unexpected phone number(s): ${phones.join(", ")}`);
});
