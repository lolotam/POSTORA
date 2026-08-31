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
// A finding id names the exact change, e.g.
//     R3:components.schemas.V1ErrorCode.enum:unsupported_direct_qr
// so an acknowledgement cannot be written broadly enough to pre-approve the
// NEXT break. It authorises one specific change and nothing else.
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

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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

/**
 * Compare one schema node against its baseline counterpart.
 *
 * Recurses through `properties`, `items` and the composition keywords, so a
 * narrowing buried three levels inside a nested object is caught with the same
 * rule as one at the top.
 */
function compareSchema(path: string, base: Json, cur: Json | undefined, out: Finding[]): void {
  if (cur === undefined) {
    out.push({ id: `R1:${path}`, rule: "R1", detail: `${path} was removed` });
    return;
  }

  // ---- R2: the accepted value set shrinks -------------------------------
  const bt = typesOf(base);
  const ct = typesOf(cur);
  if (bt && ct && bt.join("|") !== ct.join("|")) {
    // A union losing a member, or an outright type change, both narrow.
    const lost = bt.filter((t) => !ct.includes(t));
    if (lost.length > 0 || bt.length >= ct.length) {
      out.push({
        id: `R2:${path}.type`,
        rule: "R2",
        detail: `${path}: type ${bt.join("|")} -> ${ct.join("|")}`,
      });
    }
  }
  if (bt && !ct) {
    // Losing the declaration entirely is not narrowing; ignore.
  }
  if (!bt && ct) {
    out.push({
      id: `R2:${path}.type`,
      rule: "R2",
      detail: `${path}: was unconstrained, now typed ${ct.join("|")}`,
    });
  }

  // A previously unconstrained field gaining an enum is a narrowing, even
  // though no enum VALUE was removed -- R3 would miss this entirely.
  if (!Array.isArray(base.enum) && Array.isArray(cur.enum)) {
    out.push({
      id: `R2:${path}.enum`,
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
      out.push({ id: `R2:${path}.${kw}`, rule: "R2", detail: `${path}: ${kw} ${b} -> ${c}` });
    }
    // Introducing a bound where none existed is also a narrowing.
    if (b === undefined && c !== undefined) {
      out.push({ id: `R2:${path}.${kw}`, rule: "R2", detail: `${path}: gained ${kw} ${c}` });
    }
  }

  // A pattern appearing, or changing at all: any change to a regex can reject
  // input the old one accepted, and proving otherwise is undecidable in
  // general. Treated as narrowing, which errs toward asking a human.
  if (base.pattern !== cur.pattern && cur.pattern !== undefined) {
    out.push({
      id: `R2:${path}.pattern`,
      rule: "R2",
      detail: `${path}: pattern ${base.pattern ?? "(none)"} -> ${cur.pattern}`,
    });
  }

  if (base.additionalProperties !== false && cur.additionalProperties === false) {
    out.push({
      id: `R2:${path}.additionalProperties`,
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
        out.push({
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
        out.push({
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
      if (!isObj(sub)) continue;
      const child = curProps[name];
      compareSchema(`${path}.properties.${name}`, sub, isObj(child) ? child : undefined, out);
    }
  }
  if (isObj(base.items)) {
    const child = cur.items;
    compareSchema(`${path}.items`, base.items, isObj(child) ? child : undefined, out);
  }
  for (const kw of ["allOf", "anyOf", "oneOf"] as const) {
    if (Array.isArray(base[kw])) {
      const curArr = Array.isArray(cur[kw]) ? (cur[kw] as unknown[]) : [];
      // A composition losing a member changes what validates; index-wise
      // comparison is crude but never misses a shrink.
      if (curArr.length < (base[kw] as unknown[]).length) {
        out.push({
          id: `R2:${path}.${kw}`,
          rule: "R2",
          detail: `${path}: ${kw} lost ${(base[kw] as unknown[]).length - curArr.length} member(s)`,
        });
      }
      (base[kw] as unknown[]).forEach((sub, i) => {
        if (!isObj(sub)) return;
        const child = curArr[i];
        compareSchema(`${path}.${kw}[${i}]`, sub, isObj(child) ? child : undefined, out);
      });
    }
  }
}

/** Named component maps are compared by key, so deleting a whole schema,
 *  parameter, header, response or security scheme is caught as R1. */
const COMPONENT_GROUPS = [
  "schemas",
  "parameters",
  "headers",
  "responses",
  "securitySchemes",
  "requestBodies",
] as const;

function compare(base: Json, cur: Json): Finding[] {
  const out: Finding[] = [];

  const baseComponents = isObj(base.components) ? base.components : {};
  const curComponents = isObj(cur.components) ? cur.components : {};

  for (const group of COMPONENT_GROUPS) {
    const bg = isObj(baseComponents[group]) ? (baseComponents[group] as Json) : {};
    const cg = isObj(curComponents[group]) ? (curComponents[group] as Json) : {};
    for (const [name, node] of Object.entries(bg)) {
      if (!isObj(node)) continue;
      const child = cg[name];
      const path = `components.${group}.${name}`;
      if (!isObj(child)) {
        out.push({ id: `R1:${path}`, rule: "R1", detail: `${path} was removed` });
        continue;
      }
      // A parameter/header wraps its schema; compare both the wrapper (for
      // `required`) and the schema it carries.
      compareSchema(path, node, child, out);
      if (isObj(node.schema)) {
        compareSchema(
          `${path}.schema`,
          node.schema,
          isObj(child.schema) ? child.schema : undefined,
          out,
        );
      }
    }
  }

  // `paths` is empty today, but a removed path or operation is the most
  // obvious break there is, and this gate should not have to be revisited on
  // the day the first endpoint lands.
  const basePaths = isObj(base.paths) ? base.paths : {};
  const curPaths = isObj(cur.paths) ? cur.paths : {};
  for (const [p, ops] of Object.entries(basePaths)) {
    const cp = curPaths[p];
    if (!isObj(cp)) {
      out.push({ id: `R1:paths.${p}`, rule: "R1", detail: `path ${p} was removed` });
      continue;
    }
    if (isObj(ops)) {
      for (const method of Object.keys(ops)) {
        if (!(method in cp)) {
          out.push({
            id: `R1:paths.${p}.${method}`,
            rule: "R1",
            detail: `operation ${method.toUpperCase()} ${p} was removed`,
          });
        }
      }
    }
  }

  return out;
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
