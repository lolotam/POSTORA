import { describe, expect, it } from "vitest";
import { PROCEDURE_FIELDS, PROCEDURE_KEYS, supportsProcedures } from "../procedureTemplates";
import { PROCEDURE_KEYS as EDGE_KEYS, TEMPLATES } from "../../../supabase/functions/_shared/procedures/templates.ts";

describe("procedure template mirror", () => {
  it("lists the same procedures as the edge module", () => {
    expect([...PROCEDURE_KEYS]).toEqual([...EDGE_KEYS]);
  });
  it.each([...PROCEDURE_KEYS])("%s has the same fields as the edge template", (key) => {
    expect(PROCEDURE_FIELDS[key]).toEqual(TEMPLATES[key].fields.map((field) => field.name));
  });
});

describe("supportsProcedures", () => {
  // PR #209 review: the card must not offer flows the reply path never runs.
  it.each([
    ["whatsapp", "both", true],
    ["instagram", "dms", true],
    ["facebook", "comments", false],
    ["threads", "both", false],
    ["youtube", "dms", false],
  ] as const)("%s on %s surface → %s", (platform, surface, expected) => {
    expect(supportsProcedures(platform, surface)).toBe(expected);
  });
});
