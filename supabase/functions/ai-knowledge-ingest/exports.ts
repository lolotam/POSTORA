export interface ExportEntity {
  id: string;
  name: string;
  type: string;
  description: string;
}

export interface ExportRelation {
  source_entity_id: string;
  target_entity_id: string;
  relation: string;
}

function noteName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "-").trim() || "Untitled";
}

export function buildObsidianNotes(
  entities: ExportEntity[],
  relations: ExportRelation[],
): Map<string, string> {
  const entitiesById = new Map(entities.map((entity) => [entity.id, entity]));
  const notes = new Map<string, string>();
  for (const entity of entities) {
    const links = relations.flatMap((relation) => {
      const otherId = relation.source_entity_id === entity.id
        ? relation.target_entity_id
        : relation.target_entity_id === entity.id
          ? relation.source_entity_id
          : null;
      const other = otherId ? entitiesById.get(otherId) : null;
      return other ? [`- ${relation.relation} [[${noteName(other.name)}]]`] : [];
    });
    notes.set(`${noteName(entity.name)}.md`, [
      `# ${entity.name}`,
      "",
      `Type: ${entity.type}`,
      "",
      entity.description,
      "",
      "## Relations",
      links.length ? links.join("\n") : "- None",
    ].join("\n"));
  }
  return notes;
}

export function buildGraphHtml(entities: ExportEntity[], relations: ExportRelation[]): string {
  const graph = JSON.stringify({ entities, relations }).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Knowledge graph</title><style>body{font:15px system-ui;margin:2rem;background:#101827;color:#e5e7eb}.node{border:1px solid #475569;border-radius:.5rem;padding:.75rem;margin:.5rem;display:inline-block}.edge{color:#94a3b8}</style></head><body><h1>Knowledge graph</h1><input id="filter" placeholder="Filter entities"><div id="graph"></div><script>const graph=${graph};const root=document.querySelector('#graph');const filter=document.querySelector('#filter');const esc=text=>String(text).replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));function render(){const q=filter.value.toLowerCase();root.innerHTML=graph.entities.filter(e=>e.name.toLowerCase().includes(q)).map(e=>'<article class="node"><strong>'+esc(e.name)+'</strong><br><small>'+esc(e.type)+'</small><p>'+esc(e.description)+'</p>'+graph.relations.filter(r=>r.source_entity_id===e.id||r.target_entity_id===e.id).map(r=>'<span class="edge">'+esc(r.relation)+'</span>').join('<br>')+'</article>').join('')||'<p>No matching entities.</p>'}filter.addEventListener('input',render);render()</script></body></html>`;
}
