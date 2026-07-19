# Postora n8n Webhooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release `n8n-nodes-postora` 1.1.14 with SSRF-safe Postora webhook management, media lookup, and a Postora event trigger.

**Architecture:** Reuse the existing webhook persistence and REST routes. Centralize webhook-target validation in a Deno shared module used by both `n8n-api` registration/test delivery and `process-post` status delivery. Extend the existing action node and add a separate webhook-backed trigger node, then synchronize the standalone and vendored copies.

**Tech Stack:** Deno Edge Functions, Supabase JS, TypeScript, n8n Workflow API, Jest, npm, GitHub Releases.

---

## File Structure

- `supabase/functions/_shared/webhookSecurity.ts`: HTTPS-only webhook target parsing and private/reserved-host rejection.
- `supabase/functions/_shared/webhookSecurity.test.ts`: Deno tests for public and blocked targets.
- `supabase/functions/n8n-api/index.ts`: Apply shared validation to webhook registration and manual test delivery.
- `supabase/functions/process-post/index.ts`: Validate registered and per-request targets before any status notification fetch.
- `F:\N8N\Postora-n8n-community-node\nodes\Postora\Postora.node.ts`: Add Webhook operations and Media Get.
- `F:\N8N\Postora-n8n-community-node\nodes\PostoraTrigger\PostoraTrigger.node.ts`: Receive Postora webhook payloads and register/delete lifecycle subscriptions.
- `F:\N8N\Postora-n8n-community-node\__tests__\Postora.node.test.ts`: Action-node behavior tests.
- `F:\N8N\Postora-n8n-community-node\__tests__\PostoraTrigger.node.test.ts`: Trigger request and lifecycle behavior tests.
- `F:\N8N\Postora-n8n-community-node\package.json`: Version, node manifest, and trigger build output entry.
- `F:\N8N\Postora-n8n-community-node\README.md`: Document the new operations and trigger setup.
- Matching paths under `F:\Postora_new\Postora-n8n-community-node`: Vendored mirror of every standalone node change, including `dist`.

### Task 1: Secure Backend Webhook Targets

**Files:**
- Create: `supabase/functions/_shared/webhookSecurity.ts`
- Create: `supabase/functions/_shared/webhookSecurity.test.ts`
- Modify: `supabase/functions/n8n-api/index.ts:1370-1562`
- Modify: `supabase/functions/process-post/index.ts:730-829`

- [ ] **Step 1: Write failing URL-validation tests**

```ts
import { assertSafeWebhookUrl } from "./webhookSecurity.ts";
import { assertThrows } from "jsr:@std/assert";

Deno.test("accepts a public HTTPS webhook", () => {
  assertSafeWebhookUrl("https://hooks.example.com/postora");
});

for (const unsafeUrl of [
  "http://hooks.example.com/postora",
  "https://localhost/hooks",
  "https://127.0.0.1/hooks",
  "https://169.254.169.254/latest/meta-data",
  "https://[::1]/hooks",
]) {
  Deno.test(`rejects unsafe webhook target ${unsafeUrl}`, () => {
    assertThrows(() => assertSafeWebhookUrl(unsafeUrl));
  });
}
```

- [ ] **Step 2: Verify the tests fail because the module is absent**

Run: `deno test supabase/functions/_shared/webhookSecurity.test.ts`

Expected: failure resolving `webhookSecurity.ts`.

- [ ] **Step 3: Implement the minimal shared validator**

```ts
export function assertSafeWebhookUrl(rawUrl: string): URL {
  const target = new URL(rawUrl);
  if (target.protocol !== "https:") throw new Error("Webhook URLs must use HTTPS.");
  if (isPrivateOrReservedHost(target.hostname)) {
    throw new Error("Webhook URL host is private, loopback, link-local, multicast, or reserved.");
  }
  return target;
}
```

Implement `isPrivateOrReservedHost` for localhost names, IPv4 loopback/private/link-local/multicast/reserved ranges, and IPv6 loopback, unique-local, and link-local ranges. Keep the validation literal-host based and document that DNS rebinding is not solved here.

- [ ] **Step 4: Apply the validator at every webhook fetch boundary**

```ts
try {
  assertSafeWebhookUrl(webhook_url);
} catch (error) {
  return apiError(req, error.message, 400, "UNSAFE_WEBHOOK_URL");
}
```

Use this before storage and test delivery in `n8n-api`. In `process-post`, validate `perRequestWebhook.url` and each stored `webhook.webhook_url` immediately before `fetch`; log and skip invalid legacy values rather than sending to them.

- [ ] **Step 5: Verify backend tests pass**

Run: `deno test supabase/functions/_shared/webhookSecurity.test.ts`

Expected: all public and blocked-target tests pass.

- [ ] **Step 6: Commit the backend security change**

```bash
git add supabase/functions/_shared/webhookSecurity.ts supabase/functions/_shared/webhookSecurity.test.ts supabase/functions/n8n-api/index.ts supabase/functions/process-post/index.ts
git commit -m "fix(webhooks): block unsafe delivery targets"
```

### Task 2: Add Webhook Actions And Media Get

**Files:**
- Modify: `F:\N8N\Postora-n8n-community-node\nodes\Postora\Postora.node.ts`
- Modify: `F:\N8N\Postora-n8n-community-node\__tests__\Postora.node.test.ts`

- [ ] **Step 1: Write failing action-node tests**

```ts
it("registers a webhook with its subscribed events", async () => {
  const { callLog } = await run({
    params: {
      resource: "webhook", operation: "register",
      webhookUrl: "https://n8n.example/webhook/postora",
      webhookEvents: ["post.completed", "post.failed"],
    },
  });
  expect(callLog[0]).toMatchObject({
    method: "POST", url: "https://example.test/api/v1/webhooks",
    body: { webhook_url: "https://n8n.example/webhook/postora", events: ["post.completed", "post.failed"] },
  });
});

it("gets an owned media record by UUID", async () => {
  const { callLog } = await run({
    params: { resource: "media", operation: "get", mediaId: "11111111-1111-4111-8111-111111111111" },
  });
  expect(callLog[0]).toMatchObject({ method: "GET", url: "https://example.test/api/v1/media/11111111-1111-4111-8111-111111111111" });
});
```

- [ ] **Step 2: Run the focused Jest suite and verify failure**

Run: `npm test -- --runInBand __tests__/Postora.node.test.ts`

Expected: failures because `webhook` and `media:get` routing do not exist.

- [ ] **Step 3: Add properties and execution branches**

Add `Webhook` to the resource selector. Define Register, List, Test, and Delete operations, with `webhookUrl`, `webhookEvents`, and `webhookId` shown only for the appropriate operations. Add `Get` beside Media Upload with a UUID `mediaId` field. Add explicit authenticated requests:

```ts
{ method: "POST", url: `${baseUrl}/api/v1/webhooks`, body: { webhook_url: webhookUrl, events: webhookEvents }, json: true }
{ method: "GET", url: `${baseUrl}/api/v1/webhooks`, json: true }
{ method: "POST", url: `${baseUrl}/api/v1/webhooks/test`, body: { webhook_url: webhookUrl }, json: true }
{ method: "DELETE", url: `${baseUrl}/api/v1/webhooks/${webhookId}`, json: true }
{ method: "GET", url: `${baseUrl}/api/v1/media/${mediaId}`, json: true }
```

Validate Media Get IDs locally with the existing `isValidUuid` helper before requesting the API. Do not alter saved names or behavior for existing resources.

- [ ] **Step 4: Run action-node tests and type-check**

Run: `npx tsc --noEmit`

Expected: exit code 0.

Run: `npm test -- --runInBand __tests__/Postora.node.test.ts`

Expected: all action-node tests pass.

### Task 3: Add The Postora Trigger

**Files:**
- Create: `F:\N8N\Postora-n8n-community-node\nodes\PostoraTrigger\PostoraTrigger.node.ts`
- Create: `F:\N8N\Postora-n8n-community-node\__tests__\PostoraTrigger.node.test.ts`
- Modify: `F:\N8N\Postora-n8n-community-node\package.json`

- [ ] **Step 1: Write failing trigger tests**

```ts
it("registers n8n's production callback URL on activation", async () => {
  await trigger.webhookMethods.default.create.call(hookContext);
  expect(request).toHaveBeenCalledWith(expect.objectContaining({
    method: "POST",
    url: "https://example.test/api/v1/webhooks",
    body: { webhook_url: "https://n8n.example/webhook/postora", events: ["post.completed"] },
  }));
});

it("emits a received Postora payload", async () => {
  const response = await trigger.webhook.call(webhookContext);
  expect(response.workflowData).toEqual([[{ json: { event: "post.completed", data: { post: { id: "post-1" } } } }]]);
});
```

- [ ] **Step 2: Run trigger tests and verify failure**

Run: `npm test -- --runInBand __tests__/PostoraTrigger.node.test.ts`

Expected: failure resolving `PostoraTrigger.node.ts`.

- [ ] **Step 3: Implement the trigger using n8n webhook lifecycle APIs**

Declare a trigger node with group `trigger`, the `postoraApi` credential, an event multi-select, and a default POST webhook. Implement `webhookMethods.default.create` with `this.getNodeWebhookUrl("default")`, register that URL through `/api/v1/webhooks`, and persist only the returned webhook ID in static node data. Implement `delete` by reading the saved ID and calling `DELETE /api/v1/webhooks/:id`.

Implement `webhook` by returning the request body as `workflowData` and a `200` response. Require a POST webhook route, but do not introduce fake signature verification because registered n8n webhooks currently have no shared signing secret.

Add `dist/nodes/PostoraTrigger/PostoraTrigger.node.js` to the `n8n.nodes` manifest only after the TypeScript source compiles.

- [ ] **Step 4: Run trigger tests and full standalone checks**

Run: `npx tsc --noEmit`

Expected: exit code 0.

Run: `npm test -- --runInBand`

Expected: all Jest tests pass.

- [ ] **Step 5: Commit the standalone node feature**

```bash
git add nodes/Postora/Postora.node.ts nodes/PostoraTrigger/PostoraTrigger.node.ts __tests__/Postora.node.test.ts __tests__/PostoraTrigger.node.test.ts package.json
git commit -m "feat: add Postora webhook trigger"
```

### Task 4: Build, Document, And Synchronize Both Copies

**Files:**
- Modify: `F:\N8N\Postora-n8n-community-node\README.md`
- Modify: `F:\N8N\Postora-n8n-community-node\package.json`
- Modify: `F:\N8N\Postora-n8n-community-node\dist\**`
- Mirror all changed standalone node files to: `F:\Postora_new\Postora-n8n-community-node\**`

- [ ] **Step 1: Document the operations and trigger behavior**

Add `Webhook` Register/List/Test/Delete and `Media Get` to the operations list. Add a Trigger example that explains activation registers n8n's callback URL, `post.completed`/`post.failed` event filtering, and deactivation removes the subscription. State that callback URLs must be public HTTPS endpoints and that private/local targets are rejected.

- [ ] **Step 2: Bump the version and build the standalone package**

Set `package.json` version to `1.1.14`.

Run: `npm run build`

Expected: exit code 0 and regenerated `dist` output for both Postora nodes.

- [ ] **Step 3: Copy every changed package artifact to the vendored copy**

Mirror `nodes/`, `__tests__/`, `README.md`, `package.json`, and `dist/` from `F:\N8N\Postora-n8n-community-node` to `F:\Postora_new\Postora-n8n-community-node`. Verify binary/icon artifacts and generated JavaScript are included.

- [ ] **Step 4: Verify identical package content and the vendored checks**

Run: `npx tsc --noEmit`

Expected: exit code 0 in both copies.

Run: `npm test -- --runInBand`

Expected: all Jest tests pass in both copies.

Compare the synchronized paths with `git diff --no-index` or `robocopy /L` and resolve every difference except each repository's `.git` metadata.

### Task 5: Deploy And Release Version 1.1.14

**Files:**
- Modify: generated standalone and vendored `dist/**`
- Modify: `supabase/functions/_shared/webhookSecurity.ts`
- Modify: `supabase/functions/n8n-api/index.ts`
- Modify: `supabase/functions/process-post/index.ts`

- [ ] **Step 1: Run final verification in the standalone repository**

Run: `npx tsc --noEmit`

Run: `npm test -- --runInBand`

Run: `npm run build`

Expected: every command exits with code 0.

- [ ] **Step 2: Commit and push the standalone release source**

```bash
git add nodes __tests__ README.md package.json dist
git commit -m "release: n8n-nodes-postora 1.1.14"
git push origin main
```

- [ ] **Step 3: Create and verify the GitHub release**

```bash
gh release create v1.1.14 --title "v1.1.14" --generate-notes
```

Wait for the publish workflow, then run:

```bash
npm view n8n-nodes-postora version
```

Expected: `1.1.14`.

- [ ] **Step 4: Deploy changed edge functions to the self-hosted stack**

On Contabo, use the current source checkout at `/etc/dokploy/applications/postorasupabase-postoraprojetc-wz3k5t/code`, copy `n8n-api`, `process-post`, and `_shared` files into `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions`, compare SHA256 values, then run `docker compose up -d --no-deps functions` from `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/code`.

- [ ] **Step 5: Commit and push scoped Postora repository changes**

```bash
git add supabase/functions/_shared/webhookSecurity.ts supabase/functions/_shared/webhookSecurity.test.ts supabase/functions/n8n-api/index.ts supabase/functions/process-post/index.ts Postora-n8n-community-node docs/superpowers/specs/2026-07-17-postora-n8n-webhooks-design.md docs/superpowers/plans/2026-07-17-postora-n8n-webhooks.md
git commit -m "feat(n8n): add webhook automation"
git push
```

## Self-Review

- Spec coverage: Tasks 1-3 cover SSRF hardening, Webhook actions, Media Get, and the Trigger. Task 4 covers documentation, build output, and synchronization. Task 5 covers the edge deployment, release, and npm verification.
- Placeholder scan: no TODOs or unspecified validation behavior remain.
- Type consistency: action-node routes match the existing `/api/v1/webhooks` and `/api/v1/media/:id` routes; trigger lifecycle methods match the installed n8n Workflow `webhookMethods` and webhook type contracts.
