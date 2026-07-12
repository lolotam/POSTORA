import { describe, expect, it } from "vitest";
import { normalizeGraphExtraction } from "../../../supabase/functions/ai-knowledge-ingest/graph";
import { buildObsidianNotes } from "../../../supabase/functions/ai-knowledge-ingest/exports";

describe("normalizeGraphExtraction", () => {
  it("keeps capped unique entities and relations between extracted entities", () => {
    const graph = normalizeGraphExtraction({
      entities: [
        { name: "Starter Plan", type: "plan", description: "Entry plan" },
        { name: "starter plan", type: "plan", description: "Duplicate" },
        { name: "Analytics", type: "feature", description: "Reports" },
      ],
      relations: [
        { source: "Starter Plan", target: "Analytics", relation: "includes" },
        { source: "Starter Plan", target: "Unknown", relation: "includes" },
      ],
    });

    expect(graph.entities).toEqual([
      { name: "Starter Plan", type: "plan", description: "Entry plan" },
      { name: "Analytics", type: "feature", description: "Reports" },
    ]);
    expect(graph.relations).toEqual([
      { source: "Starter Plan", target: "Analytics", relation: "includes" },
    ]);
  });
});

describe("buildObsidianNotes", () => {
  it("links related entities with Obsidian wikilinks", () => {
    const notes = buildObsidianNotes(
      [{ id: "plan", name: "Starter Plan", type: "plan", description: "Entry plan" }, {
        id: "analytics",
        name: "Analytics",
        type: "feature",
        description: "Reports",
      }],
      [{ source_entity_id: "plan", target_entity_id: "analytics", relation: "includes" }],
    );

    expect(notes.get("Starter Plan.md")).toContain("- includes [[Analytics]]");
  });
});
