#!/usr/bin/env -S deno run --allow-read --allow-write
// The partner hand-off bundle: one file a partner pastes into whatever agent
// implements their integration (Claude Code, Cursor, Codex, Copilot).
//
// Everything in it is DERIVED. The prose is the developer pages under
// docs/developer/, concatenated in a fixed order; the endpoint, scope, error
// and event tables are read from the code and the contract that define them
// (v1/router.ts, partner-api/router.ts, v1/errors.ts, partnerWebhookEvents.ts,
// openapi.yaml). Nothing here is typed twice, so nothing here can drift from
// its source -- and a CI test asserts the committed output is what this
// script produces.
//
// The one hand-written part is the "Rules and traps" section, because it is
// not a fact about the API but advice to the implementer: the mistakes an
// agent makes when it has the contract and no one who has been burned by it.
//
// Outputs:
//   docs/developer/AGENT-CONTEXT.md   the full bundle
//   docs/developer/llms.txt           the llms.txt index: rules + links

import { parse } from "jsr:@std/yaml@1";

const ROOT = new URL("../", import.meta.url);
const DEV_DIR = new URL("docs/developer/", ROOT);
export const CONTEXT_PATH = new URL("docs/developer/AGENT-CONTEXT.md", ROOT);
export const LLMS_PATH = new URL("docs/developer/llms.txt", ROOT);

const BASE_URL = "https://api.postora.cloud/functions/v1/partner-api";
const MOUNT = "/functions/v1/partner-api";

/**
 * Reading order: the PRD §32 sequence, with the index first, the end-to-end
 * walkthrough after the resources it uses, policy pages next, and the
 * "not in v1" stubs last so an agent does not spend attention on them.
 */
export const PAGE_ORDER = [
  "README.md",
  "getting-started.md",
  "authentication.md",
  "api-keys.md",
  "scopes.md",
  "pagination.md",
  "idempotency.md",
  "rate-limits.md",
  "quotas.md",
  "errors.md",
  "webhooks.md",
  "messaging.md",
  "media.md",
  "publishing.md",
  "connectors.md",
  "social-accounts.md",
  "integration-guides.md",
  "versioning.md",
  "deprecations.md",
  "changelog.md",
  "oauth.md",
  "contacts.md",
  "analytics.md",
  "ai.md",
] as const;

/** Files under docs/developer/ that are outputs of this script, not inputs. */
export const GENERATED = ["AGENT-CONTEXT.md", "llms.txt"] as const;

// ---------------------------------------------------------------------------
// Rules and traps -- the only hand-written section.
// ---------------------------------------------------------------------------

export const RULES = `## Rules and traps for the implementing agent

Read these before the reference. Each one is a mistake an implementation makes when it has the contract and nothing else.

1. **Workspace routes authenticate with \`x-postora-key\`, nothing else.** Platform routes under \`/v1/platform/\` use \`Authorization: Bearer pl_live_…\` (or \`x-postora-key\` with that platform key). These are separate credentials and scopes. Test keys (\`pk_test_\` / \`pl_test_\`) never work against production; live keys never work against staging.
2. **Every \`POST /v1/messages\`, \`POST /v1/media\`, \`POST /v1/posts\`, \`POST /v1/connectors/{type}/connect-link\` and \`POST /v1/tools/execute\` carries an \`Idempotency-Key\`.** Generate one UUID per logical operation, store it with the operation, and reuse it on every retry of that operation. A new key on retry is a duplicate send. \`POST /v1/posts/{id}/schedule\` and the webhook routes do not take one.
3. **Retry only when \`error.retryable\` is \`true\`.** Never decide from the HTTP status family: \`temporarily_unavailable\` is a 503 that is NOT retryable, \`idempotency_in_progress\` is a 409 that IS. Back off exponentially and honour \`Retry-After\` when present.
4. **For messaging, \`idempotency_indeterminate\` means "may have been delivered". Do not resend.** Not with the same key (it will answer the same 409) and not with a new one (that is a second real message to a real customer). Reconcile: wait for the \`message.accepted\` webhook, or list the conversation's messages and match \`provider_message_id\`. For platform provisioning, reconcile the workspace estate as described in rule 16.
5. **A replay is not a new send.** The same key and the same body return the stored response with \`Idempotency-Replayed: true\`. The same key with a different body is \`idempotency_conflict\`; that is a bug in the caller, not a transient.
6. **Verify webhook signatures over the exact raw request bytes.** \`X-Postora-Signature\` is \`sha256=<hex>\` of HMAC-SHA256(secret, \`<X-Postora-Timestamp>.<raw body>\`). Sign the bytes you received, before any JSON parsing or re-serialisation; compare in constant time; reject timestamps older than your own replay window (we suggest 5 minutes). Then answer 2xx quickly and process asynchronously: anything else is retried on a 1m / 5m / 30m / 2h / 6h ladder.
7. **Deduplicate webhooks on \`X-Postora-Event-Id\`.** Delivery is at-least-once and ordering is not guaranteed; a \`message.delivered\` can arrive before the \`message.accepted\` it follows.
8. **404 \`resource_not_found\` is also the answer for "exists, but not yours".** Anything outside the accounts bound to the key answers 404, never 403. Do not read a 404 as "wrong URL" until you have checked the id belongs to a bound account.
9. **Only what this key created through the API is addressable.** A post made in the Postora UI answers 404 on every \`/v1/posts\` route, permanently. There is no \`POST /v1/posts/{id}/publish\`: schedule it and the scheduler publishes.
10. **Reference media by \`media_id\`, never by URL.** Upload first (\`POST /v1/media\`), then send. \`media_pending\` (409, retryable) means retry the SAME request later; \`media_rejected\` (422) means that file will never send.
11. **\`type: template\` sends are suspended** (503 \`temporarily_unavailable\`, not retryable) as a policy state. Text and media sends are live. Build the template path against the contract, but do not treat its 503 as an outage to poll.
12. **Treat every id as opaque.** Ids are prefixed (\`acc_\`, \`conv_\`, \`msg_\`, \`media_\`, \`post_\`, \`wh_\`); never parse or construct them. \`message_id\` returned by a send is the provider's id (a WhatsApp \`wamid\`), which is a different thing from a \`msg_\` id. The connector routes are the one exception: \`tool_id\`, \`social_account_id\` and \`connection_id\` there are bare UUIDs, still opaque — take them from \`GET /v1/connectors\` and pass them back unchanged.
13. **Page with \`next_cursor\` until it is \`null\`.** It is always present on a listing; \`null\` is the only terminator.
14. **Tolerate unknown fields and enum values.** The contract is additive-only; a client that fails on a new optional field will break on the next release. Breaking changes only ever arrive under a new path prefix.
15. **Log \`X-Postora-Request-Id\` with every call** (it is also \`request_id\` in every body, success or error). It is the only handle support has for "this call returned the wrong thing".
16. **Platform provisioning returns its bootstrap secret once.** Reuse \`external_ref\` to recover existing workspace metadata, then issue a new key with an explicit account UUID if the secret was lost. Unresolved attempts answer \`idempotency_indeterminate\`: reconcile before provisioning again. Platform workspace/account/key ids are bare UUIDs. Ownership belongs to the principal and survives platform credential rotation.

`;

// ---------------------------------------------------------------------------
// Derived tables.
// ---------------------------------------------------------------------------

interface Route {
  method: string;
  path: string;
  action: string;
  riskClass: string;
}

/** The served route table, read from V1_ROUTES the way contractConformance does. */
export function parseRoutes(routerSource: string): Route[] {
  const routes: Route[] = [];
  let pattern: string | null = null;
  for (const line of routerSource.split("\n")) {
    const p = line.match(/^ {4}pattern: "([^"]+)",\s*$/);
    if (p) {
      pattern = p[1];
      continue;
    }
    const m = line.match(/^ {6}(GET|POST|PATCH|PUT|DELETE): with(?:Partner|Platform)Auth\("(\w+)", "([ABC])"/);
    if (m && pattern) routes.push({ method: m[1], path: pattern, action: m[2], riskClass: m[3] });
  }
  return routes;
}

/** ACTION_SCOPES: action -> scope list, or null for "no scope required". */
export function parseActionScopes(policySource: string, table = "ACTION_SCOPES"): Map<string, string[] | null> {
  const block = policySource.slice(policySource.indexOf(`export const ${table}`));
  const body = block.slice(0, block.indexOf("\n};"));
  const scopes = new Map<string, string[] | null>();
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*(\w+): (null|\[[^\]]*\]),\s*(?:\/\/.*)?$/);
    if (!m) continue;
    scopes.set(m[1], m[2] === "null" ? null : [...m[2].matchAll(/"([^"]+)"/g)].map((s) => s[1]));
  }
  return scopes;
}

interface ErrorPolicy {
  code: string;
  status: number;
  retryable: boolean;
  message: string;
}

/** V1_ERROR_POLICY, entry by entry: the code, its status, its retry verdict, its default message. */
export function parseErrorPolicy(errorsSource: string): ErrorPolicy[] {
  const start = errorsSource.indexOf("export const V1_ERROR_POLICY");
  const body = errorsSource.slice(start, errorsSource.indexOf("} as const satisfies", start));
  const entries: ErrorPolicy[] = [];
  const entryRe = /^ {2}(\w+): \{\n((?:.*\n)*?) {2}\},/gm;
  for (const m of body.matchAll(entryRe)) {
    const inner = m[2];
    const status = inner.match(/status: (\d+)/);
    const retryable = inner.match(/retryable: (true|false)/);
    const message = [...inner.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((s) => s[1]).join("");
    if (!status || !retryable) throw new Error(`V1_ERROR_POLICY entry ${m[1]} has no status/retryable`);
    entries.push({ code: m[1], status: Number(status[1]), retryable: retryable[1] === "true", message });
  }
  if (entries.length === 0) throw new Error("V1_ERROR_POLICY parsed to nothing; errors.ts changed shape");
  return entries;
}

/** The certified event names, as listed in partnerWebhookEvents.ts. */
export function parseEvents(eventsSource: string): string[] {
  const start = eventsSource.indexOf("[");
  const end = eventsSource.indexOf("]", start);
  const names = [...eventsSource.slice(start, end).matchAll(/"([a-z_]+\.[a-z_]+)"/g)].map((m) => m[1]);
  if (names.length === 0) throw new Error("no event names parsed from partnerWebhookEvents.ts");
  return names;
}

// deno-lint-ignore no-explicit-any
type Any = any;

function summariesFromContract(doc: Any): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    if (!path.startsWith(MOUNT)) continue;
    for (const [method, op] of Object.entries(item as Record<string, Any>)) {
      if (typeof op !== "object" || op === null || !("responses" in op)) continue;
      out.set(`${method.toUpperCase()} ${path.slice(MOUNT.length)}`, String(op.summary ?? ""));
    }
  }
  return out;
}

function endpointTable(routes: Route[], scopes: Map<string, string[] | null>, summaries: Map<string, string>): string {
  const rows = routes.map((r) => {
    const scope = scopes.get(r.action);
    if (scope === undefined) throw new Error(`route ${r.method} ${r.path} declares action ${r.action} which ACTION_SCOPES does not know`);
    const summary = summaries.get(`${r.method} ${r.path}`);
    if (summary === undefined) throw new Error(`route ${r.method} ${r.path} is served but not in openapi.yaml`);
    const scopeText = scope === null ? "none" : scope.map((s) => `\`${s}\``).join(" or ");
    return `| \`${r.method}\` | \`${r.path}\` | ${scopeText} | ${r.riskClass} | ${summary} |`;
  });
  return [
    "| Method | Path | Scope | Limiter class | What it does |",
    "|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

function errorTable(policy: ErrorPolicy[]): string {
  const rows = policy.map((e) =>
    `| \`${e.code}\` | ${e.status} | ${e.retryable ? "yes" : "no"} | ${e.message.replace(/\|/g, "\\|")} |`
  );
  return ["| Code | HTTP | Retryable | Default message |", "|---|---|---|---|", ...rows].join("\n");
}

// ---------------------------------------------------------------------------
// Pages.
// ---------------------------------------------------------------------------

/** One level down, so the bundle has a single H1. */
function demote(markdown: string): string {
  return markdown.replace(/^(#{1,5}) /gm, "#$1 ");
}

function normalise(text: string): string {
  return text.replaceAll("\r\n", "\n").trimEnd() + "\n";
}

export interface BundleInputs {
  pages: Map<string, string>;
  routerSource: string;
  policySource: string;
  platformRouterSource: string;
  platformPolicySource: string;
  errorsSource: string;
  eventsSource: string;
  contract: Any;
}

export async function readInputs(): Promise<BundleInputs> {
  const pages = new Map<string, string>();
  const present = new Set<string>();
  for await (const entry of Deno.readDir(DEV_DIR)) {
    if (entry.isFile && (entry.name.endsWith(".md") || entry.name.endsWith(".txt"))) present.add(entry.name);
  }
  for (const name of PAGE_ORDER) {
    if (!present.has(name)) throw new Error(`docs/developer/${name} is in PAGE_ORDER but missing on disk`);
    pages.set(name, normalise(await Deno.readTextFile(new URL(name, DEV_DIR))));
  }
  // The inventory guard: a page nobody listed is a page nobody hands over.
  const unlisted = [...present].filter((n) => !PAGE_ORDER.includes(n as Any) && !GENERATED.includes(n as Any));
  if (unlisted.length) {
    throw new Error(`docs/developer/ has pages not in PAGE_ORDER (add them, in reading order): ${unlisted.join(", ")}`);
  }
  // A Windows checkout under autocrlf hands back CRLF; every parser below is
  // written against LF.
  const read = async (p: string) => (await Deno.readTextFile(new URL(p, ROOT))).replaceAll("\r\n", "\n");
  return {
    pages,
    routerSource: await read("supabase/functions/partner-api/v1/router.ts"),
    policySource: await read("supabase/functions/partner-api/router.ts"),
    platformRouterSource: await read("supabase/functions/partner-api/platform/router.ts"),
    platformPolicySource: await read("supabase/functions/partner-api/platform/policy.ts"),
    errorsSource: await read("supabase/functions/partner-api/v1/errors.ts"),
    eventsSource: await read("supabase/functions/_shared/partnerWebhookEvents.ts"),
    contract: parse(await read("docs/api/openapi.yaml")),
  };
}

export function buildContext(inputs: BundleInputs): string {
  const routes = [...parseRoutes(inputs.routerSource), ...parseRoutes(inputs.platformRouterSource)];
  const scopes = new Map([...parseActionScopes(inputs.policySource), ...parseActionScopes(inputs.platformPolicySource, "PLATFORM_ACTION_SCOPES")]);
  const policy = parseErrorPolicy(inputs.errorsSource);
  const events = parseEvents(inputs.eventsSource);
  const summaries = summariesFromContract(inputs.contract);
  const version = String(inputs.contract?.info?.version ?? "unknown");

  const head = `# Postora Partner API v1 — agent hand-off bundle

Contract version ${version}. Base URL \`${BASE_URL}\`; every route below is under \`/v1\`.

This file is GENERATED by \`scripts/generate-agent-context.ts\` from the pages under \`docs/developer/\`, the route and policy tables in the code, and \`docs/api/openapi.yaml\`. Do not edit it; edit the source and regenerate. Give it, whole, to the agent that implements your integration, together with \`docs/api/openapi.yaml\` (the machine contract to generate a client from) and, for a human, the Postman collection under \`docs/api/postman/\`.

**How to use this file as an agent:** read "Rules and traps" first and treat each as a hard requirement; use the endpoint table to find what exists; use the error table to decide retries; use the pages for the why. Generate request and response types from \`openapi.yaml\`, not from this prose.

`;

  const facts = `## Quick facts

- **Workspace auth:** header \`x-postora-key: pk_live_…\` (production) or \`pk_test_…\` (staging).
- **Platform auth:** \`Authorization: Bearer pl_live_…\` (production) or \`pl_test_…\` (staging); \`x-postora-key\` also accepted. Platform credentials provision workspaces and issue/revoke their workspace keys; they cannot access workspace resources.
- **Success envelope:** the resource, or \`{ "data": [...], "next_cursor": string | null }\` for listings; \`request_id\` in every body.
- **Error envelope:** \`{ "error": { "code", "message", "retryable", "request_id", "details"? } }\`.
- **Correlation:** \`X-Postora-Request-Id\` on every response.
- **Rate limit headers:** \`X-RateLimit-Limit\`, \`X-RateLimit-Remaining\`, \`X-RateLimit-Reset\`; \`Retry-After\` on 429 when computed.
- **Certified webhook events:** ${events.map((e) => `\`${e}\``).join(", ")}.

## Endpoints (served today)

Derived from both route tables, \`ACTION_SCOPES\` and \`PLATFORM_ACTION_SCOPES\`. "Limiter class" is D7: A = a bounded local read that still answers during a rate-limiter outage; B and C refuse (503 \`limiter_unavailable\`, retryable) because they reach a provider or change state. The legacy template scopes remain capability-pinned.

${endpointTable(routes, scopes, summaries)}

## Error codes

Derived from \`V1_ERROR_POLICY\`. The retry verdict is the \`retryable\` flag, never the status.

${errorTable(policy)}

`;

  const body = [...inputs.pages.entries()]
    .map(([name, text]) => `<!-- docs/developer/${name} -->\n\n${demote(text)}`)
    .join("\n---\n\n");

  return normalise(head + RULES + facts + "---\n\n" + body);
}

export function buildLlmsTxt(inputs: BundleInputs): string {
  const version = String(inputs.contract?.info?.version ?? "unknown");
  const links = [...inputs.pages.keys()].map((name) => {
    const title = inputs.pages.get(name)!.split("\n").find((l) => l.startsWith("# "))?.slice(2) ?? name;
    return `- [${title}](${name})`;
  });
  return normalise(`# Postora Partner API v1

> Machine-to-machine API for sending WhatsApp messages, uploading media, scheduling posts and receiving webhooks on behalf of a Postora workspace. Contract version ${version}. Base URL ${BASE_URL}, routes under /v1, header x-postora-key.

Links below are relative to this file (\`docs/developer/\`). The complete hand-off bundle for an implementing agent is [AGENT-CONTEXT.md](AGENT-CONTEXT.md). The machine contract is [openapi.yaml](../api/openapi.yaml); generate clients from it.

${RULES.replace("## Rules and traps for the implementing agent", "## Rules and traps").trimEnd()}

## Pages

${links.join("\n")}

## Machine-readable

- [OpenAPI 3.1 contract](../api/openapi.yaml)
- [Postman collection and environments](../api/postman/)
`);
}

if (import.meta.main) {
  const inputs = await readInputs();
  const context = buildContext(inputs);
  const llms = buildLlmsTxt(inputs);
  await Deno.writeTextFile(CONTEXT_PATH, context);
  await Deno.writeTextFile(LLMS_PATH, llms);
  console.log(
    `agent-context: wrote ${context.length} chars (${inputs.pages.size} pages) to docs/developer/AGENT-CONTEXT.md and llms.txt`,
  );
}
