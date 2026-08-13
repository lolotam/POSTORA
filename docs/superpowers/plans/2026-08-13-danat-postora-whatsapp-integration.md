# Danat ↔ Postora WhatsApp Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Danat's WhatsApp notifications off its own Meta Cloud API credentials and onto Postora's partner API, so every tenant message lands in Postora's shared inbox and CRM, and inbound replies reach Danat's notification log.

**Architecture:** Danat already has a clean provider seam — `sendWithWhatsApp` in `src/lib/providers/whatsapp.ts`, selected from the `provider_configs` table by `dispatchNotification`. This plan adds a *fourth* provider alongside it rather than editing it, so the direct-to-Meta path stays intact as a rollback. A new public route receives Postora's signed callbacks.

**Tech Stack:** TanStack Start + React 19, TypeScript, Supabase (Postgres), Vitest, Bun.

**Spec:** `F:\Postora_new\docs\superpowers\specs\2026-08-13-postora-whatsapp-partner-api-design.md` (§13 is the phased integration guide this plan implements)

---

## ⚠️ This plan runs in a DIFFERENT REPOSITORY

**All paths here are relative to `F:\Danat-Mostakbal`, not the Postora repo.**

| | Postora | Danat |
|---|---|---|
| Repo | `F:\Postora_new` | `F:\Danat-Mostakbal` |
| Server | Contabo `86.48.2.205` | its own host |
| Access MCP | `ssh-contabo-mcp` | `ssh-danatfuture-mcp` |
| This plan touches | nothing | everything |

The two systems share no database and no network. The typed HTTP contract is the
entire interface between them.

## Plan dependency — read before starting

This plan **cannot be completed** until the Postora-side plan is deployed:
`F:\Postora_new\docs\superpowers\plans\2026-08-13-whatsapp-partner-api-foundation.md`

| Needs from Postora | Which Postora task | Blocks Danat task here |
|---|---|---|
| `partner-api` deployed with `send_template` | Tasks 1-7 | Task 3 onward |
| A minted key pinned to Danat's WhatsApp account | Task 8 | Task 3 onward |
| Signed inbound webhooks (`message.received`, `message.status`) | **Postora Plan 2** — not yet written | Task 5 |

Tasks 1 and 2 are pure Danat work and can start immediately, in parallel with the
Postora build.

## Global Constraints

- **Do not modify `src/lib/providers/whatsapp.ts`.** It stays as the rollback path.
  The new provider is a separate file.
- **`NotificationProvider` is a database enum**, currently
  `"smtp" | "resend" | "whatsapp_cloud_api" | "twilio"`
  (`src/integrations/supabase/database.types.ts:105`). Adding a provider needs a
  migration *and* regenerated types — it is not a TypeScript-only change.
- **`ProviderResult` is `{ messageId: string }`** (`src/lib/providers/types.ts`).
  Do not widen it; `dispatchNotification` stores it as `provider_message_id`.
- **Secrets are indirected.** `requiredEnv(config, key)` reads an environment
  variable *name* from the provider config row, then reads `process.env` for it.
  Follow that pattern; never hardcode an env var name in provider code.
- **Recipients must already be international.** `toInternationalDigits` refuses a
  bare local number rather than guessing a country code. Keep that behaviour.
- **Business-initiated messages require an approved template.** Danat's existing
  provider already refuses to send without one; the new one must too.
- **Test conventions:** Vitest with `vi.stubGlobal("fetch", vi.fn())` and
  `vi.stubEnv(...)`, mirroring `src/lib/providers/whatsapp.test.ts`.
- **Gates:** `bun run typecheck`, `bun run lint`, `bun run test`.
- Commit scoped to the task's files. Never commit `.env*` or the partner key.

---

### Task 1: Add the `postora` provider to the enum and config

**Files:**
- Create: `db/migrations/<timestamp>_add_postora_provider.sql` (match the existing migration naming in `db/`)
- Modify: `src/integrations/supabase/database.types.ts` (regenerated, not hand-edited)

**Interfaces:**
- Produces: `NotificationProvider` gains `"postora"`; a `provider_configs` row keyed `postora`.

- [ ] **Step 1: Write the migration**

```sql
-- Danat sends WhatsApp through Postora's partner API rather than its own Meta
-- credentials, so Postora's inbox and CRM see every tenant conversation.
-- The existing whatsapp_cloud_api provider is deliberately left in place as a
-- rollback path.
ALTER TYPE notification_providers ADD VALUE IF NOT EXISTS 'postora';
```

`ALTER TYPE ... ADD VALUE` cannot run inside a transaction block in older
PostgreSQL, and cannot be used in the same transaction as a statement that
references the new value. Keep this migration to that single statement.

- [ ] **Step 2: Apply it and confirm the value exists**

```bash
# via ssh-danatfuture-mcp, against Danat's database
psql "$DATABASE_URL" -c "ALTER TYPE notification_providers ADD VALUE IF NOT EXISTS 'postora';"
psql "$DATABASE_URL" -t -c "SELECT unnest(enum_range(NULL::notification_providers));"
```

Expected: the list now includes `postora`.

- [ ] **Step 3: Regenerate types**

Run: `bun run gen:types`
Expected: `src/integrations/supabase/database.types.ts:105` becomes
`export type NotificationProvider = "smtp" | "resend" | "whatsapp_cloud_api" | "twilio" | "postora";`

Do not hand-edit this file — it is generated, and a manual edit will be
overwritten by the next run.

- [ ] **Step 4: Insert the provider config row (disabled for now)**

```sql
INSERT INTO provider_configs (provider, is_enabled, config)
VALUES ('postora', false, jsonb_build_object(
  'api_base',        'https://api.postora.cloud/functions/v1/partner-api',
  'api_key_env',     'POSTORA_API_KEY',
  'webhook_secret_env', 'POSTORA_WEBHOOK_SECRET'
));
```

`is_enabled: false` deliberately — nothing routes here until Task 4 cuts over.
Note the config stores **environment variable names**, not secrets, matching how
`requiredEnv` resolves `secret_env` for the existing providers.

- [ ] **Step 5: Verify the app still builds against the new enum**

Run: `bun run typecheck`
Expected: no errors. A widened union is additive, so nothing should break; if
something does, it is an exhaustive `switch` that now needs a `postora` case —
fix it rather than adding a `default`.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(notifications): add postora as a notification provider" -- db/migrations src/integrations/supabase/database.types.ts
```

---

### Task 2: The Postora provider

**Files:**
- Create: `src/lib/providers/postora.ts`
- Create: `src/lib/providers/postora.test.ts`

**Interfaces:**
- Consumes: `WhatsAppProviderMessage`, `ProviderResult`, `configValue`, `requiredEnv`, `toInternationalDigits` from `src/lib/providers/types.ts`; `MetaTemplateBinding` from `src/lib/providers/whatsappTemplateBinding.ts`.
- Produces: `sendWithPostora(message: WhatsAppProviderMessage, idempotencyKey: string): Promise<ProviderResult>`

Note the **extra parameter**: unlike `sendWithWhatsApp`, this provider needs an
idempotency key from the caller. Task 3 supplies it.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/providers/postora.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendWithPostora } from "./postora";

const CONFIG = {
  api_base: "https://api.postora.cloud/functions/v1/partner-api",
  api_key_env: "TEST_POSTORA_KEY",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

function lastCall() {
  const mock = vi.mocked(globalThis.fetch);
  const [url, init] = mock.mock.calls[mock.mock.calls.length - 1] as [string, RequestInit];
  return { url, init, body: JSON.parse(String(init.body)) };
}

const template = {
  languageCode: "ar",
  params: ["أحمد", "150.000 KWD"],
  templateName: "danat_receipt_ar",
};

describe("sendWithPostora", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubEnv("TEST_POSTORA_KEY", "pk_live_test");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("posts send_template with the key and idempotency headers", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse(200, { success: true, message_id: "wamid.ABC", state: "accepted_by_meta" }),
    );

    const result = await sendWithPostora(
      { config: CONFIG, from: null, template, to: "+96512345678" },
      "notification-row-1",
    );

    expect(result.messageId).toBe("wamid.ABC");

    const { url, init, body } = lastCall();
    expect(url).toBe(CONFIG.api_base);
    expect((init.headers as Record<string, string>)["X-Postora-Key"]).toBe("pk_live_test");
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("notification-row-1");
    expect(body.action).toBe("send_template");
    expect(body.template_name).toBe("danat_receipt_ar");
    expect(body.template_language).toBe("ar");
    expect(body.recipient_phone).toBe("96512345678");
  });

  it("sends template parameters as ordered body components", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse(200, { success: true, message_id: "wamid.ABC" }),
    );

    await sendWithPostora({ config: CONFIG, from: null, template, to: "+96512345678" }, "n-1");

    const { body } = lastCall();
    expect(body.template_components).toEqual([
      { type: "body", parameters: [{ type: "text", text: "أحمد" }, { type: "text", text: "150.000 KWD" }] },
    ]);
  });

  it("refuses to send without an approved template", async () => {
    await expect(
      sendWithPostora({ config: CONFIG, from: null, template: null, to: "+96512345678" }, "n-1"),
    ).rejects.toThrow(/template/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("surfaces a typed Postora error code in the thrown message", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse(422, {
        success: false,
        error: { code: "template_not_approved", message: "Template rejected by Meta", retryable: false },
        request_id: "req-1",
      }),
    );

    await expect(
      sendWithPostora({ config: CONFIG, from: null, template, to: "+96512345678" }, "n-1"),
    ).rejects.toThrow(/template_not_approved/);
  });

  it("includes the Postora request id so failures can be correlated", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse(500, {
        success: false,
        error: { code: "internal_error", message: "boom", retryable: true },
        request_id: "req-42",
      }),
    );

    await expect(
      sendWithPostora({ config: CONFIG, from: null, template, to: "+96512345678" }, "n-1"),
    ).rejects.toThrow(/req-42/);
  });

  it("treats an indeterminate send as non-retryable", async () => {
    // The message may already have reached the tenant. Retrying would send a
    // second copy, so this must not look like an ordinary failure.
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse(409, {
        success: false,
        error: { code: "idempotency_indeterminate", message: "may have been delivered", retryable: false },
        request_id: "req-9",
      }),
    );

    await expect(
      sendWithPostora({ config: CONFIG, from: null, template, to: "+96512345678" }, "n-1"),
    ).rejects.toMatchObject({ retryable: false });
  });

  it("refuses a recipient that is not in international format", async () => {
    await expect(
      sendWithPostora({ config: CONFIG, from: null, template, to: "50123456" }, "n-1"),
    ).rejects.toThrow(/international/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test src/lib/providers/postora.test.ts`
Expected: FAIL — cannot resolve `./postora`.

- [ ] **Step 3: Write the provider**

Create `src/lib/providers/postora.ts`:

```ts
import { z } from "zod";

import type { ProviderResult, WhatsAppProviderMessage } from "@/lib/providers/types";
import { configValue, requiredEnv, toInternationalDigits } from "@/lib/providers/types";

const successSchema = z.object({
  message_id: z.string(),
  request_id: z.string().optional(),
});

const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean().optional(),
    details: z.unknown().optional(),
  }),
  request_id: z.string().optional(),
});

/**
 * A Postora failure that carries the partner API's typed contract.
 *
 * `retryable` matters more than the message: the drain job must not re-send an
 * `idempotency_indeterminate` result, because that message may already have
 * reached the tenant.
 */
export class PostoraProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "PostoraProviderError";
  }
}

function describeFailure(status: number, raw: string): PostoraProviderError {
  try {
    const parsed = errorSchema.parse(JSON.parse(raw));
    const rid = parsed.request_id ? ` [request ${parsed.request_id}]` : "";
    return new PostoraProviderError(
      `Postora rejected the message (${status}) [${parsed.error.code}]${rid}: ${parsed.error.message}`,
      parsed.error.code,
      parsed.error.retryable ?? false,
      parsed.request_id,
    );
  } catch {
    // A non-JSON body means something between us and the function answered —
    // a gateway or proxy. Treat it as retryable; nothing was confirmed sent.
    return new PostoraProviderError(
      `Postora request failed (${status}): ${raw.slice(0, 200) || "no response body"}`,
      "unknown_error",
      true,
    );
  }
}

/**
 * Send an approved WhatsApp template through Postora's partner API.
 *
 * Deliberately NOT a drop-in replacement for sendWithWhatsApp: it takes an
 * idempotency key, because Postora requires one on every send and the whole
 * point is that Danat's own retry loop cannot double-message a tenant.
 */
export async function sendWithPostora(
  message: WhatsAppProviderMessage,
  idempotencyKey: string,
): Promise<ProviderResult> {
  const apiBase = configValue(message.config, "api_base");
  if (!apiBase) throw new Error("Postora provider config is missing api_base.");
  const apiKey = requiredEnv(message.config, "api_key_env");

  if (!idempotencyKey) {
    throw new Error("Postora sends require an idempotency key from the caller.");
  }

  // Validate the recipient BEFORE the template check so a malformed number
  // fails the same way it does on the direct-to-Meta path.
  const to = toInternationalDigits(message.to);

  const template = message.template ?? null;
  if (!template) {
    throw new Error(
      "Postora requires an approved template. No provider template mapping was resolved.",
    );
  }

  const response = await fetch(apiBase, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Postora-Key": apiKey,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      action: "send_template",
      recipient_phone: to,
      template_name: template.templateName,
      template_language: template.languageCode,
      template_components: template.params.length
        ? [{
            type: "body",
            parameters: template.params.map((text) => ({ type: "text", text })),
          }]
        : [],
    }),
  });

  const raw = await response.text();
  if (!response.ok) throw describeFailure(response.status, raw);

  const parsed = successSchema.parse(JSON.parse(raw));
  return { messageId: parsed.message_id };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test src/lib/providers/postora.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(notifications): add the Postora WhatsApp provider" -- src/lib/providers/postora.ts src/lib/providers/postora.test.ts
```

---

### Task 3: Route WhatsApp sends through Postora when it is the enabled provider

**Files:**
- Modify: `src/fns/dispatchNotification.ts` (the WhatsApp branch, around line 247)
- Modify: `src/fns/dispatchNotification.test.ts`

**Interfaces:**
- Consumes: `sendWithPostora` (Task 2).
- Produces: no new exports; `dispatchNotification` gains a `postora` branch.

- [ ] **Step 1: Read the existing WhatsApp branch before changing it**

Run: `sed -n '240,300p' src/fns/dispatchNotification.ts`

Note exactly how `selectedProvider` is set and how `sendWithTwilio` versus
`sendWithWhatsApp` are chosen — the new branch must follow the same shape, and
the notification row's `id` is what becomes the idempotency key.

- [ ] **Step 2: Write the failing test**

Add to `src/fns/dispatchNotification.test.ts`:

```ts
it("sends through Postora when postora is the enabled WhatsApp provider", async () => {
  // The notification row id is the idempotency key: the drain job retries the
  // same row, so the same key reaches Postora and the tenant is messaged once.
  const sent = await dispatchTestNotification({
    provider: "postora",
    notificationId: "11111111-1111-1111-1111-111111111111",
  });

  expect(sent.idempotencyKey).toBe("11111111-1111-1111-1111-111111111111");
  expect(sent.provider).toBe("postora");
});
```

Adapt the helper name to whatever the existing suite uses — read the file first
and follow its established fixture pattern rather than inventing one.

- [ ] **Step 3: Run it to verify it fails**

Run: `bun run test src/fns/dispatchNotification.test.ts`
Expected: FAIL — no `postora` branch, so the provider is never selected.

- [ ] **Step 4: Add the branch**

In the WhatsApp section of `dispatchNotification.ts`, alongside the existing
Twilio and Cloud API branches:

```ts
        } else if (config.provider === "postora") {
          // The notification row id, not a random uuid: the drain job retries
          // the same row, so the same key reaches Postora and it recognises
          // the duplicate instead of sending the tenant a second message.
          result = await sendWithPostora(whatsappMessage, notification.id);
```

And add the import beside the other providers at the top of the file:

```ts
import { sendWithPostora } from "@/lib/providers/postora";
```

- [ ] **Step 5: Run the tests**

Run: `bun run test src/fns/dispatchNotification.test.ts`
Expected: PASS, including every pre-existing test — the other providers must be
untouched.

- [ ] **Step 6: Run the full gates**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(notifications): dispatch WhatsApp through Postora when enabled" -- src/fns/dispatchNotification.ts src/fns/dispatchNotification.test.ts
```

---

### Task 4: Stop the drain job from re-sending indeterminate results

**Files:**
- Modify: `src/fns/notificationDrainJob.ts`
- Modify: `src/fns/notificationDrainJob.test.ts`

**Interfaces:**
- Consumes: `PostoraProviderError` (Task 2).

**Why this task exists.** `MAX_RETRIES = 3` (`notificationDrainJob.ts:31`) retries any
failed row. But `idempotency_indeterminate` means *Postora does not know whether the
tenant received it*. Postora will refuse the duplicate — the same key returns the
same error forever — so retrying burns all three attempts and ends `failed` for a
message that may have been delivered. Worse, the invoice reminder then looks unsent
to staff.

- [ ] **Step 1: Write the failing test**

```ts
it("does not retry a send that Postora reported as indeterminate", async () => {
  const row = await givenFailedNotification({
    error_code: "idempotency_indeterminate",
    retry_count: 0,
  });

  await runNotificationDrainJob();

  const after = await reloadNotification(row.id);
  // Not retried, and not silently marked failed either — a human must decide.
  expect(after.retry_count).toBe(0);
  expect(after.state).toBe("needs_review");
});
```

Adapt fixture helper names to the existing suite.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run test src/fns/notificationDrainJob.test.ts`
Expected: FAIL — the row is retried like any other failure.

- [ ] **Step 3: Add the guard**

In the retry decision (around line 92), before the `retry_count >= MAX_RETRIES` check:

```ts
      // An indeterminate Postora result may already have reached the tenant.
      // Retrying cannot help — Postora returns the same error for the same
      // idempotency key — and could mislead staff into believing nothing was
      // sent. Park it for a human instead.
      if (row.error_code === "idempotency_indeterminate") {
        await markNeedsReview(row.id);
        continue;
      }
```

If the notifications table has no `error_code` column or `needs_review` state, add
them in a migration in this task — the guard is not optional, and a state that means
"sent status unknown" is genuinely missing from the model.

- [ ] **Step 4: Run the tests**

Run: `bun run test src/fns/notificationDrainJob.test.ts`
Expected: PASS, with existing retry behaviour for ordinary failures unchanged.

- [ ] **Step 5: Commit**

```bash
git commit -m "fix(notifications): park indeterminate sends instead of retrying them" -- src/fns/notificationDrainJob.ts src/fns/notificationDrainJob.test.ts
```

---

### Task 5: Receive Postora's signed webhooks

> **Blocked on Postora Plan 2.** `register_webhook`, the delivery outbox, and the
> `message.received` / `message.status` events do not exist yet. Build this task
> only after that plan ships; the signature scheme below must be confirmed against
> its implementation, not assumed.

**Files:**
- Create: `src/routes/api/public/postora-webhook.ts`
- Create: `src/routes/api/public/postora-webhook.test.ts`

**Interfaces:**
- Produces: `POST /api/public/postora-webhook`

Follow the shape of the existing receiver at
`src/routes/api/public/myfatoorah-webhook.ts`: a thin `createFileRoute` whose
`server.handlers.POST` delegates to a testable function.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { respondToPostoraWebhook } from "./postora-webhook";

async function signedRequest(body: unknown, secret: string, timestamp = "1760000000") {
  const raw = JSON.stringify(body);
  const signature = await hmacHex(secret, `${timestamp}.${raw}`);
  return new Request("https://danat-future.com/api/public/postora-webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-postora-signature": signature,
      "x-postora-timestamp": timestamp,
    },
    body: raw,
  });
}

describe("respondToPostoraWebhook", () => {
  it("rejects a request with no signature", async () => {
    const res = await respondToPostoraWebhook(
      new Request("https://x/", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a tampered body", async () => {
    const req = await signedRequest({ event: "message.received" }, "secret");
    const tampered = new Request(req, { body: '{"event":"message.received","evil":true}' });
    expect((await respondToPostoraWebhook(tampered)).status).toBe(401);
  });

  it("rejects a stale timestamp", async () => {
    const req = await signedRequest({ event: "message.received" }, "secret", "1");
    expect((await respondToPostoraWebhook(req)).status).toBe(401);
  });

  it("accepts a valid delivery and returns 200 quickly", async () => {
    const req = await signedRequest({ event: "message.received", delivery_id: "d1" }, "secret");
    expect((await respondToPostoraWebhook(req)).status).toBe(200);
  });

  it("is idempotent: a redelivered delivery_id is accepted but not double-recorded", async () => {
    // Postora promises at-least-once delivery, so duplicates are expected and
    // must not create two log rows.
    const body = { event: "message.status", delivery_id: "d2", data: { status: "delivered" } };
    await respondToPostoraWebhook(await signedRequest(body, "secret"));
    await respondToPostoraWebhook(await signedRequest(body, "secret"));
    expect(await countDeliveryRows("d2")).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test src/routes/api/public/postora-webhook.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the route**

```ts
import { createFileRoute } from "@tanstack/react-router";

/**
 * Receives Postora's WhatsApp callbacks.
 *
 * This route holds no session — Postora's server posts here directly, so there
 * is no Authorization header to check. The HMAC over `timestamp.rawBody` is
 * what authenticates the request: without it, anyone who learned the URL could
 * fabricate delivery events and corrupt the notification log.
 *
 * Deliveries are at-least-once and unordered, so the handler must be idempotent
 * on `delivery_id` and must never assume event order.
 */
export const Route = createFileRoute("/api/public/postora-webhook")({
  server: {
    handlers: {
      POST: ({ request }) => respondToPostoraWebhook(request),
    },
  },
});
```

Implement `respondToPostoraWebhook` to: read the raw body **before** parsing it
(the signature covers the exact bytes), verify the HMAC in constant time, reject a
timestamp outside a few minutes, upsert on `delivery_id`, and return `200` fast —
doing the work asynchronously if it is slow, because Postora's retry ladder treats a
timeout as a failed delivery.

- [ ] **Step 4: Run the tests**

Run: `bun run test src/routes/api/public/postora-webhook.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Verify Postora can actually reach it**

From the **Postora** host, not a workstation:

```bash
# via ssh-contabo-mcp
curl -s -o /dev/null -w '%{http_code}\n' --max-time 15 -X POST \
  https://danat-future.com/api/public/postora-webhook \
  -H 'content-type: application/json' -d '{}'
```

Expected: `401` — the route exists and rejects an unsigned request. A `404` means
it is not deployed; a Cloudflare challenge page means a WAF rule is blocking
machine POSTs and needs a skip rule for `/api/public/*`.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(notifications): receive signed Postora WhatsApp webhooks" -- src/routes/api/public/postora-webhook.ts src/routes/api/public/postora-webhook.test.ts
```

---

### Task 6: Cut over, verify, and retire the direct Meta credentials

**Files:**
- No code. Configuration and verification only.

- [ ] **Step 1: Confirm every template is approved**

Ask Postora for the approved list rather than trusting local names:

```bash
curl -s -X POST https://api.postora.cloud/functions/v1/partner-api \
  -H "X-Postora-Key: $POSTORA_API_KEY" -H 'content-type: application/json' \
  -d '{"action":"list_templates"}'
```

Every `provider_template_name` Danat maps must appear with `status: APPROVED`.
A missing or `PENDING` name means the cutover will fail for that notification type.

- [ ] **Step 2: Set the secrets on the Danat host**

`POSTORA_API_KEY` and `POSTORA_WEBHOOK_SECRET` in the deployment environment.
Never commit them; never echo them into a log.

- [ ] **Step 3: Enable the provider on ONE notification type first**

```sql
UPDATE provider_configs SET is_enabled = true  WHERE provider = 'postora';
UPDATE provider_configs SET is_enabled = false WHERE provider = 'whatsapp_cloud_api';
```

Do this at a quiet hour. The previous row is left in place, so the rollback is
exactly the inverse of these two statements.

- [ ] **Step 4: Send one real notification and verify both sides**

Trigger one real tenant notification, then confirm:

1. Danat's log records `provider = 'postora'` and a `provider_message_id`.
2. The message **appears in Postora's WhatsApp inbox** with the contact
   auto-created — this is the whole point of the integration, and it is the part
   that silently fails if the conversation upsert regressed.
3. The tenant actually received it.

- [ ] **Step 5: Verify a retry does not double-send**

Force one notification to retry (or replay the same row through the drain job) and
confirm the tenant receives **one** message. Postora should return the replayed
response with `Idempotency-Replayed: true`.

This is the single most important check in the plan: it is the behaviour Danat's
own retry loop would otherwise break.

- [ ] **Step 6: Watch for a full billing cycle before retiring anything**

Leave `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, and `WHATSAPP_WABA_ID`
in place until Postora has carried production traffic without incident. Rolling
back is only cheap while they still exist.

- [ ] **Step 7: Retire the direct credentials**

Once stable, delete those three variables from Danat's environment. Postora now
holds the Meta credentials, which is a security improvement in itself: they live in
one place instead of two.

Leave `src/lib/providers/whatsapp.ts` and its tests in the repository — dead code
that documents a rollback path is worth its weight until the integration has
survived a quarter.

---

## Mandatory gates before every commit

- [ ] `bun run typecheck`
- [ ] `bun run lint`
- [ ] `bun run test`
- [ ] Commit scoped to the task's files. Never `.env*`, never the partner key.

## What this plan deliberately does not do

- **Postora-side work.** All of it lives in
  `F:\Postora_new\docs\superpowers\plans\2026-08-13-whatsapp-partner-api-foundation.md`.
- **A Danat-side inbox UI.** Staff answer tenants from Postora's inbox. Surfacing
  conversations inside Danat's admin would need the `whatsapp:messages.read` scope
  and a UI build; it is an open question in the spec, not a decision.
- **The AI bot** answering tenant questions about contracts and invoices. It needs
  trusted sender identity that Postora's agent runtime cannot yet provide
  (spec §10), and a Danat endpoint that must never accept a tenant identifier from
  conversation text.
- **Free-form (non-template) replies.** Only approved templates in v1.
