# Agent Setup Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the agent settings form silently saving blanks over a live persona, and scope the Knowledge tab to the account the user has selected.

**Architecture:** Four client-side fixes remove the ways the form can be wrong, and one server-side guard makes a blanking write impossible regardless of which client sends it. The Knowledge tab then filters its source list with the same predicate the retrieval RPCs already use, and renders a source's account by username instead of UUID.

**Tech Stack:** React 18 + TypeScript + Vite, TanStack Query v5, Vitest + Testing Library (`fireEvent`, never `userEvent` — the clipboard shim is unusable in this repo), Deno for Edge Functions.

**Source spec:** `docs/superpowers/specs/2026-08-30-per-account-connectors-design.md` §8, §7.
This plan is **Plan 1 of 3**. It touches no migration and no connector code, so it ships on
its own. Plan 2 covers connector scoping (spec §4, §5), Plan 3 the adapters (spec §6).

---

## Background the engineer needs

On 2026-08-30 a user configured an AI agent for their second Facebook page. The persona did
not save, and the agent never replied. The row in `ai_agent_configs` holds `''` in both
`persona_instructions` and `business_profile_text`, and `is_enabled=false`.

That `''` is the whole diagnosis. `persona_instructions` has **no column default**, so a row
created by a write that omits the field holds `NULL`. Only the Settings form
(`AiAgentManager`) transmits both fields; `AiKnowledgeManager` sends `business_profile_text`
alone. Both being `''` proves the Settings form submitted its blank `defaultConfig` object.

The form was blank because something reset it between the user typing and the user clicking
Save. The provable path: `AiKnowledgeManager` and `AiAgentManager` share one React Query
cache entry, and a write from either invalidates a **prefix** covering every account on the
platform. The Settings query refetches, `config` gets a new identity, and an effect resets
the form to whatever came back.

Two guards already exist and neither catches it. `configLoaded` proves the form matches the
*account*, not that it reflects *user intent* — and the branch that resets the form to
defaults sets `loadedAccountId` in the same breath, so the reset immediately re-satisfies the
guard.

**Do not try to make the client provably correct.** The client is the layer that already
failed twice. Task 1 is the safety net; Tasks 2-5 stop the form being wrong in the first
place. Implement Task 1 first even though it is the least visible.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `supabase/functions/messaging-api/configBlanking.ts` | Pure decision: may this payload blank a stored field? | Create |
| `supabase/functions/messaging-api/configBlanking.test.ts` | Deno tests for the above | Create |
| `supabase/functions/messaging-api/index.ts` | Wire the guard into `ai_upsert_config` | Modify |
| `src/components/messaging/AiAgentManager.tsx` | Reset only on a real account change | Modify |
| `src/hooks/useSocialAccounts.tsx` | Keep previous data so `accountId` cannot flap | Modify |
| `src/hooks/useAiAgentConfig.ts` | Narrow the invalidation key to the exact account | Modify |
| `src/components/messaging/AiKnowledgeManager.tsx` | Same guards as the settings form | Modify |
| `src/lib/knowledgeSourceDisplay.ts` | Render a source's title with the account username | Create |
| `src/lib/__tests__/knowledgeSourceDisplay.test.ts` | Tests for the above | Create |
| `src/components/messaging/__tests__/AiAgentManager.blankSave.test.tsx` | Regression test for the outage | Create |
| `src/components/messaging/__tests__/AiKnowledgeManager.guards.test.tsx` | Guard tests for the second writer | Create |

New logic goes in its own file wherever it is pure. `configBlanking.ts` and
`knowledgeSourceDisplay.ts` exist so their rules can be tested without mounting a component
or booting a server — the pattern `aiConfigScope.ts` and `sweepBudget.ts` already established
in this repo.

---

## Gate commands

Run these exactly. They are the project's real gates.

```bash
npx tsc -b --noEmit                                   # typecheck
bun run test                                          # vitest — NOT `bun test`
deno test --allow-all supabase/functions/messaging-api/   # edge tests
npx eslint src/components/messaging src/hooks src/lib     # lint
```

**Ordering hazard:** run Deno **before** `bun install` if you run both.
`--node-modules-dir=auto` destroys `node_modules` and breaks vitest.

---

## Task 1: Server-side guard against blanking writes

The safety net. A payload that empties a stored field must say it means to.

**Files:**
- Create: `supabase/functions/messaging-api/configBlanking.ts`
- Create: `supabase/functions/messaging-api/configBlanking.test.ts`
- Modify: `supabase/functions/messaging-api/index.ts`

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/messaging-api/configBlanking.test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { blankedFields } from "./configBlanking.ts";

const STORED = {
  persona_instructions: "You are the voice of Eltamlawy Chicks.",
  business_profile_text: "We sell day-old chicks and veterinary medicine.",
};

Deno.test("a payload that empties a stored field is reported", () => {
  assertEquals(
    blankedFields({ persona_instructions: "" }, STORED),
    ["persona_instructions"],
  );
});

Deno.test("both guarded fields are checked, not only the persona", () => {
  // The Knowledge tab writes business_profile_text alone. Naming only the
  // persona here is how the same outage returns through the other tab.
  assertEquals(
    blankedFields({ business_profile_text: "   " }, STORED),
    ["business_profile_text"],
  );
  assertEquals(
    blankedFields({ persona_instructions: "", business_profile_text: "" }, STORED),
    ["persona_instructions", "business_profile_text"],
  );
});

Deno.test("a field the payload does not mention is never blanked", () => {
  // PostgREST only writes columns present in the payload, so an absent key
  // cannot clear anything and must not be reported.
  assertEquals(blankedFields({ is_enabled: true }, STORED), []);
});

Deno.test("writing over an already-empty field is not a blanking", () => {
  assertEquals(
    blankedFields({ persona_instructions: "" }, { persona_instructions: "" }),
    [],
  );
  assertEquals(
    blankedFields({ persona_instructions: "" }, { persona_instructions: null }),
    [],
  );
});

Deno.test("there is nothing to protect when no config exists yet", () => {
  // First-ever save for an account. Refusing this would block config creation
  // exactly as the 2026-08-28 SET NOT NULL did.
  assertEquals(blankedFields({ persona_instructions: "" }, null), []);
});

Deno.test("a non-empty value is never a blanking", () => {
  assertEquals(blankedFields({ persona_instructions: "New voice" }, STORED), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
deno test --allow-all supabase/functions/messaging-api/configBlanking.test.ts
```

Expected: FAIL — `Module not found "./configBlanking.ts"`.

- [ ] **Step 3: Write the implementation**

Create `supabase/functions/messaging-api/configBlanking.ts`:

```ts
// Which stored fields a config payload would empty.
//
// On 2026-08-30 the settings form submitted its blank defaultConfig over a live
// persona, twice, and every client-side guard passed: `configLoaded` proves the
// form matches the ACCOUNT, not that it reflects user intent. This is the check
// that does not depend on the client being right, because the client is the
// layer that failed.

/** Fields whose accidental clearing costs the user real work. */
export const GUARDED_FIELDS = ["persona_instructions", "business_profile_text"] as const;

export type GuardedField = (typeof GUARDED_FIELDS)[number];

const isBlank = (value: unknown): boolean =>
  value === null || value === undefined || (typeof value === "string" && value.trim() === "");

/**
 * The guarded fields this payload would empty.
 *
 * A field absent from `updates` cannot clear anything -- PostgREST writes only
 * the columns present -- so absence is never reported. Emptying an already-empty
 * field is a no-op, and a first save (`stored === null`) has nothing to protect:
 * refusing it would block config creation the way the 2026-08-28 SET NOT NULL did.
 */
export function blankedFields(
  updates: Record<string, unknown>,
  stored: Record<string, unknown> | null,
): GuardedField[] {
  if (!stored) return [];
  return GUARDED_FIELDS.filter(
    (field) => field in updates && isBlank(updates[field]) && !isBlank(stored[field]),
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
deno test --allow-all supabase/functions/messaging-api/configBlanking.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Wire it into `ai_upsert_config`**

In `supabase/functions/messaging-api/index.ts`, add the import beside the other local imports:

```ts
import { blankedFields } from "./configBlanking.ts";
```

In the `ai_upsert_config` branch, find this existing block (around line 532):

```ts
      const writeScope = accountId
        ? { accountId }
        : await resolveConfigWriteAccount(adminClient, user.id, platform);
      if ("error" in writeScope) {
        return jsonResponse({ error: writeScope.error }, 400);
      }
```

Insert the guard **immediately after** it, before the `writeAccountScopedConfig` call:

```ts
      // A payload that empties a stored persona or business profile must say so.
      // The settings form submitted its blank defaults over a live persona twice on
      // 2026-08-30 with every client guard satisfied, so this refusal cannot depend
      // on the client being correct. `confirm_clear: true` is the deliberate path.
      if (body.confirm_clear !== true) {
        const existing = await loadAgentConfigForAccount(adminClient, {
          userId: user.id,
          platform,
          accountId: writeScope.accountId,
        });
        const blanked = blankedFields(updates, existing);
        if (blanked.length > 0) {
          return jsonResponse({
            error:
              `Refusing to clear ${blanked.join(" and ")} for this account. ` +
              `Re-send with confirm_clear to erase it deliberately.`,
            blanked_fields: blanked,
          }, 409);
        }
      }
```

The position is not arbitrary. It must come **after** `writeScope` resolves, because it reads
*that account's* stored config — running it earlier would compare against the wrong row or
against nothing. `loadAgentConfigForAccount` is already imported in this file.

Note `loadAgentConfigForAccount` **throws** on a read error rather than returning null (that
was deliberate — a failed read and an empty read are opposite facts). A throw here surfaces
as a 500 and the save fails loudly, which is the correct outcome: if we cannot read what is
stored, we cannot know whether the write would destroy it.

- [ ] **Step 6: Run the full edge test suite**

```bash
deno test --allow-all supabase/functions/messaging-api/
```

Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/messaging-api/configBlanking.ts \
        supabase/functions/messaging-api/configBlanking.test.ts \
        supabase/functions/messaging-api/index.ts
git commit -m "fix(agent-setup): refuse a config write that silently empties a stored persona"
```

---

## Task 2: Reset the form only on a real account change

**Files:**
- Create: `src/components/messaging/__tests__/AiAgentManager.blankSave.test.tsx`
- Modify: `src/components/messaging/AiAgentManager.tsx:89-119`

- [ ] **Step 1: Write the failing regression test**

Create `src/components/messaging/__tests__/AiAgentManager.blankSave.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

// Regression guard for the 2026-08-30 outage. The user typed a persona for an
// account with no config, another tab's save invalidated the shared cache entry,
// the settling read re-ran the reset effect, and Save then wrote blank defaults
// over what they had typed -- with every existing guard satisfied.

const upsertConfig = { mutate: vi.fn(), isPending: false };

/** Flipped by the test to simulate the post-invalidation re-read settling again. */
let configIdentity = { value: null as null | Record<string, unknown> };

vi.mock("@/hooks/useAiAgentConfig", () => ({
  useAiAgentConfig: () => ({
    // A NEW object identity each render when the value is non-null, exactly as
    // React Query yields after an invalidation.
    config: configIdentity.value === null ? null : { ...configIdentity.value },
    isLoading: false,
    error: null,
    upsertConfig,
  }),
}));

vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({
    data: [{ id: "a1", platform: "facebook", platform_username: "Eltamlawy", is_active: true }],
  }),
}));

vi.mock("@/components/messaging/AutomationHandlerCard", () => ({
  AutomationHandlerCard: () => null,
}));
vi.mock("@/components/messaging/AiKnowledgeManager", () => ({ AiKnowledgeManager: () => null }));
vi.mock("@/components/messaging/AiAgentLogsView", () => ({ AiAgentLogsView: () => null }));
vi.mock("@/components/messaging/AiAgentTestChat", () => ({ AiAgentTestChat: () => null }));
vi.mock("@/components/messaging/AutoReplyManager", () => ({ AutoReplyManager: () => null }));
vi.mock("@/components/automation/DatabaseConnectorsManager", () => ({
  DatabaseConnectorsManager: () => null,
}));

import { AiAgentManager } from "@/components/messaging/AiAgentManager";

describe("AiAgentManager blank-save regression", () => {
  beforeEach(() => {
    upsertConfig.mutate.mockClear();
    configIdentity = { value: null };
  });

  it("keeps typed edits when the same account's config re-reads", () => {
    const { rerender } = render(<AiAgentManager platform="facebook" />);

    const persona = screen.getByLabelText(/persona/i);
    fireEvent.change(persona, { target: { value: "Eltamlawy brand voice" } });
    expect((persona as HTMLTextAreaElement).value).toBe("Eltamlawy brand voice");

    // Another tab saved; the shared cache entry was invalidated and this query
    // settled again on the same account. The account did NOT change.
    rerender(<AiAgentManager platform="facebook" />);

    expect((screen.getByLabelText(/persona/i) as HTMLTextAreaElement).value).toBe(
      "Eltamlawy brand voice",
    );

    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(upsertConfig.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ persona_instructions: "Eltamlawy brand voice" }),
      expect.anything(),
    );
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
bun run test -- AiAgentManager.blankSave
```

Expected: FAIL — the persona reads `""` after the rerender, and `mutate` is called with
`persona_instructions: ""`. **That failure is the bug.** If it passes, stop and re-read
`AiAgentManager.tsx:89-119` before changing anything.

- [ ] **Step 3: Make the reset conditional on a real account change**

In `src/components/messaging/AiAgentManager.tsx`, the effect currently opens:

```ts
  useEffect(() => {
    if (config === null) {
      setForm(defaultConfig);
      setBaseline(defaultConfig);
      setLoadedAccountId(accountId);
      return;
    }
    if (!config) return;
```

Replace that opening with:

```ts
  useEffect(() => {
    // Populate only when this account's values have not been loaded yet. The
    // same account settling a second time -- after another tab's save
    // invalidated the shared cache entry -- is not a reason to discard what the
    // user has typed since. Resetting on every config identity change is how a
    // typed persona became a blank save on 2026-08-30.
    if (loadedAccountId === accountId) return;
    if (config === null) {
      setForm(defaultConfig);
      setBaseline(defaultConfig);
      setLoadedAccountId(accountId);
      return;
    }
    if (!config) return;
```

Then add `loadedAccountId` to the dependency array:

```ts
  }, [accountId, config, loadedAccountId]);
```

- [ ] **Step 4: Run the new test and the existing suite**

```bash
bun run test -- AiAgentManager
```

Expected: PASS — the new test plus `AiAgentManager.test.tsx`,
`AiAgentManager.staleSave.test.tsx`, `AiAgentManager.loadingLock.test.tsx` and
`AiAgentManager.unsavedGuard.test.tsx` all green.

If `loadingLock` fails, the fieldset now unlocks too early or too late — re-read
`configLoaded` at line 87 and fix the interaction rather than weakening either test.

- [ ] **Step 5: Give the user a way to clear a persona on purpose**

Task 1's guard refuses any write that empties a stored field unless the payload carries
`confirm_clear`. Nothing sends it yet, so **without this step a user could never clear a
persona again** — a shipped dead end, and the guard would read as a bug.

The client can tell the two cases apart honestly, and the distinction is exactly the one that
matters:

| Case | `baseline` | `form` | Meaning |
|---|---|---|---|
| The outage | `""` | `""` | The form was **reset**; the user cleared nothing |
| Deliberate | `"Brand voice…"` | `""` | The user **loaded** a persona and emptied the box |

A reset sets `form` **and** `baseline` to `defaultConfig` together, so a reset can never
look deliberate. That is what makes this signal trustworthy rather than a rubber stamp.

In `src/components/messaging/AiAgentManager.tsx`, add above `upsertConfig.mutate(...)` inside
`save`:

```ts
    // The server refuses a write that empties a stored field unless the clear is
    // declared. A reset form cannot reach here saying yes: a reset sets form AND
    // baseline to defaultConfig together, so `baseline` is blank too and the
    // comparison below is false. Only a user who saw a value and deleted it
    // produces a non-empty baseline against an empty form.
    const clearedAField = (["persona_instructions", "business_profile_text"] as const).some(
      (field) =>
        String(form[field] ?? "").trim() === "" &&
        String(baseline?.[field] ?? "").trim() !== "",
    );
```

and pass it through the mutation. Change the call to:

```ts
    upsertConfig.mutate({ ...form, confirm_clear: clearedAField || undefined }, {
```

Then in `src/hooks/useAiAgentConfig.ts`, carry the flag to the server. In `upsertConfig`'s
`mutationFn`, change the body to:

```ts
      const data = await callMessagingApi("ai_upsert_config", {
        platform,
        social_account_id: socialAccountId ?? undefined,
        confirm_clear: (input as { confirm_clear?: boolean }).confirm_clear,
        config: buildAiAgentConfigPayload(input),
      });
```

`buildAiAgentConfigPayload` already filters to `CONFIG_FIELDS`, so `confirm_clear` cannot
leak into the column payload — it travels beside `config`, which is where the server reads it
(`body.confirm_clear`).

- [ ] **Step 6: Test the deliberate-clear path**

Add to `src/components/messaging/__tests__/AiAgentManager.blankSave.test.tsx`:

```tsx
  it("marks a user-initiated clear as deliberate, and a reset as not", () => {
    configIdentity = { value: { persona_instructions: "Loaded brand voice", is_enabled: true } };
    render(<AiAgentManager platform="facebook" />);

    fireEvent.change(screen.getByLabelText(/persona/i), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(upsertConfig.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ persona_instructions: "", confirm_clear: true }),
      expect.anything(),
    );
  });
```

Run it:

```bash
bun run test -- AiAgentManager.blankSave
```

Expected: PASS, 2 tests. If `confirm_clear` comes through as `undefined`, `baseline` is not
being set from the loaded config — re-read Task 2 Step 3.

- [ ] **Step 7: Commit**

```bash
git add src/components/messaging/AiAgentManager.tsx \
        src/hooks/useAiAgentConfig.ts \
        src/components/messaging/__tests__/AiAgentManager.blankSave.test.tsx
git commit -m "fix(agent-setup): stop a repeat read of the same account discarding typed edits"
```

---

## Task 3: Stop `accountId` flapping at its source

`accountId` is derived, so it can change with no user action if `accounts` transiently
empties during a refetch. Keeping previous data removes that possibility.

**Files:**
- Modify: `src/hooks/useSocialAccounts.tsx`

- [ ] **Step 1: Add `placeholderData`**

In `src/hooks/useSocialAccounts.tsx`, add to the `useQuery` options object (alongside
`queryKey` and `queryFn`):

```ts
    // AiAgentManager derives the selected account from this list
    // (`accounts[0]?.id` when nothing is chosen). If a refetch let the list
    // empty for one render, that derived id would round-trip through null and
    // remount the settings form around whatever the user was typing. Keeping
    // the previous page means the list never transiently empties.
    placeholderData: (previous) => previous,
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc -b --noEmit
```

Expected: clean. If `previous` is implicitly `any`, import and annotate with
`SocialAccount[] | undefined`.

- [ ] **Step 3: Run the full suite**

```bash
bun run test
```

Expected: PASS. Any test asserting a loading state for this hook may now see stale data
instead of `undefined` — if one fails, the test's assumption changed and the assertion should
move to `isFetching`, not be deleted.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useSocialAccounts.tsx
git commit -m "fix(accounts): keep the previous account list so a derived selection cannot flap"
```

---

## Task 4: Narrow the config invalidation key

**Files:**
- Modify: `src/hooks/useAiAgentConfig.ts:102`

- [ ] **Step 1: Replace the prefix invalidation with the exact key**

Currently:

```ts
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ai-agent-config", user?.id, platform] }),
```

Replace with:

```ts
    // The exact account's key, not the platform prefix. Both the settings form
    // and the knowledge tab read this same entry, so a prefix invalidation made
    // a write from one tab refetch -- and reset -- the other. Nothing else needs
    // refreshing after an account-scoped write: every other account's entry is
    // still accurate.
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["ai-agent-config", user?.id, platform, socialAccountId ?? null],
      }),
```

- [ ] **Step 2: Run the suite**

```bash
bun run test -- AiAgentManager AiKnowledge
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useAiAgentConfig.ts
git commit -m "fix(agent-setup): invalidate the written account's config, not the platform prefix"
```

---

## Task 5: Give the Knowledge tab the same guards as the settings form

**Files:**
- Create: `src/components/messaging/__tests__/AiKnowledgeManager.guards.test.tsx`
- Modify: `src/components/messaging/AiKnowledgeManager.tsx:40-60`, `:207-215`

- [ ] **Step 1: Write the failing tests**

Create `src/components/messaging/__tests__/AiKnowledgeManager.guards.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// AiKnowledgeManager is the second writer of ai_agent_configs and shipped with
// strictly weaker checks than the settings form: no error check, no account
// check, and a Save enabled over an empty textarea. Being the quieter surface is
// why nobody noticed.

const upsertConfig = { mutateAsync: vi.fn(), isPending: false };
let configValue: unknown = null;
let configError: unknown = null;

vi.mock("@/hooks/useAiAgentConfig", () => ({
  useAiAgentConfig: () => ({ config: configValue, error: configError, upsertConfig }),
}));
vi.mock("@/hooks/useAiKnowledge", () => ({
  useAiKnowledge: () => ({
    user: { id: "u1" },
    sources: [],
    isLoading: false,
    graphExport: { data: null },
    invoke: { mutateAsync: vi.fn(), isPending: false },
    resolveExportUrls: { mutateAsync: vi.fn() },
  }),
}));
vi.mock("@/hooks/useWhatsAppCatalog", () => ({
  useWhatsAppCatalog: () => ({ waAccount: null, catalog: null }),
}));

import { AiKnowledgeManager } from "@/components/messaging/AiKnowledgeManager";

const saveButton = () => screen.getByRole("button", { name: /save & index/i });

describe("AiKnowledgeManager write guards", () => {
  it("refuses to save while the read is unsettled", () => {
    configValue = undefined;
    configError = null;
    render(<AiKnowledgeManager platform="facebook" accountId="a1" />);
    expect(saveButton()).toBeDisabled();
  });

  it("refuses to save when the read errored", () => {
    // React Query keeps the previous account's data through a failed refetch, so
    // `config` alone can be another account's profile while THIS read failed.
    configValue = { business_profile_text: "Some other account's profile" };
    configError = new Error("statement timeout");
    render(<AiKnowledgeManager platform="facebook" accountId="a1" />);
    expect(saveButton()).toBeDisabled();
  });

  it("refuses to write an empty profile over a stored one", () => {
    configValue = { business_profile_text: "We sell day-old chicks." };
    configError = null;
    render(<AiKnowledgeManager platform="facebook" accountId="a1" />);

    const box = screen.getByPlaceholderText(/describe your business/i);
    expect(saveButton()).not.toBeDisabled();

    // fireEvent.change, NOT `box.value = ""`. Assigning to .value mutates the
    // DOM node without notifying React, so `profile` state would keep the stored
    // text and the assertion below would pass for entirely the wrong reason.
    fireEvent.change(box, { target: { value: "" } });
    expect(saveButton()).toBeDisabled();
  });

  it("allows a first save when nothing is stored yet", () => {
    configValue = null;
    configError = null;
    render(<AiKnowledgeManager platform="facebook" accountId="a1" />);
    expect(saveButton()).not.toBeDisabled();
  });
});
```

- [ ] **Step 2: Run and confirm failures**

```bash
bun run test -- AiKnowledgeManager.guards
```

Expected: the error-check and empty-over-stored tests FAIL.

- [ ] **Step 3: Strengthen the guards**

In `src/components/messaging/AiKnowledgeManager.tsx`, take `error` from the hook:

```ts
  const { config, error, upsertConfig } = useAiAgentConfig(platform, accountId);
```

Replace the `configLoaded` line:

```ts
  // Matches the settings form. `config` alone is not enough: React Query keeps
  // the previous account's data through a failed refetch, so a config that is
  // present can still belong to a different account while THIS read errored --
  // and saving would then write that account's profile here.
  const configLoaded = config !== undefined && !error;
  const profileText = config?.business_profile_text || "";
  // Emptying a stored profile is not a save, it is a deletion: ingest_profile_text
  // deletes the source when handed empty text. A deliberate clear is a separate
  // action, not a side effect of an empty box.
  const wouldBlankStoredProfile = profile.trim() === "" && profileText.trim() !== "";
```

And the Save button's `disabled`:

```ts
            disabled={!configLoaded || wouldBlankStoredProfile || upsertConfig.isPending || invoke.isPending}
```

**Declaration order matters:** `wouldBlankStoredProfile` reads `profile`, so it must come
after the `useState` that declares it. Move it below if the file's order differs.

- [ ] **Step 4: Run the tests**

```bash
bun run test -- AiKnowledgeManager
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/messaging/AiKnowledgeManager.tsx \
        src/components/messaging/__tests__/AiKnowledgeManager.guards.test.tsx
git commit -m "fix(knowledge): give the second config writer the settings form's guards"
```

---

## Task 6: Render a knowledge source's account by name, not UUID

Today a source reads `Business profile (threads · c5c42a4d-f8d6-401e-858c-a73cfdee0002)`.
It should read `Business profile (threads · postora.cloud)`.

`file_name` is the **lookup key** in `ai-knowledge-ingest` — two accounts sharing a title
would overwrite each other's chunks, which already happened once. So the stored value keeps
the UUID and only the *display* changes. A username can also be renamed, and a stored title
would then be a lie.

**Files:**
- Create: `src/lib/knowledgeSourceDisplay.ts`
- Create: `src/lib/__tests__/knowledgeSourceDisplay.test.ts`
- Modify: `src/components/messaging/AiKnowledgeManager.tsx` (source list rendering)

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/knowledgeSourceDisplay.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { displaySourceTitle } from "@/lib/knowledgeSourceDisplay";

const ACCOUNTS = [
  { id: "c5c42a4d-f8d6-401e-858c-a73cfdee0002", platform_username: "postora.cloud" },
  { id: "e65ab2cd-37dd-4c5c-9137-c2113be97f1c", platform_username: null, platform_user_id: "17841" },
];

describe("displaySourceTitle", () => {
  it("replaces the account id with its username", () => {
    expect(
      displaySourceTitle(
        "Business profile (threads · c5c42a4d-f8d6-401e-858c-a73cfdee0002)",
        ACCOUNTS,
      ),
    ).toBe("Business profile (threads · postora.cloud)");
  });

  it("falls back to the platform user id when there is no username", () => {
    expect(
      displaySourceTitle(
        "Business profile (instagram · e65ab2cd-37dd-4c5c-9137-c2113be97f1c)",
        ACCOUNTS,
      ),
    ).toBe("Business profile (instagram · 17841)");
  });

  it("leaves the id in place when the account is unknown", () => {
    // A disconnected account must not become an unlabelled source -- the id is
    // worse to read but still identifies the row.
    const title = "Business profile (facebook · 00000000-0000-0000-0000-000000000000)";
    expect(displaySourceTitle(title, ACCOUNTS)).toBe(title);
  });

  it("leaves uploaded document names untouched", () => {
    expect(displaySourceTitle("README.md", ACCOUNTS)).toBe("README.md");
    expect(displaySourceTitle("Business profile (threads)", ACCOUNTS)).toBe(
      "Business profile (threads)",
    );
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

```bash
bun run test -- knowledgeSourceDisplay
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/knowledgeSourceDisplay.ts`:

```ts
// A knowledge source's title as a human should read it.
//
// `ai_knowledge_sources.file_name` carries the full account UUID because it is
// the LOOKUP KEY in ai-knowledge-ingest: two accounts resolving one
// "Business profile (instagram)" row meant the second replaced the first's
// chunks, and one brand then answered customers out of another's description.
// The identity keeps the id; only the display resolves it to a name. Rendering
// rather than storing also survives a rename, which a stored title would not.

interface NamedAccount {
  id: string;
  platform_username?: string | null;
  platform_user_id?: string | null;
}

/** `Business profile (<platform> · <uuid>)` — the shape ai-knowledge-ingest writes. */
const PROFILE_TITLE = /^(Business profile \([^)]*? · )([0-9a-f-]{36})(\))$/i;

export function displaySourceTitle(fileName: string, accounts: NamedAccount[]): string {
  const match = PROFILE_TITLE.exec(fileName);
  if (!match) return fileName;
  const [, prefix, accountId, suffix] = match;
  const account = accounts.find((candidate) => candidate.id === accountId);
  const label = account?.platform_username || account?.platform_user_id;
  // An unknown account keeps its id: harder to read, but it still identifies the
  // row, and a source with no label at all is worse than an ugly one.
  return label ? `${prefix}${label}${suffix}` : fileName;
}
```

- [ ] **Step 4: Run the test**

```bash
bun run test -- knowledgeSourceDisplay
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Use it in the source list**

In `src/components/messaging/AiKnowledgeManager.tsx`, add the imports:

```ts
import { displaySourceTitle } from "@/lib/knowledgeSourceDisplay";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";
```

Add near the other hook calls:

```ts
  const { data: socialAccounts = [] } = useSocialAccounts();
```

Then, wherever the list renders `source.file_name`, render
`displaySourceTitle(source.file_name, socialAccounts)` instead. Search the file for
`file_name` and replace every **display** occurrence — leave any occurrence used as a key,
an id, or a request argument exactly as it is.

- [ ] **Step 6: Typecheck, test, lint**

```bash
npx tsc -b --noEmit && bun run test -- AiKnowledge && npx eslint src/lib/knowledgeSourceDisplay.ts src/components/messaging/AiKnowledgeManager.tsx
```

Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/knowledgeSourceDisplay.ts \
        src/lib/__tests__/knowledgeSourceDisplay.test.ts \
        src/components/messaging/AiKnowledgeManager.tsx
git commit -m "feat(knowledge): show a profile source's account by name instead of its uuid"
```

---

## Task 7: Filter the source list to the selected account

The list must use the **same predicate the retrieval RPCs use**: a source is visible when
`visibility='shared'` **or** an explicit link to this account exists. A list showing a
document the agent cannot retrieve — or hiding one it can — is worse than no filter, because
it makes the user confident about the wrong thing.

**Files:**
- Modify: `src/hooks/useAiKnowledge.ts:26-42`
- Modify: `src/components/messaging/AiKnowledgeManager.tsx`
- Create: `src/lib/__tests__/knowledgeVisibility.test.ts`
- Create: `src/lib/knowledgeVisibility.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/knowledgeVisibility.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { visibleToAccount } from "@/lib/knowledgeVisibility";

const shared = { id: "s1", visibility: "shared" as const };
const restricted = { id: "s2", visibility: "restricted" as const };

describe("visibleToAccount", () => {
  it("shows a shared source to an account with no links", () => {
    expect(visibleToAccount(shared, "a1", [])).toBe(true);
  });

  it("hides a restricted source from an unlinked account", () => {
    expect(visibleToAccount(restricted, "a1", [])).toBe(false);
  });

  it("shows a restricted source to a linked account", () => {
    expect(visibleToAccount(restricted, "a1", [{ source_id: "s2", social_account_id: "a1" }])).toBe(true);
  });

  it("does not let another account's link grant visibility", () => {
    expect(visibleToAccount(restricted, "a1", [{ source_id: "s2", social_account_id: "a2" }])).toBe(false);
  });

  it("is monotonic: adding a link never removes access", () => {
    // The rule this replaced was keyed on having ZERO links, so adding the first
    // link SHRANK an account from the whole corpus to one document.
    const before = visibleToAccount(shared, "a1", []);
    const after = visibleToAccount(shared, "a1", [{ source_id: "s9", social_account_id: "a1" }]);
    expect(before).toBe(true);
    expect(after).toBe(true);
  });

  it("shows everything when no account is selected", () => {
    // The library view with no account chosen is a management surface, not a
    // retrieval surface, and must not hide rows the user owns.
    expect(visibleToAccount(restricted, null, [])).toBe(true);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

```bash
bun run test -- knowledgeVisibility
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/knowledgeVisibility.ts`:

```ts
// Whether a knowledge source is visible to one connected account.
//
// This MUST stay identical to the predicate in match_ai_knowledge_*_for_account
// (migration 20260828180000). A list that shows a document the agent cannot
// retrieve, or hides one it can, makes the user confident about the wrong thing.

export interface VisibilityScopedSource {
  id: string;
  visibility: "shared" | "restricted";
}

export interface SourceAccountLink {
  source_id: string;
  social_account_id: string;
}

export function visibleToAccount(
  source: VisibilityScopedSource,
  accountId: string | null,
  links: SourceAccountLink[],
): boolean {
  // No account selected is the management view, not a retrieval view.
  if (!accountId) return true;
  if (source.visibility === "shared") return true;
  return links.some(
    (link) => link.source_id === source.id && link.social_account_id === accountId,
  );
}
```

**Why this is equivalent to the SQL, and what that equivalence depends on.** The RPC in
`20260828180000` does two things this function does not: it gates on the caller owning
`p_social_account_id`, and it joins `social_accounts` to confirm each link's account belongs
to the user. Both are redundant *here* and only here, because:

- `ai_knowledge_source_accounts` has RLS enabled with
  `Users manage their own knowledge source links` (`auth.uid() = user_id`), so the `links`
  query cannot return another user's rows — **verified against production**.
- `accountId` originates from `useSocialAccounts`, which is already scoped to the user.

The RPC needs its checks because Edge Functions call it under the **service role**, where RLS
is not evaluated. This function is only ever called from the browser under the user's own
JWT. **If anyone later moves this predicate server-side or fetches `links` with the service
key, the ownership checks must be added back** — otherwise one user's link row would make
another user's source visible.

- [ ] **Step 4: Run the test**

```bash
bun run test -- knowledgeVisibility
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Fetch the links and filter the list**

In `src/hooks/useAiKnowledge.ts`, add a second query beside `sources`:

```ts
  const links = useQuery({
    queryKey: ["ai-knowledge-source-accounts", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("ai_knowledge_source_accounts")
        .select("source_id, social_account_id");
      if (error) throw error;
      return data as { source_id: string; social_account_id: string }[];
    },
  });
```

Return it from the hook by adding `links: links.data || [],` to the returned object, and add
its key to `refresh`:

```ts
      client.invalidateQueries({ queryKey: ["ai-knowledge-source-accounts", user?.id] }),
```

In `src/components/messaging/AiKnowledgeManager.tsx`, take `links` from the hook and filter
before rendering:

```ts
  const { user, sources, links, isLoading, graphExport, invoke, resolveExportUrls } = useAiKnowledge();
  // Same predicate as the retrieval RPCs, so the list cannot promise the agent
  // something it will not read.
  const visibleSources = useMemo(
    () => sources.filter((source) => visibleToAccount(source, accountId ?? null, links)),
    [sources, accountId, links],
  );
```

Add the imports (`useMemo` from react if not already present):

```ts
import { visibleToAccount } from "@/lib/knowledgeVisibility";
```

Render `visibleSources` where the list currently renders `sources`. Leave the
`refetchInterval` logic reading the unfiltered `sources` — a still-processing source that
this account cannot see must still keep the poll alive.

- [ ] **Step 6: Full gates**

```bash
npx tsc -b --noEmit && bun run test && npx eslint src/lib src/hooks src/components/messaging
```

Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/knowledgeVisibility.ts \
        src/lib/__tests__/knowledgeVisibility.test.ts \
        src/hooks/useAiKnowledge.ts \
        src/components/messaging/AiKnowledgeManager.tsx
git commit -m "feat(knowledge): list only the sources the selected account can retrieve"
```

---

## Task 8: Full verification before the PR

- [ ] **Step 1: Run every gate, in this order**

```bash
deno test --allow-all supabase/functions/messaging-api/
npx tsc -b --noEmit
bun run test
npx eslint src/components/messaging src/hooks src/lib
```

Deno first — `--node-modules-dir=auto` destroys `node_modules` and breaks vitest.

- [ ] **Step 2: Prove the regression tests still catch the bug**

Revert Task 2's change temporarily and confirm `AiAgentManager.blankSave` FAILS:

```bash
git stash push -- src/components/messaging/AiAgentManager.tsx
bun run test -- AiAgentManager.blankSave     # MUST fail
git stash pop
bun run test -- AiAgentManager.blankSave     # MUST pass
```

**Do not use `git stash -u` in this repository** — another CLI session drives this working
tree and an untracked-file stash has aborted a pop here before. The scoped
`git stash push -- <file>` above is safe.

A regression test that passes with its fix reverted is testing nothing. If it passes either
way, the test is wrong, not the fix.

- [ ] **Step 3: Guard skills**

Run `clean-code-guard` on the changed production files and `test-guard` on the new tests,
per the repo's mandatory workflow.

- [ ] **Step 4: Deploy the edge function**

`messaging-api` changed, so it needs deploying — the frontend auto-deploys from `main` but
Edge Functions do not. Follow `docs/runbooks/deploy-edge-function.md`: copy into the
functions volume, verify SHA256, then restart. **Do not run `npx supabase functions deploy`**
— it targets Supabase Cloud and fails against this self-hosted stack.

Files to copy: `messaging-api/index.ts`, `messaging-api/configBlanking.ts`.

- [ ] **Step 5: Verify against production**

```sql
SELECT a.platform_username,
       length(coalesce(c.persona_instructions,'')) AS persona_len,
       c.is_enabled
FROM ai_agent_configs c
JOIN social_accounts a ON a.id = c.social_account_id
WHERE c.platform = 'facebook';
```

Then, in the UI: select a Facebook page with a persona, open the Knowledge tab, save a
business profile, return to Settings, and confirm the persona is still there.

---

## Out of scope for this plan

- Everything in spec §4, §5, §6 — connector scoping, the registry, credentials, adapters.
  Those are Plans 2 and 3.
- Repairing the الطملاوي row. The persona text survives in three sibling configs
  (`CareerFlow`, `careerflowkw`, `postora.cloud` — 1402 characters each) and the user copies
  it across in the UI. No migration.
- `ai_agent_logs` account scoping (PR E of the earlier plan).
