import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  INVALID_MODEL_OVERRIDE,
  invalidModelOverrideRefusalLog,
  resolveSandboxModelOverride,
} from "./modelOverride.ts";

const allowedModels = [
  { provider: "openai", model_id: "gpt-5.5" },
  { provider: "openrouter", model_id: "anthropic/claude-sonnet-5" },
] as const;

Deno.test("a dry run uses only the canonical allow-listed model override", async () => {
  for (const [requestedOverride, model] of [
    ["gpt-5.5", { provider: "openai", model: "gpt-5.5" }],
    ["openrouter/anthropic/claude-sonnet-5", { provider: "openrouter", model: "anthropic/claude-sonnet-5" }],
  ] as const) {
    assertEquals(
      await resolveSandboxModelOverride({
        dryRun: true,
        requestedOverride,
        isPlatformAdmin: () => Promise.resolve(true),
        readAllowedModels: () => Promise.resolve(allowedModels),
      }),
      { ok: true, model },
    );
  }
});

Deno.test("a live request never reads or uses model_override, even when malformed", async () => {
  for (const requestedOverride of ["gpt-5.5", "not-allowed", null, { model: "gpt-5.5" }]) {
    assertEquals(
      await resolveSandboxModelOverride({
        dryRun: false,
        requestedOverride,
        isPlatformAdmin: () => Promise.reject(new Error("live request reached the admin check")),
        readAllowedModels: () => Promise.reject(new Error("live request reached the model allow-list")),
      }),
      { ok: true, model: null },
    );
  }
});

Deno.test("an invalid or unlisted dry-run override has a stable refusal code", async () => {
  for (const requestedOverride of ["not-allowed", "", null, 42, "x".repeat(201)]) {
    assertEquals(
      await resolveSandboxModelOverride({
        dryRun: true,
        requestedOverride,
        isPlatformAdmin: () => Promise.resolve(true),
        readAllowedModels: () => Promise.resolve(allowedModels),
      }),
      { ok: false, error: INVALID_MODEL_OVERRIDE },
    );
  }
});

Deno.test("a non-admin sandbox run cannot spend platform credentials through an override", async () => {
  assertEquals(
    await resolveSandboxModelOverride({
      dryRun: true,
      requestedOverride: "gpt-5.5",
      isPlatformAdmin: () => Promise.resolve(false),
      readAllowedModels: () => Promise.resolve(allowedModels),
    }),
    { ok: false, error: INVALID_MODEL_OVERRIDE },
  );
});

Deno.test("the override refusal log carries the stable code without the raw value", () => {
  const leaked = "unlisted-secret-model-value";
  const row = invalidModelOverrideRefusalLog({
    userId: "user-1",
    platform: "whatsapp",
    requestedOverride: leaked,
  });
  assertEquals(row, {
    source: "ai-agent-reply",
    category: "ai",
    level: "info",
    message: "AI agent sandbox refused: invalid model_override",
    user_id: "user-1",
    metadata: {
      platform: "whatsapp",
      error: INVALID_MODEL_OVERRIDE,
      override_length: leaked.length,
    },
  });
  assertEquals(JSON.stringify(row).includes(leaked), false);
});

// The allow-list is read from the database, so its row order is not a contract. An override
// that matches more than one row must not be resolved by the order the rows arrived in:
// an admin dry run would otherwise test -- and pay for -- whichever provider the database
// returned first.
Deno.test("a canonical provider/model_id override wins over a bare model_id row, in any row order", async () => {
  const openRouterRow = { provider: "openrouter", model_id: "openai/gpt-4o" };
  const openAiRow = { provider: "openai", model_id: "gpt-4o" };
  for (const list of [
    [openRouterRow, openAiRow],
    [openAiRow, openRouterRow],
  ]) {
    assertEquals(
      await resolveSandboxModelOverride({
        dryRun: true,
        requestedOverride: "openai/gpt-4o",
        isPlatformAdmin: () => Promise.resolve(true),
        readAllowedModels: () => Promise.resolve(list),
      }),
      { ok: true, model: { provider: "openai", model: "gpt-4o" } },
    );
  }
});

Deno.test("an ambiguous bare model id is refused instead of resolved by the row order", async () => {
  const openAiRow = { provider: "openai", model_id: "gpt-4o" };
  const azureRow = { provider: "azure", model_id: "gpt-4o" };
  for (const list of [
    [openAiRow, azureRow],
    [azureRow, openAiRow],
  ]) {
    assertEquals(
      await resolveSandboxModelOverride({
        dryRun: true,
        requestedOverride: "gpt-4o",
        isPlatformAdmin: () => Promise.resolve(true),
        readAllowedModels: () => Promise.resolve(list),
      }),
      { ok: false, error: INVALID_MODEL_OVERRIDE },
    );
  }
});

Deno.test("the same model allow-listed twice is not ambiguous", async () => {
  assertEquals(
    await resolveSandboxModelOverride({
      dryRun: true,
      requestedOverride: "gpt-4o",
      isPlatformAdmin: () => Promise.resolve(true),
      readAllowedModels: () =>
        Promise.resolve([
          { provider: "openai", model_id: "gpt-4o" },
          { provider: "openai", model_id: "gpt-4o" },
        ]),
    }),
    { ok: true, model: { provider: "openai", model: "gpt-4o" } },
  );
});
