#!/usr/bin/env -S deno run --allow-read
//
// Contract-drift gate for the Partner API v1 contract (deliverable 0.8).
//
// WHAT THIS PROTECTS
// ------------------
// `docs/api/openapi.yaml` is the published contract for the Partner API. Once a
// partner writes code against it, a change that removes a field, narrows a
// type, drops an enum value, or makes a previously-optional field required will
// break that partner's integration at runtime -- silently, and usually not on
// our side of the wire. This gate makes those four changes impossible to land
// without someone deciding to.
//
// WHY IT IS NOT A SCHEMA VALIDATOR
// --------------------------------
// A validator proves the document is well-formed. Nothing about a well-formed
// document stops it from being a DIFFERENT contract than it was yesterday. The
// implementation plan is explicit that "schema validity alone, or bumping
// `info.version`, must NOT be able to satisfy" this gate -- so `info.version`
// is deliberately not consulted anywhere below. Bumping it is not a decision,
// it is a keystroke; requiring a named acknowledgement of each specific break
// is a decision.
//
// HOW IT WORKS
// ------------
//   current  = docs/api/openapi.yaml            (what the PR proposes)
//   baseline = docs/api/openapi.baseline.yaml   (the last accepted contract)
//
// Every difference is classified against four named rules. Additive changes
// pass without ceremony -- a gate that fires on safe changes is a gate someone
// deletes in a month. Breaking changes fail unless their finding id appears in
// docs/api/accepted-breaking-changes.txt.
//
// A finding id names the exact change INCLUDING THE TRANSITION, e.g.
//     R2:components.schemas.LimitParameter.maximum:100->50
// so acknowledging `string -> integer` does not also authorise a later
// `string -> boolean` at the same path. An ack authorises one specific change
// and nothing else.
//
// THE STALE-ACK RULE
// ------------------
// An acknowledgement that matches no current finding also fails the gate. This
// is not tidiness: a leftover ack silently pre-approves an identical future
// break. Acks are cleared when the baseline is regenerated -- see
// scripts/regenerate-openapi-baseline.sh, which does both in one step for
// exactly this reason.
//
// DO NOT "SIMPLIFY" THIS BY AUTO-UPDATING THE BASELINE. A baseline that
// updates itself compares the document to itself, always finds nothing, and
// turns the gate into an expensive no-op that still looks green.

import { parse } from "jsr:@std/yaml@1";

const DOC = "docs/api/openapi.yaml";
const BASELINE = "docs/api/openapi.baseline.yaml";
const ACKS = "docs/api/accepted-breaking-changes.txt";

type Json = Record<string, unknown>;

interface Finding {
  id: string;
  rule: "R1" | "R2" | "R3" | "R4";
  detail: string;
}

const RULE_NAMES: Record<Finding["rule"], string> = {
  R1: "field removal",
  R2: "type narrowing",
  R3: "enum removal",
  R4: "required-field addition",
};

/** HTTP methods an OpenAPI Path Item may carry. Anything else on a path item
 *  (summary, parameters, servers) is not an operation. */
const HTTP_METHODS = [
  "get", "put", "post", "delete", "options", "head", "patch", "trace",
] as const;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Follow a local `$ref` to the node it names.
 *
 * Without this the gate is blind through the document's most-used construct:
 * `V1ErrorObject.code` is `$ref: V1ErrorCode`, and repointing that ref at a
 * narrower schema changes the contract while both nodes look identical here --
 * neither carries a local `type`, `enum` or `properties` to compare. Reported
 * by the Codex reviewer on #93.
 *
 * Only local refs (`#/...`) are resolved; an external ref is left as-is, and
 * the ref STRING is compared by the caller so a change to one is still visible.
 */
function deref(doc: Json, node: unknown, seen = new Set<string>()): Json | undefined {
  if (!isObj(node)) return undefined;
  const ref = node.$ref;
  if (typeof ref !== "string") return node;
  if (!ref.startsWith("#/")) return node;
  if (seen.has(ref)) return node; // cycle: stop rather than recurse forever
  seen.add(ref);

  let cur: unknown = doc;
  for (const rawSeg of ref.slice(2).split("/")) {
    const seg = rawSeg.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObj(cur)) return undefined;
    cur = cur[seg];
  }
  return deref(doc, cur, seen);
}

/** A node's declared types, normalised. OpenAPI 3.1 allows `type` to be a list
 *  (a union), so a scalar and a one-element list are the same thing here. */
function typesOf(node: Json): string[] | undefined {
  const t = node.type;
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string").sort();
  return undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

interface Ctx {
  baseDoc: Json;
  curDoc: Json;
  out: Finding[];
}

/**
 * Compare one schema node against its baseline counterpart.
 *
 * Recurses through `properties`, `items` and the composition keywords, so a
 * narrowing buried three levels inside a nested object is caught with the same
 * rule as one at the top.
 */
function compareSchema(path: string, rawBase: unknown, rawCur: unknown, ctx: Ctx): void {
  if (rawCur === undefined || rawCur === null) {
    ctx.out.push({ id: `R1:${path}`, rule: "R1", detail: `${path} was removed` });
    return;
  }
  if (!isObj(rawBase) || !isObj(rawCur)) return;

  // A changed `$ref` is itself worth reporting: the target may be compatible,
  // but the reader cannot tell from the path alone, so name it and let the
  // resolved comparison below decide whether it also narrows.
  if (typeof rawBase.$ref === "string" && rawBase.$ref !== rawCur.$ref) {
    ctx.out.push({
      id: `R2:${path}.$ref:${rawBase.$ref}->${rawCur.$ref ?? "(none)"}`,
      rule: "R2",
      detail: `${path}: $ref ${rawBase.$ref} -> ${rawCur.$ref ?? "(inlined)"}`,
    });
  }

  const base = deref(ctx.baseDoc, rawBase) ?? rawBase;
  const cur = deref(ctx.curDoc, rawCur) ?? rawCur;

  // ---- R2: the accepted value set shrinks -------------------------------
  const bt = typesOf(base);
  const ct = typesOf(cur);
  if (bt && ct && bt.join("|") !== ct.join("|")) {
    const lost = bt.filter((t) => !ct.includes(t));
    if (lost.length > 0 || bt.length >= ct.length) {
      // The transition is part of the id: acknowledging string -> integer must
      // not also authorise a later string -> boolean at the same path.
      ctx.out.push({
        id: `R2:${path}.type:${bt.join("|")}->${ct.join("|")}`,
        rule: "R2",
        detail: `${path}: type ${bt.join("|")} -> ${ct.join("|")}`,
      });
    }
  }
  if (!bt && ct) {
    ctx.out.push({
      id: `R2:${path}.type:(unconstrained)->${ct.join("|")}`,
      rule: "R2",
      detail: `${path}: was unconstrained, now typed ${ct.join("|")}`,
    });
  }

  // A previously unconstrained field gaining an enum is a narrowing, even
  // though no enum VALUE was removed -- R3 would miss this entirely.
  if (!Array.isArray(base.enum) && Array.isArray(cur.enum)) {
    ctx.out.push({
      id: `R2:${path}.enum:(unconstrained)->${cur.enum.length}-values`,
      rule: "R2",
      detail: `${path}: gained an enum constraint (${cur.enum.length} values) where it had none`,
    });
  }

  // Numeric and length bounds tightening in either direction.
  for (
    const [kw, tighter] of [
      ["maximum", (b: number, c: number) => c < b],
      ["exclusiveMaximum", (b: number, c: number) => c < b],
      ["maxLength", (b: number, c: number) => c < b],
      ["maxItems", (b: number, c: number) => c < b],
      ["minimum", (b: number, c: number) => c > b],
      ["exclusiveMinimum", (b: number, c: number) => c > b],
      ["minLength", (b: number, c: number) => c > b],
      ["minItems", (b: number, c: number) => c > b],
    ] as const
  ) {
    const b = num(base[kw]);
    const c = num(cur[kw]);
    if (b !== undefined && c !== undefined && tighter(b, c)) {
      ctx.out.push({
        id: `R2:${path}.${kw}:${b}->${c}`,
        rule: "R2",
        detail: `${path}: ${kw} ${b} -> ${c}`,
      });
    }
    if (b === undefined && c !== undefined) {
      ctx.out.push({
        id: `R2:${path}.${kw}:(none)->${c}`,
        rule: "R2",
        detail: `${path}: gained ${kw} ${c}`,
      });
    }
  }

  // A pattern appearing, or changing at all: any change to a regex can reject
  // input the old one accepted, and proving otherwise is undecidable in
  // general. Treated as narrowing, which errs toward asking a human.
  if (base.pattern !== cur.pattern && cur.pattern !== undefined) {
    ctx.out.push({
      id: `R2:${path}.pattern:${base.pattern ?? "(none)"}->${cur.pattern}`,
      rule: "R2",
      detail: `${path}: pattern ${base.pattern ?? "(none)"} -> ${cur.pattern}`,
    });
  }

  if (base.additionalProperties !== false && cur.additionalProperties === false) {
    ctx.out.push({
      id: `R2:${path}.additionalProperties:open->false`,
      rule: "R2",
      detail: `${path}: additionalProperties closed to false`,
    });
  }

  // ---- R3: an enum value disappears -------------------------------------
  if (Array.isArray(base.enum) && Array.isArray(cur.enum)) {
    const curSet = new Set(cur.enum.map((v) => String(v)));
    for (const v of base.enum) {
      const s = String(v);
      if (!curSet.has(s)) {
        ctx.out.push({
          id: `R3:${path}.enum:${s}`,
          rule: "R3",
          detail: `${path}: enum value "${s}" was removed`,
        });
      }
    }
  }

  // ---- R4: a field becomes required -------------------------------------
  const baseReq = new Set((Array.isArray(base.required) ? base.required : []).map(String));
  if (Array.isArray(cur.required)) {
    for (const r of cur.required.map(String)) {
      if (!baseReq.has(r)) {
        ctx.out.push({
          id: `R4:${path}.required:${r}`,
          rule: "R4",
          detail: `${path}: "${r}" is now required and was not before`,
        });
      }
    }
  }

  // ---- R1 + recursion through the children ------------------------------
  if (isObj(base.properties)) {
    const curProps = isObj(cur.properties) ? cur.properties : {};
    for (const [name, sub] of Object.entries(base.properties)) {
      compareSchema(`${path}.properties.${name}`, sub, curProps[name], ctx);
    }
  }
  if (isObj(base.items)) {
    compareSchema(`${path}.items`, base.items, cur.items, ctx);
  }
  for (const kw of ["allOf", "anyOf", "oneOf"] as const) {
    if (Array.isArray(base[kw])) {
      const curArr = Array.isArray(cur[kw]) ? (cur[kw] as unknown[]) : [];
      const baseArr = base[kw] as unknown[];
      if (curArr.length < baseArr.length) {
        ctx.out.push({
          id: `R2:${path}.${kw}:${baseArr.length}->${curArr.length}-members`,
          rule: "R2",
          detail: `${path}: ${kw} lost ${baseArr.length - curArr.length} member(s)`,
        });
      }
      baseArr.forEach((sub, i) => compareSchema(`${path}.${kw}[${i}]`, sub, curArr[i], ctx));
    }
  }
}

/**
 * Compare an OpenAPI PARAMETER object (or a header object, which has the same
 * shape).
 *
 * `required` here is a BOOLEAN, not the array a Schema Object uses, so
 * compareSchema's R4 check does not see it: flipping `Cursor` from
 * `required: false` to `required: true` is a breaking requirement addition
 * that produced no finding. Reported by the Codex reviewer on #91.
 */
function compareParameterLike(path: string, base: Json, cur: Json | undefined, ctx: Ctx): void {
  if (cur === undefined) {
    ctx.out.push({ id: `R1:${path}`, rule: "R1", detail: `${path} was removed` });
    return;
  }
  if (base.required !== true && cur.required === true) {
    ctx.out.push({
      id: `R4:${path}.required:false->true`,
      rule: "R4",
      detail: `${path}: became a required parameter`,
    });
  }
  compareSchema(path, base, cur, ctx);
  if (isObj(base.schema) || isObj(cur?.schema)) {
    compareSchema(`${path}.schema`, base.schema, cur.schema, ctx);
  }
  compareContent(`${path}.content`, base.content, cur.content, ctx);
}

/** Compare a `content: {<media-type>: {schema}}` map. A removed media type is
 *  a removal; each surviving one's schema is compared. */
function compareContent(path: string, base: unknown, cur: unknown, ctx: Ctx): void {
  if (!isObj(base)) return;
  const curMap = isObj(cur) ? cur : {};
  for (const [mt, node] of Object.entries(base)) {
    const child = curMap[mt];
    if (!isObj(child)) {
      ctx.out.push({ id: `R1:${path}.${mt}`, rule: "R1", detail: `${path}: media type ${mt} was removed` });
      continue;
    }
    compareSchema(`${path}.${mt}.schema`, (node as Json).schema, child.schema, ctx);
  }
}

/**
 * Compare one operation: its parameters, request body, and every response with
 * that response's headers and content.
 *
 * Without this the gate only checked that the path and method KEYS still
 * existed, so once the first /v1 endpoint lands a PR could remove a response
 * field, narrow a request type or add a required field and the job would still
 * be green -- defeating the protection this gate advertises. Reported as P1 by
 * the Codex reviewer on both #91 and #93. Written now, while `paths` is still
 * empty, so the gate does not have to be revisited on the day it first matters.
 */
function compareOperation(path: string, base: Json, cur: Json, ctx: Ctx): void {
  // Parameters are an ARRAY keyed by (name, in), not a map.
  //
  // A Parameter Object may also be a `$ref`, and then it has NO name or in of
  // its own. Keying those on the missing fields mapped every one of them to
  // the same "?:?" string, so a Map built from them kept only the last and
  // every ref'd parameter on the path matched against that one. The gate then
  // reported phantom R2 findings comparing the document to ITSELF -- and,
  // worse, would have started doing so permanently the first time a baseline
  // was regenerated with a path carrying two ref'd parameters. Found when the
  // /v1 read surface (2.3-2.6) became the first path section to have any.
  //
  // So: resolve the ref and key on the RESOLVED name/in, which is the
  // parameter's real identity and keeps a `$ref` and its inlined equivalent
  // matching each other. Fall back to the ref string only when the target
  // cannot be resolved.
  if (Array.isArray(base.parameters)) {
    const curParams = Array.isArray(cur.parameters) ? cur.parameters : [];
    const keyOf = (doc: Json) => (p: unknown) => {
      if (!isObj(p)) return JSON.stringify(p);
      const resolved = deref(doc, p) ?? p;
      if (typeof resolved.name === "string" || typeof resolved.in === "string") {
        return `${resolved.name ?? "?"}:${resolved.in ?? "?"}`;
      }
      return typeof p.$ref === "string" ? p.$ref : `${p.name ?? "?"}:${p.in ?? "?"}`;
    };
    const baseKey = keyOf(ctx.baseDoc);
    const curKey = keyOf(ctx.curDoc);
    const curByKey = new Map(curParams.map((p) => [curKey(p), p]));
    for (const p of base.parameters) {
      if (!isObj(p)) continue;
      const match = curByKey.get(baseKey(p));
      compareParameterLike(
        `${path}.parameters[${baseKey(p)}]`,
        p,
        isObj(match) ? match : undefined,
        ctx,
      );
    }
    // A parameter that is NEW and required is a required-field addition.
    const baseKeys = new Set(base.parameters.filter(isObj).map(baseKey));
    for (const p of curParams) {
      if (!isObj(p) || baseKeys.has(curKey(p))) continue;
      // `required` may live behind the ref too.
      const resolved = deref(ctx.curDoc, p) ?? p;
      if (resolved.required === true) {
        ctx.out.push({
          id: `R4:${path}.parameters[${curKey(p)}]:new-required`,
          rule: "R4",
          detail: `${path}: new required parameter ${curKey(p)}`,
        });
      }
    }
  }

  if (isObj(base.requestBody)) {
    const curBody = isObj(cur.requestBody) ? cur.requestBody : undefined;
    if (!curBody) {
      ctx.out.push({ id: `R1:${path}.requestBody`, rule: "R1", detail: `${path}: requestBody was removed` });
    } else {
      if (base.requestBody.required !== true && curBody.required === true) {
        ctx.out.push({
          id: `R4:${path}.requestBody.required:false->true`,
          rule: "R4",
          detail: `${path}: requestBody became required`,
        });
      }
      compareContent(`${path}.requestBody.content`, base.requestBody.content, curBody.content, ctx);
    }
  }

  if (isObj(base.responses)) {
    const curResponses = isObj(cur.responses) ? cur.responses : {};
    for (const [code, node] of Object.entries(base.responses)) {
      const child = curResponses[code];
      if (!isObj(child)) {
        ctx.out.push({ id: `R1:${path}.responses.${code}`, rule: "R1", detail: `${path}: response ${code} was removed` });
        continue;
      }
      if (!isObj(node)) continue;
      compareContent(`${path}.responses.${code}.content`, node.content, child.content, ctx);
      if (isObj(node.headers)) {
        const curHeaders = isObj(child.headers) ? child.headers : {};
        for (const [h, hnode] of Object.entries(node.headers)) {
          if (!isObj(hnode)) continue;
          compareParameterLike(
            `${path}.responses.${code}.headers.${h}`,
            hnode,
            isObj(curHeaders[h]) ? (curHeaders[h] as Json) : undefined,
            ctx,
          );
        }
      }
    }
  }
}

/** Named component maps are compared by key, so deleting a whole schema,
 *  parameter, header, response or security scheme is caught as R1. */
const SCHEMA_GROUPS = ["schemas"] as const;
const PARAMETER_LIKE_GROUPS = ["parameters", "headers"] as const;
const CARRIER_GROUPS = ["responses", "requestBodies"] as const;
const OTHER_GROUPS = ["securitySchemes"] as const;

function compare(base: Json, cur: Json): Finding[] {
  const ctx: Ctx = { baseDoc: base, curDoc: cur, out: [] };

  const baseComponents = isObj(base.components) ? base.components : {};
  const curComponents = isObj(cur.components) ? cur.components : {};

  const group = (c: Json, name: string): Json => (isObj(c[name]) ? c[name] as Json : {});

  for (const g of SCHEMA_GROUPS) {
    const bg = group(baseComponents, g), cg = group(curComponents, g);
    for (const [name, node] of Object.entries(bg)) {
      compareSchema(`components.${g}.${name}`, node, cg[name], ctx);
    }
  }

  for (const g of PARAMETER_LIKE_GROUPS) {
    const bg = group(baseComponents, g), cg = group(curComponents, g);
    for (const [name, node] of Object.entries(bg)) {
      if (!isObj(node)) continue;
      compareParameterLike(
        `components.${g}.${name}`,
        node,
        isObj(cg[name]) ? cg[name] as Json : undefined,
        ctx,
      );
    }
  }

  for (const g of CARRIER_GROUPS) {
    const bg = group(baseComponents, g), cg = group(curComponents, g);
    for (const [name, node] of Object.entries(bg)) {
      if (!isObj(node)) continue;
      const child = cg[name];
      const path = `components.${g}.${name}`;
      if (!isObj(child)) {
        ctx.out.push({ id: `R1:${path}`, rule: "R1", detail: `${path} was removed` });
        continue;
      }
      compareContent(`${path}.content`, node.content, child.content, ctx);
      if (isObj(node.headers)) {
        const curHeaders = isObj(child.headers) ? child.headers : {};
        for (const [h, hnode] of Object.entries(node.headers)) {
          if (!isObj(hnode)) continue;
          compareParameterLike(
            `${path}.headers.${h}`,
            hnode,
            isObj(curHeaders[h]) ? curHeaders[h] as Json : undefined,
            ctx,
          );
        }
      }
    }
  }

  for (const g of OTHER_GROUPS) {
    const bg = group(baseComponents, g), cg = group(curComponents, g);
    for (const [name, node] of Object.entries(bg)) {
      if (!isObj(node)) continue;
      const child = cg[name];
      const path = `components.${g}.${name}`;
      if (!isObj(child)) {
        ctx.out.push({ id: `R1:${path}`, rule: "R1", detail: `${path} was removed` });
        continue;
      }
      // A security scheme that changes how a credential is presented breaks
      // every existing client just as surely as a removed field.
      for (const kw of ["type", "in", "name", "scheme"] as const) {
        if (node[kw] !== undefined && node[kw] !== child[kw]) {
          ctx.out.push({
            id: `R2:${path}.${kw}:${String(node[kw])}->${String(child[kw] ?? "(none)")}`,
            rule: "R2",
            detail: `${path}: ${kw} ${String(node[kw])} -> ${String(child[kw] ?? "(none)")}`,
          });
        }
      }
    }
  }

  const basePaths = isObj(base.paths) ? base.paths : {};
  const curPaths = isObj(cur.paths) ? cur.paths : {};
  for (const [p, ops] of Object.entries(basePaths)) {
    const cp = curPaths[p];
    if (!isObj(cp)) {
      ctx.out.push({ id: `R1:paths.${p}`, rule: "R1", detail: `path ${p} was removed` });
      continue;
    }
    if (!isObj(ops)) continue;
    for (const method of HTTP_METHODS) {
      const baseOp = ops[method];
      if (!isObj(baseOp)) continue;
      const curOp = cp[method];
      if (!isObj(curOp)) {
        ctx.out.push({
          id: `R1:paths.${p}.${method}`,
          rule: "R1",
          detail: `operation ${method.toUpperCase()} ${p} was removed`,
        });
        continue;
      }
      compareOperation(`paths.${p}.${method}`, baseOp, curOp, ctx);
    }
  }

  return ctx.out;
}

async function readYaml(path: string): Promise<Json> {
  const text = await Deno.readTextFile(path);
  const doc = parse(text);
  if (!isObj(doc)) throw new Error(`${path} did not parse to an object`);
  return doc;
}

async function readAcks(): Promise<Set<string>> {
  let text: string;
  try {
    text = await Deno.readTextFile(ACKS);
  } catch {
    return new Set();
  }
  return new Set(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#")),
  );
}

async function main() {
  const [base, cur, acks] = await Promise.all([
    readYaml(BASELINE),
    readYaml(DOC),
    readAcks(),
  ]);

  const findings = compare(base, cur);
  const unacknowledged = findings.filter((f) => !acks.has(f.id));
  const findingIds = new Set(findings.map((f) => f.id));
  const stale = [...acks].filter((a) => !findingIds.has(a));

  if (findings.length === 0 && stale.length === 0) {
    console.log("contract drift: no breaking changes against the baseline.");
    Deno.exit(0);
  }

  for (const f of findings) {
    const state = acks.has(f.id) ? "ACKNOWLEDGED" : "BREAKING";
    console.log(`${state}  [${f.rule} ${RULE_NAMES[f.rule]}] ${f.detail}`);
    if (!acks.has(f.id)) console.log(`          id: ${f.id}`);
  }

  for (const s of stale) {
    console.log(`STALE ACK  ${s}`);
  }

  if (unacknowledged.length === 0 && stale.length === 0) {
    console.log(
      `\ncontract drift: ${findings.length} breaking change(s), all acknowledged in ${ACKS}.`,
    );
    Deno.exit(0);
  }

  console.error("");
  if (unacknowledged.length > 0) {
    console.error(
      `${unacknowledged.length} unacknowledged breaking change(s) to the published contract.`,
    );
    console.error(
      `If they are intended, add each id above to ${ACKS} with a line saying who decided and why.`,
    );
    console.error(
      "Bumping info.version does NOT satisfy this gate, deliberately -- it is a keystroke, not a decision.",
    );
  }
  if (stale.length > 0) {
    console.error(
      `\n${stale.length} acknowledgement(s) match no current finding. Remove them: a stale ack`,
    );
    console.error(
      "silently pre-approves an identical future break. scripts/regenerate-openapi-baseline.sh clears them.",
    );
  }
  Deno.exit(1);
}

if (import.meta.main) {
  await main();
}
