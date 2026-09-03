import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PARTNER_SCOPES } from "../partnerScopes";

// The same parity check the Deno suite runs (partnerScopes.test.ts): the
// mintable list must equal docs/api/openapi.yaml GenericScope, so the form
// can never offer a scope the API does not enforce, or miss one it does.
// Layout in the file (verified 2026-09-02): `    GenericScope:` … `      enum:` followed by
// one `        - <scope>` line per value, ended by the next non-list line.
function genericScopesFromOpenApi(): string[] {
  const lines = readFileSync(resolve(process.cwd(), "docs/api/openapi.yaml"), "utf8").split(/\r?\n/);
  const schemaAt = lines.findIndex((l) => /^\s*GenericScope:\s*$/.test(l));
  const enumAt = lines.findIndex((l, i) => i > schemaAt && /^\s*enum:\s*$/.test(l));
  if (schemaAt < 0 || enumAt < 0) throw new Error("GenericScope enum not found in docs/api/openapi.yaml");
  const values: string[] = [];
  for (let i = enumAt + 1; i < lines.length; i++) {
    const m = /^\s+-\s+['"]?([^'"\s]+)['"]?\s*$/.exec(lines[i]);
    if (!m) break;
    values.push(m[1]);
  }
  return values;
}

describe("PARTNER_SCOPES", () => {
  it("equals the published GenericScope vocabulary", () => {
    expect([...PARTNER_SCOPES.map((s) => s.value)].sort()).toEqual(genericScopesFromOpenApi().sort());
  });
  it("never offers a legacy whatsapp:* scope", () => {
    expect(PARTNER_SCOPES.some((s) => s.value.startsWith("whatsapp:"))).toBe(false);
  });
  it("describes every scope", () => {
    for (const s of PARTNER_SCOPES) expect(s.description.length).toBeGreaterThan(0);
  });
});
