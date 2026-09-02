#!/usr/bin/env -S deno run --allow-read --allow-write
// Postman collection generator — PRD §33, Task 10.3.
//
// Source of truth: docs/api/openapi.yaml (canonical contract).
// Output: docs/api/postman/*.json (derived, never hand-edited).
// One-fact-one-place: the contract lives in openapi.yaml; the collection is derived.
//
// Deterministic: stable key order, 2-space indent, trailing newline, no timestamps,
// fixed _postman_id, synthetic examples from schema examples or type placeholders.

import { parse } from "jsr:@std/yaml@1";

const DOC_PATH = "docs/api/openapi.yaml";
const COLLECTION_PATH = "docs/api/postman/postora-partner-api.postman_collection.json";
const ENV_DIR = "docs/api/postman";
const COLLECTION_ID = "00000000-0000-4000-8000-000000000001";

// deno-lint-ignore no-explicit-any
type Any = any;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Resolve local $ref like #/components/schemas/Foo
function deref(doc: Any, node: unknown, seen = new Set<string>()): Any {
  if (!isObj(node)) return node;
  const ref = node.$ref as string | undefined;
  if (typeof ref !== "string" || !ref.startsWith("#/")) return node;
  if (seen.has(ref)) return node;
  seen.add(ref);
  let cur: unknown = doc;
  for (const seg of ref.slice(2).split("/")) {
    const key = seg.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObj(cur)) return undefined;
    cur = (cur as Any)[key];
  }
  return deref(doc, cur, seen);
}

function resolveSchema(doc: Any, schema: Any): Any {
  if (!isObj(schema)) return schema;
  const d = deref(doc, schema);
  return d ?? schema;
}

// Generate deterministic placeholder for a schema
/** Path parameters declared on the operation or its path item, $refs resolved. */
function pathParametersOf(doc: Any, pathItem: Any, op: Any): Array<{ name: string; schema?: Any }> {
  const declared = [...((pathItem.parameters ?? []) as Any[]), ...((op.parameters ?? []) as Any[])];
  return declared
    .map((p) => resolveSchema(doc, p))
    .filter((p): p is Record<string, unknown> => isObj(p) && p.in === "path" && typeof p.name === "string")
    .map((p) => ({ name: p.name as string, schema: p.schema }));
}

function placeholderForSchema(doc: Any, raw: Any, pathHint = ""): Any {
  const schema = resolveSchema(doc, raw);
  if (!isObj(schema)) return null;

  // Handle allOf by merging
  if (Array.isArray(schema.allOf)) {
    let merged: Any = {};
    for (const part of schema.allOf) {
      const resolved = resolveSchema(doc, part);
      if (isObj(resolved)) {
        for (const k of Object.keys(resolved)) {
          if (k === "properties" && isObj(resolved.properties)) {
            merged.properties = { ...(merged.properties ?? {}), ...(resolved.properties as Any) };
          } else if (k === "required" && Array.isArray(resolved.required)) {
            merged.required = [...(merged.required ?? []), ...((resolved.required as string[]) ?? [])];
          } else if (merged[k] === undefined) {
            merged[k] = resolved[k];
          }
        }
        if (!merged.type && resolved.type) merged.type = resolved.type;
      }
    }
    // Overlay outer schema's own keys (e.g. pattern on an allOf wrapper) — outer wins
    for (const k of Object.keys(schema)) {
      if (k === "allOf") continue;
      if (k === "required" && Array.isArray(merged.required) && Array.isArray(schema.required)) {
        merged.required = [...new Set([...merged.required, ...schema.required])];
      } else if (k === "properties" && isObj(merged.properties) && isObj((schema as Any).properties)) {
        merged.properties = { ...(merged.properties as Any), ...((schema as Any).properties as Any) };
      } else {
        merged[k] = (schema as Any)[k];
      }
    }
    return placeholderForSchema(doc, merged, pathHint);
  }

  // oneOf / anyOf: pick first
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return placeholderForSchema(doc, schema.oneOf[0], pathHint);
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return placeholderForSchema(doc, schema.anyOf[0], pathHint);
  }

  // Enum: first value
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }

  // Explicit example (after enum, before type) — but for string ids, pattern wins
  const hasIdPattern = typeof schema.pattern === "string" &&
    ["acc_", "conv_", "msg_", "media_", "post_", "wh_", "evt_"].some((p) => (schema.pattern as string).includes(p));
  if (schema.example !== undefined && !(schema.type === "string" && hasIdPattern)) {
    return schema.example;
  }

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  // Handle type arrays like [string, 'null'] – pick string variant
  // (type already resolved to first element above)

  if (type === "object" || (!type && isObj(schema.properties))) {
    const out: Any = {};
    const props = (schema.properties ?? {}) as Record<string, Any>;
    const required: string[] = Array.isArray(schema.required) ? schema.required : Object.keys(props);
    // If required is defined, use it; else include all properties with example or first few
    const keys = required.length > 0 ? required : Object.keys(props);
    for (const k of keys) {
      const propSchema = props[k];
      if (!propSchema) continue;
      // Skip if property type includes null and we want minimal – still include
      out[k] = placeholderForSchema(doc, propSchema, k);
    }
    return out;
  }

  if (type === "array") {
    const items = (schema as Any).items;
    if (!items) return [];
    return [placeholderForSchema(doc, items, pathHint)];
  }

  if (type === "string") {
    // Pattern-based ids — win over generic example
    const pattern = schema.pattern as string | undefined;
    if (pattern) {
      if (pattern.includes("acc_")) return "acc_000000000000000000000000";
      if (pattern.includes("conv_")) return "conv_000000000000000000000000";
      if (pattern.includes("msg_")) return "msg_000000000000000000000000";
      if (pattern.includes("media_")) return "media_000000000000000000000000";
      if (pattern.includes("post_")) return "post_000000000000000000000000";
      if (pattern.includes("wh_")) return "wh_000000000000000000000000";
      if (pattern.includes("evt_")) return "evt_000000000000000000000000";
      if (pattern.includes("PrefixedId")) return "acc_000000000000000000000000";
      if (pathHint === "recipient_phone" || pattern.includes("phone")) return "+15550000000";
    }
    if (schema.example !== undefined) return schema.example;
    if (pathHint === "recipient_phone") return "+15550000000";
    if (pathHint === "phone" || pathHint.toLowerCase().includes("phone")) return "+15550000000";
    if (schema.format === "date-time") return "2026-01-01T00:00:00Z";
    if (schema.format === "uri") return "https://example.com/webhook";
    if (schema.format === "uuid") return "550e8400-e29b-41d4-a716-446655440000";
    if (schema.format === "binary") return "binary";
    return "string";
  }

  if (type === "integer" || type === "number") {
    if (typeof schema.example === "number") return schema.example;
    if (typeof schema.default === "number") return schema.default;
    if (typeof schema.minimum === "number") return schema.minimum;
    return 0;
  }

  if (type === "boolean") {
    return true;
  }

  // Fallback: if schema has type array with 'null', pick non-null
  if (Array.isArray((schema as Any).type)) {
    const types = (schema as Any).type as string[];
    const nonNull = types.find((t) => t !== "null");
    if (nonNull) return placeholderForSchema(doc, { ...schema, type: nonNull }, pathHint);
  }

  // If no type but has properties etc.
  if (isObj(schema.properties)) return placeholderForSchema(doc, { ...schema, type: "object" }, pathHint);

  // Unable to map
  throw new Error(`cannot map schema at ${pathHint}: ${JSON.stringify(schema).slice(0, 200)}`);
}

export function buildCollection(doc: Any): Any {
  const paths = (doc.paths ?? {}) as Record<string, Any>;
  const pathKeys = Object.keys(paths).sort();

  // Group by top-level resource
  const groups = new Map<string, Any[]>();

  for (const path of pathKeys) {
    const pathItem = paths[path];
    if (!isObj(pathItem)) continue;
    // Strip mount prefix to get /v1/... segment robustly (mount contains /v1/ itself)
    const mount = "/functions/v1/partner-api";
    const afterMount = path.startsWith(mount) ? path.slice(mount.length) : path;
    // afterMount is like "/v1/accounts" or "/v1/messages"
    const v1Path = afterMount.startsWith("/v1/") || afterMount === "/v1" ? afterMount : path.slice(path.indexOf("/v1/"));
    const segments = v1Path.split("/").filter(Boolean);
    // segments[0] is 'v1', segments[1] is resource
    const resource = segments[1] ?? "other";

    for (const method of ["get", "post", "put", "patch", "delete", "options", "head", "trace"]) {
      const op = pathItem[method];
      if (!isObj(op)) continue;
      const summary = (op.summary as string | undefined) ?? `${method.toUpperCase()} ${v1Path}`;
      const operationId = op.operationId as string | undefined;

      // Determine if Idempotency-Key required
      let needsIdempotency = false;
      const params = (op.parameters ?? []) as Any[];
      for (const p of params) {
        const resolved = resolveSchema(doc, p);
        if (isObj(resolved) && resolved.name === "Idempotency-Key") needsIdempotency = true;
        // also check $ref to IdempotencyKey
        if (isObj(p) && typeof p.$ref === "string" && p.$ref.includes("IdempotencyKey")) needsIdempotency = true;
      }
      const headers: Any[] = [
        { key: "x-postora-key", value: "{{partnerApiKey}}", type: "text" },
      ];
      if (needsIdempotency) {
        headers.push({ key: "Idempotency-Key", value: "{{$guid}}", type: "text" });
      }

      // Build request body example if present
      let body: Any | undefined;
      if (isObj(op.requestBody) && isObj(op.requestBody.content)) {
        const content = op.requestBody.content as Record<string, Any>;
        const jsonContent = content["application/json"] ?? content["multipart/form-data"] ?? Object.values(content)[0];
        if (isObj(jsonContent) && jsonContent.schema) {
          let exampleBody: unknown;
          try {
            exampleBody = placeholderForSchema(doc, jsonContent.schema, `${method} ${path}`);
          } catch (e) {
            throw new Error(`cannot map requestBody schema for ${method.toUpperCase()} ${path}: ${(e as Error).message}`);
          }
          const contentType = content["application/json"] ? "application/json" : "multipart/form-data";
          if (contentType === "application/json") {
            body = {
              mode: "raw",
              raw: JSON.stringify(exampleBody, null, 2),
              options: { raw: { language: "json" } },
            };
          } else {
            // multipart: not JSON, create formdata placeholder
            body = {
              mode: "formdata",
              formdata: [{ key: "file", type: "file", src: [] }],
            };
          }
        }
      }

      // `{id}` becomes Postman's `:id`, with a synthetic value in `variable`,
      // so the request is runnable as generated instead of sending a literal
      // brace to the door.
      const pathOnly = path.slice(path.indexOf(mount)).replace(/\{([^}]+)\}/g, ":$1");
      const pathVariables = pathParametersOf(doc, pathItem, op).map((p) => ({
        key: p.name,
        value: placeholderForSchema(doc, p.schema ?? { type: "string" }, `${method} ${path} {${p.name}}`),
      }));
      const request: Any = {
        method: method.toUpperCase(),
        header: headers,
        url: {
          raw: `{{baseUrl}}${pathOnly}`,
          host: ["{{baseUrl}}"],
          path: pathOnly.replace(/^\//, "").split("/"),
          ...(pathVariables.length ? { variable: pathVariables } : {}),
        },
        description: (op.description as string | undefined)?.slice(0, 500) ?? "",
      };
      if (body) request.body = body;

      const item = {
        name: summary,
        request,
        response: [],
      };

      if (!groups.has(resource)) groups.set(resource, []);
      groups.get(resource)!.push(item);
    }
  }

  // Sort resources alphabetically for determinism, but spec wants folder per resource
  // Order: accounts, conversations, media, messages, templates, posts, webhooks, usage
  // We'll sort alphabetically to have deterministic but also respect desired order
  const desiredOrder = ["accounts", "conversations", "media", "messages", "templates", "posts", "webhooks", "usage"];
  const sortedResources = [...groups.keys()].sort((a, b) => {
    const ia = desiredOrder.indexOf(a);
    const ib = desiredOrder.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  const items: Any[] = [];
  for (const r of sortedResources) {
    const children = groups.get(r)!;
    // Sort requests within folder by name for determinism
    children.sort((a, b) => a.name.localeCompare(b.name));
    items.push({
      name: r,
      item: children,
    });
  }

  const collection = {
    info: {
      name: "Postora Partner API",
      _postman_id: COLLECTION_ID,
      description: "Generated from docs/api/openapi.yaml — do not hand-edit. Run `deno run --allow-read --allow-write scripts/generate-postman.ts` to regenerate.",
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: items,
    variable: [
      { key: "baseUrl", value: "https://api.postora.cloud", type: "string" },
      { key: "partnerApiKey", value: "pk_live_REPLACE_ME", type: "string" },
    ],
  };

  return collection;
}

export function buildEnvironments(): Record<string, Any> {
  const base = [
    { key: "baseUrl", enabled: true },
    { key: "partnerApiKey", enabled: true },
  ];
  const envs: Record<string, Any> = {
    "local.postman_environment.json": {
      id: "00000000-0000-4000-8000-000000000002",
      name: "Postora Partner API - Local",
      values: [
        { key: "baseUrl", value: "http://localhost:54321", enabled: true },
        { key: "partnerApiKey", value: "pk_test_REPLACE_ME", enabled: true },
      ],
      _postman_variable_scope: "environment",
      _postman_exported_using: "Postman/10.0.0",
    },
    "staging.postman_environment.json": {
      id: "00000000-0000-4000-8000-000000000003",
      name: "Postora Partner API - Staging",
      values: [
        { key: "baseUrl", value: "https://staging-api.postora.cloud", enabled: true },
        { key: "partnerApiKey", value: "pk_test_REPLACE_ME", enabled: true },
      ],
      _postman_variable_scope: "environment",
      _postman_exported_using: "Postman/10.0.0",
    },
    "production.postman_environment.json": {
      id: "00000000-0000-4000-8000-000000000004",
      name: "Postora Partner API - Production",
      values: [
        { key: "baseUrl", value: "https://api.postora.cloud", enabled: true },
        { key: "partnerApiKey", value: "pk_live_REPLACE_ME", enabled: true },
      ],
      _postman_variable_scope: "environment",
      _postman_exported_using: "Postman/10.0.0",
    },
  };
  // Ensure deterministic key order within each env (already)
  return envs;
}

function stableStringify(obj: unknown): string {
  return JSON.stringify(obj, null, 2) + "\n";
}

if (import.meta.main) {
  const text = await Deno.readTextFile(DOC_PATH);
  const doc = parse(text) as Any;
  if (!isObj(doc)) throw new Error(`${DOC_PATH} did not parse to object`);

  let collection: Any;
  try {
    collection = buildCollection(doc);
  } catch (e) {
    console.error(`failed to build collection: ${(e as Error).message}`);
    Deno.exit(1);
  }
  const envs = buildEnvironments();

  await Deno.mkdir(ENV_DIR, { recursive: true });
  await Deno.writeTextFile(COLLECTION_PATH, stableStringify(collection));
  for (const [fname, env] of Object.entries(envs)) {
    await Deno.writeTextFile(`${ENV_DIR}/${fname}`, stableStringify(env));
  }

  const totalRequests = (collection.item as Any[]).reduce((sum: number, folder: Any) => sum + (folder.item?.length ?? 0), 0);
  console.log(`postman: wrote ${totalRequests} requests in ${collection.item.length} folders to ${COLLECTION_PATH} + 3 environments`);
}
