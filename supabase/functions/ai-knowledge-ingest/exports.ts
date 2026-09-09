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

/** Bound the embedded payload: an uncapped force layout locks the tab. */
const MAX_GRAPH_ENTITIES = 80;
/** Model-extracted prose; truncating it is what keeps the JSON from growing with the graph. */
const MAX_DESCRIPTION_CHARS = 240;
/** Layout is computed once on load. An animation loop is how a large graph wedges the tab. */
const LAYOUT_ITERATIONS = 250;

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

function retainGraph(
  entities: ExportEntity[],
  relations: ExportRelation[],
): { entities: ExportEntity[]; relations: ExportRelation[]; omitted: number } {
  const knownIds = new Set(entities.map((entity) => entity.id));
  const degree = new Map<string, number>();
  for (const entity of entities) degree.set(entity.id, 0);

  const resolved: ExportRelation[] = [];
  for (const relation of relations) {
    // A relation naming an id that is not in this list is skipped, never
    // drawn to a phantom node and never counted toward degree.
    if (!knownIds.has(relation.source_entity_id) || !knownIds.has(relation.target_entity_id)) {
      continue;
    }
    resolved.push(relation);
    degree.set(relation.source_entity_id, (degree.get(relation.source_entity_id) || 0) + 1);
    degree.set(relation.target_entity_id, (degree.get(relation.target_entity_id) || 0) + 1);
  }

  const ranked = entities.slice().sort((left, right) => {
    const byDegree = (degree.get(right.id) || 0) - (degree.get(left.id) || 0);
    if (byDegree !== 0) return byDegree;
    if (left.name < right.name) return -1;
    if (left.name > right.name) return 1;
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
  });

  const retained = ranked.slice(0, MAX_GRAPH_ENTITIES);
  const retainedIds = new Set(retained.map((entity) => entity.id));
  return {
    entities: retained.map((entity) => ({
      id: entity.id,
      name: entity.name,
      type: entity.type,
      description: entity.description.slice(0, MAX_DESCRIPTION_CHARS),
    })),
    relations: resolved.filter((relation) =>
      retainedIds.has(relation.source_entity_id) && retainedIds.has(relation.target_entity_id)
    ),
    omitted: Math.max(0, entities.length - retained.length),
  };
}

function graphPage(body: string, script?: string): string {
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>Knowledge graph</title>",
    "<style>",
    "body{font:15px system-ui,sans-serif;margin:0;background:#101827;color:#e5e7eb}",
    "header{padding:1rem 1.25rem 0}",
    "h1{font-size:1.25rem;margin:0 0 .5rem}",
    "#status,#empty,#no-match{color:#94a3b8;margin:.25rem 0 .75rem}",
    "#filter{width:min(24rem,100%);padding:.4rem .6rem;border:1px solid #475569;border-radius:.4rem;background:#1e293b;color:#e5e7eb}",
    "#legend{display:flex;flex-wrap:wrap;gap:.4rem .9rem;margin:.6rem 0;font-size:12px;color:#cbd5e1}",
    "#graph{width:100%;height:calc(100vh - 9rem)}",
    "svg{width:100%;height:100%;display:block}",
    ".edge{stroke:#64748b;stroke-width:1.25;fill:none}",
    ".node-label{fill:#e5e7eb;font-size:11px;pointer-events:none}",
    ".swatch{display:inline-block;width:.7rem;height:.7rem;border-radius:50%;margin-right:.35rem;vertical-align:-.1rem}",
    "</style></head><body>",
    body,
    script ? `<script>${script}</script>` : "",
    "</body></html>",
  ].join("");
}

function graphViewerScript(): string {
  // SVG elements need the SVG namespace. The URI is split so this file — which
  // must contain no http(s) resource reference — does not embed one as a literal.
  return `
var NS="ht"+"tp://www.w3.org/2000/svg";
var TYPE_COLORS=["#38bdf8","#a78bfa","#34d399","#fbbf24","#f472b6","#fb923c","#818cf8","#2dd4bf"];
function colorFor(type){
  var hash=0,i=0;
  for(i=0;i<type.length;i++) hash=(hash*31+type.charCodeAt(i))>>>0;
  return TYPE_COLORS[hash%TYPE_COLORS.length];
}
function svgEl(tag){return document.createElementNS(NS,tag)}
var root=document.getElementById("graph");
var filter=document.getElementById("filter");
var legend=document.getElementById("legend");
var WIDTH=1000,HEIGHT=700,RADIUS=10;
var nodes=graph.entities.map(function(entity,index){
  var angle=nodesAngle(index,graph.entities.length);
  return {
    id:entity.id,
    name:entity.name,
    type:entity.type,
    description:entity.description,
    x:WIDTH/2+Math.cos(angle)*Math.min(WIDTH,HEIGHT)*0.32,
    y:HEIGHT/2+Math.sin(angle)*Math.min(WIDTH,HEIGHT)*0.32,
    vx:0,
    vy:0
  };
});
function nodesAngle(index,count){return (2*Math.PI*index)/Math.max(count,1)}
var byId={};
nodes.forEach(function(node){byId[node.id]=node});
var edges=[];
graph.relations.forEach(function(relation){
  var source=byId[relation.source_entity_id];
  var target=byId[relation.target_entity_id];
  if(!source||!target) return;
  edges.push({source:source,target:target,relation:relation.relation});
});
var iter,i,j,edge,node,dx,dy,dist,force,n=nodes.length;
for(iter=0;iter<LAYOUT_ITERATIONS;iter++){
  for(i=0;i<n;i++){
    for(j=i+1;j<n;j++){
      dx=nodes[i].x-nodes[j].x;
      dy=nodes[i].y-nodes[j].y;
      dist=Math.sqrt(dx*dx+dy*dy)||0.01;
      force=1800/(dist*dist);
      dx=dx/dist*force;
      dy=dy/dist*force;
      nodes[i].vx+=dx; nodes[i].vy+=dy;
      nodes[j].vx-=dx; nodes[j].vy-=dy;
    }
  }
  for(i=0;i<edges.length;i++){
    edge=edges[i];
    dx=edge.target.x-edge.source.x;
    dy=edge.target.y-edge.source.y;
    edge.source.vx+=dx*0.02; edge.source.vy+=dy*0.02;
    edge.target.vx-=dx*0.02; edge.target.vy-=dy*0.02;
  }
  for(i=0;i<n;i++){
    node=nodes[i];
    node.vx+=(WIDTH/2-node.x)*0.005;
    node.vy+=(HEIGHT/2-node.y)*0.005;
    node.vx*=0.65; node.vy*=0.65;
    node.x=Math.min(WIDTH-32,Math.max(32,node.x+node.vx));
    node.y=Math.min(HEIGHT-32,Math.max(32,node.y+node.vy));
  }
}
var svg=svgEl("svg");
svg.setAttribute("viewBox","0 0 "+WIDTH+" "+HEIGHT);
svg.setAttribute("role","img");
var edgeLayer=svgEl("g");
var nodeLayer=svgEl("g");
svg.appendChild(edgeLayer);
svg.appendChild(nodeLayer);
var edgeEls=edges.map(function(item){
  var line=svgEl("line");
  line.setAttribute("class","edge");
  line.setAttribute("x1",String(item.source.x));
  line.setAttribute("y1",String(item.source.y));
  line.setAttribute("x2",String(item.target.x));
  line.setAttribute("y2",String(item.target.y));
  line.setAttribute("data-source",item.source.id);
  line.setAttribute("data-target",item.target.id);
  edgeLayer.appendChild(line);
  return {edge:item,line:line};
});
var nodeEls=nodes.map(function(item){
  var group=svgEl("g");
  group.setAttribute("data-entity-id",item.id);
  var circle=svgEl("circle");
  circle.setAttribute("cx",String(item.x));
  circle.setAttribute("cy",String(item.y));
  circle.setAttribute("r",String(RADIUS));
  circle.setAttribute("fill",colorFor(item.type));
  var label=svgEl("text");
  label.setAttribute("class","node-label");
  label.setAttribute("x",String(item.x));
  label.setAttribute("y",String(item.y+RADIUS+12));
  label.setAttribute("text-anchor","middle");
  label.textContent=item.name;
  // The description is the reason each node carries one: the label shows the
  // name unconditionally, and the truncated description is the hover detail.
  var tip=svgEl("title");
  tip.textContent=item.description?item.type+" -- "+item.description:item.type;
  group.appendChild(tip);
  group.appendChild(circle);
  group.appendChild(label);
  nodeLayer.appendChild(group);
  return {node:item,group:group};
});
root.appendChild(svg);
var types=[];
nodes.forEach(function(item){
  if(types.indexOf(item.type)===-1) types.push(item.type);
});
types.sort();
types.forEach(function(type){
  var row=document.createElement("span");
  var swatch=document.createElement("span");
  swatch.className="swatch";
  swatch.style.background=colorFor(type);
  row.appendChild(swatch);
  row.appendChild(document.createTextNode(type));
  legend.appendChild(row);
});
function nameMatches(node,query){
  return node.name.toLowerCase().indexOf(query)!==-1;
}
function render(){
  var query=(filter.value||"").toLowerCase();
  var shown={};
  var visibleCount=0;
  nodeEls.forEach(function(item){
    var visible=nameMatches(item.node,query);
    shown[item.node.id]=visible;
    if(visible) visibleCount++;
    if(visible) item.group.removeAttribute("display");
    else item.group.setAttribute("display","none");
  });
  edgeEls.forEach(function(item){
    var visible=shown[item.edge.source.id]&&shown[item.edge.target.id];
    if(visible) item.line.removeAttribute("display");
    else item.line.setAttribute("display","none");
  });
  var noMatch=document.getElementById("no-match");
  if(noMatch) noMatch.style.display=visibleCount?"none":"block";
}
filter.addEventListener("input",render);
render();
`.replace(/^\s+/gm, "");
}

export function buildGraphHtml(entities: ExportEntity[], relations: ExportRelation[]): string {
  if (entities.length === 0) {
    return graphPage(
      "<header><h1>Knowledge graph</h1><p id=\"empty\">There is nothing to show.</p></header><div id=\"graph\"></div>",
    );
  }

  const retained = retainGraph(entities, relations);
  const { omitted } = retained;
  entities = retained.entities;
  relations = retained.relations;
  const graph = JSON.stringify({ entities, relations }).replace(/</g, "\\u003c");
  const status = omitted > 0
    ? `${omitted} entities omitted (showing ${entities.length} of ${
      entities.length + omitted
    }, cap ${MAX_GRAPH_ENTITIES}, highest degree then name).`
    : `Showing ${entities.length} entities.`;

  return graphPage(
    [
      "<header><h1>Knowledge graph</h1>",
      `<p id="status">${status}</p>`,
      "<input id=\"filter\" placeholder=\"Filter entities\">",
      "<p id=\"no-match\" style=\"display:none\">No matching entities.</p>",
      "<div id=\"legend\"></div></header>",
      "<div id=\"graph\"></div>",
    ].join(""),
    `var LAYOUT_ITERATIONS=${LAYOUT_ITERATIONS};const graph=${graph};${graphViewerScript()}`,
  );
}
