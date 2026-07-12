export interface GraphEntity {
  name: string;
  type: string;
  description: string;
}

export interface GraphRelation {
  source: string;
  target: string;
  relation: string;
}

export interface GraphExtraction {
  entities: GraphEntity[];
  relations: GraphRelation[];
}

const MAX_ENTITIES_PER_CHUNK = 8;
const MAX_RELATIONS_PER_CHUNK = 12;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function entityFrom(value: unknown): GraphEntity | null {
  if (!value || typeof value !== "object") return null;
  const { name, type, description } = value as Record<string, unknown>;
  const entityName = text(name);
  const entityType = text(type);
  if (!entityName || !entityType) return null;
  return { name: entityName, type: entityType, description: text(description) || "" };
}

function relationFrom(value: unknown): GraphRelation | null {
  if (!value || typeof value !== "object") return null;
  const { source, target, relation } = value as Record<string, unknown>;
  const sourceName = text(source);
  const targetName = text(target);
  const relationName = text(relation);
  if (!sourceName || !targetName || !relationName) return null;
  return { source: sourceName, target: targetName, relation: relationName };
}

export function normalizeGraphExtraction(value: unknown): GraphExtraction {
  const payload = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const entities = Array.isArray(payload.entities) ? payload.entities : [];
  const relations = Array.isArray(payload.relations) ? payload.relations : [];
  const knownNames = new Set<string>();
  const uniqueEntities = entities.flatMap((item) => {
    const entity = entityFrom(item);
    const key = entity && `${entity.type.toLowerCase()}:${entity.name.toLowerCase()}`;
    if (!entity || !key || knownNames.has(key) || knownNames.size >= MAX_ENTITIES_PER_CHUNK) return [];
    knownNames.add(key);
    return [entity];
  });
  const entityNames = new Set(uniqueEntities.map((entity) => entity.name.toLowerCase()));
  const relationKeys = new Set<string>();
  const uniqueRelations: GraphRelation[] = [];
  for (const item of relations) {
    const relation = relationFrom(item);
    if (!relation || uniqueRelations.length === MAX_RELATIONS_PER_CHUNK) continue;
    if (!entityNames.has(relation.source.toLowerCase()) || !entityNames.has(relation.target.toLowerCase())) continue;
    const key = `${relation.source.toLowerCase()}:${relation.target.toLowerCase()}:${relation.relation.toLowerCase()}`;
    if (relationKeys.has(key)) continue;
    relationKeys.add(key);
    uniqueRelations.push(relation);
  }
  return { entities: uniqueEntities, relations: uniqueRelations };
}
