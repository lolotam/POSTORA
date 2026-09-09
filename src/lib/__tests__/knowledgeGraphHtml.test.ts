// Executes the generated export rather than reading it: `deno check` cannot see
// inside a returned string, and knowledgeGraph.test.ts covers only the Obsidian
// notes -- so without running the HTML, a completely broken graph passes every
// other gate.
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { buildGraphHtml } from "../../../supabase/functions/ai-knowledge-ingest/exports";

const ENTITIES = [
  { id: "a", name: "Alpha", type: "product", description: "first" },
  { id: "b", name: "Beta", type: "person", description: "second" },
  { id: "c", name: "Gamma", type: "product", description: "third" },
];
const RELATIONS = [
  { source_entity_id: "a", target_entity_id: "b", relation: "sells to" },
  { source_entity_id: "b", target_entity_id: "c", relation: "knows" },
  { source_entity_id: "a", target_entity_id: "ghost", relation: "dangling" },
];

function render(entities: typeof ENTITIES, relations: typeof RELATIONS) {
  const dom = new JSDOM(buildGraphHtml(entities, relations), {
    runScripts: "dangerously",
  });
  return dom.window.document;
}

describe("buildGraphHtml executed", () => {
  it("draws an edge per resolvable relation and skips phantoms", () => {
    const doc = render(ENTITIES, RELATIONS);
    const edges = doc.querySelectorAll("line.edge");
    expect(edges.length).toBe(2);
    expect(doc.querySelectorAll("g[data-entity-id]").length).toBe(3);
  });

  it("renders a hostile entity name as inert text", () => {
    const hostile = [
      { id: "x", name: "</script><script>globalThis.PWNED=1</script>", type: "t", description: "d" },
      { id: "y", name: "<img src=x onerror=alert(1)>", type: "t", description: "d" },
    ];
    const dom = new JSDOM(buildGraphHtml(hostile, []), { runScripts: "dangerously" });
    expect((dom.window as unknown as { PWNED?: number }).PWNED).toBeUndefined();
    expect(dom.window.document.querySelectorAll("img").length).toBe(0);
    const labels = [...dom.window.document.querySelectorAll("text.node-label")].map((n) => n.textContent);
    expect(labels).toContain("</script><script>globalThis.PWNED=1</script>");
  });

  it("filtering leaves no dangling edge", () => {
    const dom = new JSDOM(buildGraphHtml(ENTITIES, RELATIONS), { runScripts: "dangerously" });
    const doc = dom.window.document;
    const input = doc.getElementById("filter") as HTMLInputElement;
    input.value = "alpha";
    input.dispatchEvent(new dom.window.Event("input"));
    const visibleNodes = [...doc.querySelectorAll("g[data-entity-id]")].filter(
      (n) => n.getAttribute("display") !== "none",
    );
    const visibleEdges = [...doc.querySelectorAll("line.edge")].filter(
      (n) => n.getAttribute("display") !== "none",
    );
    expect(visibleNodes.length).toBe(1);
    expect(visibleEdges.length).toBe(0);
  });

  it("states an empty state and never references a remote resource", () => {
    const html = buildGraphHtml([], []);
    expect(html).toContain("There is nothing to show.");
    expect(html).not.toMatch(/https?:\/\//);
    expect(buildGraphHtml(ENTITIES, RELATIONS)).not.toMatch(/https?:\/\//);
  });

  it("keeps the highest-degree entities at the cap and drops their orphaned edges", () => {
    // 101 entities, so 21 are cut. "Zulu" sorts near-last by name but has the
    // most relations, so degree must carry it past entities that beat it
    // alphabetically. "Zzz Orphan" has no relations and sorts last, so the
    // name tie-break must drop it. Without relations every degree is 0 and the
    // primary sort key is never exercised at all.
    const many = Array.from({ length: 99 }, (_, i) => ({
      id: `e${i}`,
      name: `Entity ${String(i).padStart(3, "0")}`,
      type: "t",
      description: "d",
    }));
    const hub = { id: "hub", name: "Zulu", type: "t", description: "d" };
    const orphan = { id: "orphan", name: "Zzz Orphan", type: "t", description: "d" };
    // The hub links to the last 30 entities, which are the ones the cap cuts.
    const links = many.slice(-30).map((entity) => ({
      source_entity_id: "hub",
      target_entity_id: entity.id,
      relation: "links",
    }));

    const dom = new JSDOM(buildGraphHtml([orphan, ...many, hub], links), {
      runScripts: "dangerously",
    });
    const doc = dom.window.document;
    const labels = [...doc.querySelectorAll("text.node-label")].map((n) => n.textContent);

    expect(labels).toContain("Zulu");
    expect(labels).not.toContain("Zzz Orphan");
    expect(doc.querySelectorAll("g[data-entity-id]").length).toBe(80);

    // Every drawn edge ends at a node that survived the cap.
    const retained = new Set(
      [...doc.querySelectorAll("g[data-entity-id]")].map((n) => n.getAttribute("data-entity-id")),
    );
    for (const line of doc.querySelectorAll("line.edge")) {
      expect(retained.has(line.getAttribute("data-source"))).toBe(true);
      expect(retained.has(line.getAttribute("data-target"))).toBe(true);
    }
  });

  it("caps the payload and says how many were omitted", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      id: `e${i}`,
      name: `Entity ${i}`,
      type: "t",
      description: "x".repeat(500),
    }));
    const html = buildGraphHtml(many, []);
    expect(html).toContain("20 entities omitted");
    expect(html).not.toContain("x".repeat(300));
  });
});

describe("node detail", () => {
  it("exposes type and description as a hover title, escaped", () => {
    const dom = new JSDOM(
      buildGraphHtml(
        [{ id: "a", name: "Alpha", type: "product", description: "<b>bold</b> & sharp" }],
        [],
      ),
      { runScripts: "dangerously" },
    );
    const titles = [...dom.window.document.querySelectorAll("g[data-entity-id] title")];
    expect(titles).toHaveLength(1);
    expect(titles[0].textContent).toBe("product -- <b>bold</b> & sharp");
    expect(dom.window.document.querySelectorAll("b").length).toBe(0);
  });
});
