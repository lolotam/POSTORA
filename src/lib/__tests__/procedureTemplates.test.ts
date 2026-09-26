import { describe, expect, it } from "vitest";
import { PROCEDURE_FIELDS, PROCEDURE_KEYS } from "../procedureTemplates";
import { PROCEDURE_KEYS as EDGE_KEYS, TEMPLATES } from "../../../supabase/functions/_shared/procedures/templates.ts";

describe("procedure template mirror", () => {
  it("lists the same procedures as the edge module", () => {
    expect([...PROCEDURE_KEYS]).toEqual([...EDGE_KEYS]);
  });
  it.each([...PROCEDURE_KEYS])("%s has the same fields as the edge template", (key) => {
    expect(PROCEDURE_FIELDS[key]).toEqual(TEMPLATES[key].fields.map((field) => field.name));
  });
});
