# Agent Setup Unsaved-Changes Guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Agent Setup form silently discarding typed persona text when the user switches account, switches platform, or toggles DMs/Comments — and warn before a browser tab close.

**Architecture:** Two small hooks with one job each (`useDirtyForm` compares values against a saved baseline; `useUnsavedChangesGuard` holds a pending transition and drives a dialog), plus a presentational dialog. `AiAgentManager` guards its own account selector locally and publishes its dirty state upward via one optional prop; `UnifiedAgentSetupPage` guards the transitions that **remount** the child, which a guard inside the child could never intercept.

**Tech Stack:** React 18 + TypeScript, Vitest + @testing-library/react, shadcn `AlertDialog`.

**Spec:** `docs/superpowers/specs/2026-08-29-agent-setup-unsaved-guard-design.md`

## Global Constraints

- **Use `fireEvent`, never `userEvent`.** `userEvent.setup()` throws `Cannot redefine property: clipboard` in this project's jsdom. Confirmed again 2026-08-28.
- **Opening the Radix `Select` needs `keyDown`, not `click`.** `fireEvent.click` on the trigger does not open a Radix select in jsdom. Copy the pattern that already works at `src/components/messaging/__tests__/AiAgentManager.test.tsx:150-152`: `fireEvent.keyDown(screen.getByTestId("agent-account"), { key: "Enter" })`, then `fireEvent.click(await screen.findByRole("option", { name: "…" }))`.
- **`AI_AGENT_TABS` is `readonly string[]`**, not an array of objects (`AiAgentManager.tsx:42`). Any mock must export string ids or the page will not render.
- **Assertions must distinguish the two outcomes.** A mocked child renders the same markup before and after a remount, so "the button still exists" proves nothing about whether the transition was blocked. Assert on state that actually differs — the URL's `platform` param, or a value only the target account has.
- **`UnifiedAgentSetupPage.tsx:316` renders `<AiAgentManager key={`${platform}-${dmsActive…}-${commentsActive…}`} …>`.** The `key` forces a remount on platform change and on either toggle, destroying the child's state. A dirty flag held only inside `AiAgentManager` cannot protect those three transitions — this is the constraint the whole design turns on.
- **In-app route navigation is out of scope.** `App.tsx:62` uses declarative `<BrowserRouter>`; `useBlocker` requires `createBrowserRouter`. Do not add a router migration to this task.
- **Do not spec copy for the `beforeunload` prompt.** Browsers show their own generic text.
- Compare form values **deeply, by value**. The form is reset from a fresh object on every config load, so reference comparison reports dirty immediately and forever.
- Never report dirty while the baseline is `null` (config not yet loaded) — that matches the existing "Save disabled until loaded" rule at `AiAgentManager.tsx:299`.
- Gates: `npx tsc -b --noEmit`, `bun run test`, `bun run build`. **No Deno gate** — this touches no Edge Function.
- Work in the worktree `F:/Postora_wt/reauth-fix`. Never edit `F:/Postora_new`.
- Read `ARCHITECTURE.md` before touching code.

---

### Task 1: `useDirtyForm`

**Files:**
- Create: `src/hooks/useDirtyForm.ts`
- Test: `src/hooks/__tests__/useDirtyForm.test.ts`

**Interfaces:**
- Produces: `useDirtyForm<T>(current: T, baseline: T | null): boolean` — consumed by Task 3.

- [ ] **Step 1: Write the failing test**

Create `src/hooks/__tests__/useDirtyForm.test.ts`:

```ts
import { renderHook } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { useDirtyForm } from "@/hooks/useDirtyForm";

describe("useDirtyForm", () => {
  it("is clean when the value matches the baseline", () => {
    const baseline = { persona: "friendly", temperature: 0.7 };
    const { result } = renderHook(() => useDirtyForm({ persona: "friendly", temperature: 0.7 }, baseline));
    expect(result.current).toBe(false);
  });

  it("is dirty once a field differs", () => {
    const baseline = { persona: "friendly", temperature: 0.7 };
    const { result } = renderHook(() => useDirtyForm({ persona: "blunt", temperature: 0.7 }, baseline));
    expect(result.current).toBe(true);
  });

  it("is clean again when the edit is reverted", () => {
    // Proves value comparison, not reference: an equal-but-new object must read clean.
    const baseline = { persona: "friendly", temperature: 0.7 };
    const { result, rerender } = renderHook(
      ({ current }) => useDirtyForm(current, baseline),
      { initialProps: { current: { persona: "blunt", temperature: 0.7 } } },
    );
    expect(result.current).toBe(true);
    rerender({ current: { persona: "friendly", temperature: 0.7 } });
    expect(result.current).toBe(false);
  });

  it("is never dirty while the baseline is null", () => {
    // The config has not loaded yet; the user has not seen the form, so nothing is at risk.
    const { result } = renderHook(() => useDirtyForm({ persona: "anything" }, null));
    expect(result.current).toBe(false);
  });

  it("detects a nested change", () => {
    const baseline = { persona: "a", tools: { search: true } };
    const { result } = renderHook(() => useDirtyForm({ persona: "a", tools: { search: false } }, baseline));
    expect(result.current).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/hooks/__tests__/useDirtyForm.test.ts`
Expected: FAIL — cannot resolve `@/hooks/useDirtyForm`.

- [ ] **Step 3: Implement**

Create `src/hooks/useDirtyForm.ts`:

```ts
import { useMemo } from "react";

/**
 * Whether `current` has diverged from the last saved `baseline`.
 *
 * Compared by value, not reference: the form is replaced with a freshly built object
 * every time a config loads, so a reference check would report dirty immediately and
 * never recover. A null baseline means "not loaded yet" — nothing the user typed can
 * be at risk, so it reads clean.
 */
export function useDirtyForm<T>(current: T, baseline: T | null): boolean {
  return useMemo(() => {
    if (baseline === null) return false;
    return JSON.stringify(current) !== JSON.stringify(baseline);
  }, [current, baseline]);
}
```

`JSON.stringify` is sufficient here and avoids a dependency: the compared value is the
agent-config form — plain strings, numbers, booleans and small nested objects, no `Date`,
`Map`, `undefined`-vs-missing or key-order instability, because both sides are built by the
same code path.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/hooks/__tests__/useDirtyForm.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useDirtyForm.ts src/hooks/__tests__/useDirtyForm.test.ts
git commit -m "feat(hooks): add useDirtyForm to compare a form against its saved baseline"
```

---

### Task 2: `useUnsavedChangesGuard`

**Files:**
- Create: `src/hooks/useUnsavedChangesGuard.ts`
- Test: `src/hooks/__tests__/useUnsavedChangesGuard.test.ts`

**Interfaces:**
- Produces: `useUnsavedChangesGuard(isDirty: boolean): { guard: (proceed: () => void) => void; pending: boolean; confirmDiscard: () => void; cancel: () => void }` — consumed by Tasks 3 and 4.

- [ ] **Step 1: Write the failing test**

Create `src/hooks/__tests__/useUnsavedChangesGuard.test.ts`:

```ts
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";

describe("useUnsavedChangesGuard", () => {
  it("runs the transition immediately when clean", () => {
    const proceed = vi.fn();
    const { result } = renderHook(() => useUnsavedChangesGuard(false));
    act(() => result.current.guard(proceed));
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBe(false);
  });

  it("holds the transition and opens the dialog when dirty", () => {
    const proceed = vi.fn();
    const { result } = renderHook(() => useUnsavedChangesGuard(true));
    act(() => result.current.guard(proceed));
    expect(proceed).not.toHaveBeenCalled();
    expect(result.current.pending).toBe(true);
  });

  it("confirmDiscard runs the held transition exactly once and closes", () => {
    const proceed = vi.fn();
    const { result } = renderHook(() => useUnsavedChangesGuard(true));
    act(() => result.current.guard(proceed));
    act(() => result.current.confirmDiscard());
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBe(false);
    act(() => result.current.confirmDiscard());
    expect(proceed).toHaveBeenCalledTimes(1); // not re-run
  });

  it("cancel drops the transition without running it", () => {
    const proceed = vi.fn();
    const { result } = renderHook(() => useUnsavedChangesGuard(true));
    act(() => result.current.guard(proceed));
    act(() => result.current.cancel());
    expect(proceed).not.toHaveBeenCalled();
    expect(result.current.pending).toBe(false);
  });

  it("registers beforeunload only while dirty", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");

    const { rerender, unmount } = renderHook(({ dirty }) => useUnsavedChangesGuard(dirty), {
      initialProps: { dirty: false },
    });
    expect(add.mock.calls.filter(([e]) => e === "beforeunload")).toHaveLength(0);

    rerender({ dirty: true });
    expect(add.mock.calls.filter(([e]) => e === "beforeunload")).toHaveLength(1);

    rerender({ dirty: false });
    expect(remove.mock.calls.filter(([e]) => e === "beforeunload")).toHaveLength(1);

    unmount();
    add.mockRestore();
    remove.mockRestore();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/hooks/__tests__/useUnsavedChangesGuard.test.ts`
Expected: FAIL — cannot resolve `@/hooks/useUnsavedChangesGuard`.

- [ ] **Step 3: Implement**

Create `src/hooks/useUnsavedChangesGuard.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Intercepts a transition while a form has unsaved edits.
 *
 * The pending transition is held as a closure, so the hook never needs to know what it
 * is guarding — one instance covers the account switch, the platform switch and the
 * surface toggles alike.
 */
export function useUnsavedChangesGuard(isDirty: boolean) {
  const [pending, setPending] = useState(false);
  const heldTransition = useRef<(() => void) | null>(null);

  const guard = useCallback(
    (proceed: () => void) => {
      if (!isDirty) {
        proceed();
        return;
      }
      heldTransition.current = proceed;
      setPending(true);
    },
    [isDirty],
  );

  const confirmDiscard = useCallback(() => {
    const proceed = heldTransition.current;
    heldTransition.current = null;
    setPending(false);
    proceed?.();
  }, []);

  const cancel = useCallback(() => {
    heldTransition.current = null;
    setPending(false);
  }, []);

  useEffect(() => {
    if (!isDirty) return;
    // Browsers ignore any custom message here and show their own text; preventDefault
    // plus a non-empty returnValue is all that still triggers the prompt.
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);

  return { guard, pending, confirmDiscard, cancel };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/hooks/__tests__/useUnsavedChangesGuard.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useUnsavedChangesGuard.ts src/hooks/__tests__/useUnsavedChangesGuard.test.ts
git commit -m "feat(hooks): add useUnsavedChangesGuard to hold a transition while dirty"
```

---

### Task 3: The dialog, and guarding the account selector

**Files:**
- Create: `src/components/ui/UnsavedChangesDialog.tsx`
- Modify: `src/components/messaging/AiAgentManager.tsx` (baseline state, dirty reporting, guarded selector)
- Test: `src/components/messaging/__tests__/AiAgentManager.unsavedGuard.test.tsx`

**Interfaces:**
- Consumes: `useDirtyForm` (Task 1), `useUnsavedChangesGuard` (Task 2).
- Produces: `UnsavedChangesDialog` props `{ open: boolean; onCancel: () => void; onDiscard: () => void }`; and a new optional prop on `AiAgentManager`: `onDirtyChange?: (isDirty: boolean) => void` — consumed by Task 4.

- [ ] **Step 1: Write the failing test**

Create `src/components/messaging/__tests__/AiAgentManager.unsavedGuard.test.tsx`. Mirror the mocks
already used by `src/components/messaging/__tests__/AiAgentManager.test.tsx` — read that file first
and copy its mock setup rather than inventing a second pattern:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { AiAgentManager } from "../AiAgentManager";

// …reuse the existing mocks from AiAgentManager.test.tsx: useAiAgentConfig returning two
// accounts and a loaded config, useFeatureFlags, use-toast, supabase client.

describe("AiAgentManager unsaved-changes guard", () => {
  it("switching account with unsaved edits opens the dialog", async () => {
    render(<AiAgentManager platform="instagram" />);

    fireEvent.change(await screen.findByLabelText(/persona and instructions/i), {
      target: { value: "a brand new persona" },
    });
    fireEvent.keyDown(screen.getByTestId("agent-account"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Brand B" }));

    expect(await screen.findByText(/you have unsaved changes/i)).toBeInTheDocument();
  });

  it("Keep editing keeps the text and does NOT switch account", async () => {
    render(<AiAgentManager platform="instagram" />);
    const field = await screen.findByLabelText(/persona and instructions/i);
    fireEvent.change(field, { target: { value: "a brand new persona" } });
    fireEvent.keyDown(screen.getByTestId("agent-account"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Brand B" }));
    fireEvent.click(await screen.findByRole("button", { name: /keep editing/i }));

    expect((field as HTMLTextAreaElement).value).toBe("a brand new persona");
    // Assert the account the config hook was actually scoped to, not the trigger's label:
    // `lastAccountScopedWith()` is the helper the sibling suite already uses for this.
    expect(lastAccountScopedWith()).toBe("a1");
  });

  it("Discard changes switches account and loads its values", async () => {
    render(<AiAgentManager platform="instagram" />);
    fireEvent.change(await screen.findByLabelText(/persona and instructions/i), {
      target: { value: "a brand new persona" },
    });
    fireEvent.keyDown(screen.getByTestId("agent-account"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Brand B" }));
    fireEvent.click(await screen.findByRole("button", { name: /discard changes/i }));

    expect(lastAccountScopedWith()).toBe("a2");
    // The typed text is gone and Brand B's own persona is showing.
    expect((await screen.findByLabelText(/persona and instructions/i) as HTMLTextAreaElement).value)
      .not.toBe("a brand new persona");
  });

  it("switching account with no edits does not prompt", async () => {
    render(<AiAgentManager platform="instagram" />);
    fireEvent.keyDown(screen.getByTestId("agent-account"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Brand B" }));

    expect(screen.queryByText(/you have unsaved changes/i)).not.toBeInTheDocument();
    expect(lastAccountScopedWith()).toBe("a2");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/messaging/__tests__/AiAgentManager.unsavedGuard.test.tsx`
Expected: FAIL — no dialog appears; the account switches immediately.

- [ ] **Step 3: Build the dialog**

Create `src/components/ui/UnsavedChangesDialog.tsx`:

```tsx
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface UnsavedChangesDialogProps {
  open: boolean;
  onCancel: () => void;
  onDiscard: () => void;
}

export function UnsavedChangesDialog({ open, onCancel, onDiscard }: UnsavedChangesDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>You have unsaved changes</AlertDialogTitle>
          <AlertDialogDescription>
            Your edits to this agent have not been saved. Discarding will lose them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {/* Cancel is the safe action, so it keeps default focus and wins a stray Enter. */}
          <AlertDialogCancel onClick={onCancel}>Keep editing</AlertDialogCancel>
          <AlertDialogAction
            onClick={onDiscard}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Discard changes
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

- [ ] **Step 4: Track the baseline in `AiAgentManager`**

Add beside the existing `form` state (`AiAgentManager.tsx:68`):

```ts
const [baseline, setBaseline] = useState<AiAgentConfigInput | null>(null);
```

In the effect that populates `form` from `config` (`:83-100`), set the baseline to the **same value**
in both branches — the `config === null` branch (`setForm(defaultConfig)`) and the loaded branch.
Extract the built object into a local first so form and baseline cannot drift:

```ts
    if (config === null) {
      setForm(defaultConfig);
      setBaseline(defaultConfig);
      return;
    }
    if (!config) return;
    const loaded = { /* …the existing object literal, unchanged… */ };
    setForm(loaded);
    setBaseline(loaded);
```

After a successful save, re-baseline to the **exact object that was submitted**, inside the existing
`onSuccess` callback at `:135-138` — not to a fresh read, which has not arrived yet:

```ts
    upsertConfig.mutate(form, {
      onSuccess: () => {
        setBaseline(form);          // the form is clean again the moment the write lands
        toast.success("AI agent settings saved");
      },
      onError: (error) => toast.error(error.message || "Could not save AI agent settings"),
    });
```

Two details that make this safe. `handleSave` returns early on an invalid phone number (`:132-134`),
so a rejected submit never re-baselines. And `buildAiAgentConfigPayload` normalizes
`admin_phone_numbers` server-side, so the persisted value can differ slightly from `form` — that is
fine, because the subsequent config refetch runs the effect again and re-baselines both `form` and
`baseline` to the normalized truth.

**On `JSON.stringify` and key order** — verified rather than assumed: `update` is
`setForm((current) => ({ ...current, [key]: value }))` (`:110-112`), and spread preserves insertion
order for keys that already exist, so an edit cannot reorder the object relative to its baseline.
Editing a field absent from `defaultConfig` (`model`, `temperature`, …) appends a key and reads
dirty — which is correct, because it *is* a change.

- [ ] **Step 5: Guard the selector and report upward**

```ts
const formDirty = useDirtyForm(form, baseline);
// A typed-but-not-yet-added phone number is unsaved work too. `phoneInput` is separate
// state (`:69`) that `addPhone` moves into `form.admin_phone_numbers` — so a user who
// types a number and switches account without pressing Add would silently lose it,
// because `form` never changed.
const isDirty = formDirty || phoneInput.trim().length > 0;
const { guard, pending, confirmDiscard, cancel } = useUnsavedChangesGuard(isDirty);

useEffect(() => { onDirtyChange?.(isDirty); }, [isDirty, onDirtyChange]);
```

Change the selector at `:169` from a bare setter to a guarded one:

```tsx
<Select value={accountId ?? ""} onValueChange={(next) => guard(() => setSelectedAccountId(next))}>
```

Render the dialog inside the component, resetting the baseline as part of the discard:

```tsx
<UnsavedChangesDialog
  open={pending}
  onCancel={cancel}
  onDiscard={() => { setBaseline(null); setPhoneInput(""); confirmDiscard(); }}
/>
```

⚠️ `setBaseline(null)` is required, not tidiness. Switching account does **not** remount this
component — only the query key changes — so until the new account's config settles, `form` still
holds the discarded text while `baseline` still holds the old account's values. The component would
keep reporting itself dirty and prompt a second time on the very next transition. Setting the
baseline to `null` makes `useDirtyForm` read clean for exactly that interval, which is what the
"not loaded yet" rule already means. Clearing `phoneInput` discards the other half of the edit.

⚠️ `onDirtyChange` must be memoized by the **parent** (Task 4 passes a `useState` setter, which is
stable). Do not pass an inline arrow from the parent, or the effect loops.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/components/messaging/__tests__/AiAgentManager.unsavedGuard.test.tsx`
Expected: PASS (4 tests).

Then confirm nothing regressed in the existing suite for this component:

Run: `npx vitest run src/components/messaging/__tests__/AiAgentManager.test.tsx`
Expected: PASS, same count as before this task.

- [ ] **Step 7: Commit**

```bash
git add src/components/ui/UnsavedChangesDialog.tsx src/components/messaging/AiAgentManager.tsx src/components/messaging/__tests__/AiAgentManager.unsavedGuard.test.tsx
git commit -m "feat(agent-setup): confirm before an account switch discards unsaved edits"
```

---

### Task 4: Guard the transitions that remount the child

**Files:**
- Modify: `src/pages/automation/UnifiedAgentSetupPage.tsx` (platform switch `:87-92`, both toggles, the render at `:315-321`)
- Test: `src/pages/automation/__tests__/UnifiedAgentSetupPage.guard.test.tsx`

**Interfaces:**
- Consumes: `useUnsavedChangesGuard` (Task 2), `UnsavedChangesDialog` and `onDirtyChange` (Task 3).

- [ ] **Step 1: Write the failing test**

Create `src/pages/automation/__tests__/UnifiedAgentSetupPage.guard.test.tsx`. This is the case a
component-level test cannot reach — the child is destroyed by the `key` before it could object:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import UnifiedAgentSetupPage from "../UnifiedAgentSetupPage";

// DashboardLayout wraps this page (`:139`) and calls usePublishing, which throws
// without its provider. Stub it to a passthrough or the test cannot render at all.
vi.mock("@/components/layout/DashboardLayout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Stub AiAgentManager: this test is about the PAGE's guarding, not the form's internals.
// The stub reports itself dirty as soon as its button is pressed.
// AI_AGENT_TABS is readonly string[] in production (`AiAgentManager.tsx:42`) — export the
// same shape or the page's tab rendering breaks.
vi.mock("@/components/messaging/AiAgentManager", async () => {
  const { useEffect, useState } = await import("react");
  return {
    AI_AGENT_TABS: ["settings", "knowledge", "tools", "test", "logs"] as const,
    AiAgentManager: ({ onDirtyChange }: { onDirtyChange?: (d: boolean) => void }) => {
      const [dirty, setDirty] = useState(false);
      useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
      return <button onClick={() => setDirty(true)}>make dirty</button>;
    },
  };
});
// …plus the page's own mocks: useFeatureFlags, useSocialAccounts, use-toast.

describe("UnifiedAgentSetupPage unsaved guard", () => {
  it("prompts before a platform switch discards edits", async () => {
    render(<MemoryRouter initialEntries={["/automation?platform=instagram"]}><UnifiedAgentSetupPage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole("button", { name: /make dirty/i }));
    fireEvent.click(await screen.findByRole("button", { name: /threads/i }));

    expect(await screen.findByText(/you have unsaved changes/i)).toBeInTheDocument();
  });

  it("Keep editing leaves the platform unchanged", async () => {
    render(<MemoryRouter initialEntries={["/automation?platform=instagram"]}><UnifiedAgentSetupPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /make dirty/i }));
    fireEvent.click(await screen.findByRole("button", { name: /threads/i }));
    fireEvent.click(await screen.findByRole("button", { name: /keep editing/i }));

    expect(screen.queryByText(/you have unsaved changes/i)).not.toBeInTheDocument();
    // Assert the platform did NOT change. The mocked child renders identically before and
    // after a remount, so "the button still exists" would pass even if the switch happened.
    // The page keeps platform in the URL (`:87-92`), so the URL is the observable truth.
    expect(window.location.search).toContain("platform=instagram");
  });

  it("prompts before a surface toggle discards edits", async () => {
    render(<MemoryRouter initialEntries={["/automation?platform=instagram"]}><UnifiedAgentSetupPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /make dirty/i }));
    fireEvent.click(await screen.findByRole("button", { name: /comments/i }));

    expect(await screen.findByText(/you have unsaved changes/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/pages/automation/__tests__/UnifiedAgentSetupPage.guard.test.tsx`
Expected: FAIL — the platform switches with no dialog.

- [ ] **Step 3: Hold the child's dirty state on the page**

```ts
const [agentDirty, setAgentDirty] = useState(false);
const { guard, pending, confirmDiscard, cancel } = useUnsavedChangesGuard(agentDirty);
```

`setAgentDirty` is a `useState` setter and therefore stable, which is exactly what Task 3's effect
needs. Pass it directly — never an inline arrow.

- [ ] **Step 4: Route every remounting transition through the guard**

The platform switcher (`:87-92`) and both toggle handlers wrap their existing body:

```ts
  const handleSelectPlatform = (nextPlatform: AiAgentPlatform) => {
    guard(() => {
      // …the existing setSearchParams body, unchanged…
    });
  };
```

Do the same for `handleToggleDms` and the comments toggle. These three are guarded **here** rather
than inside `AiAgentManager` because the `key` at `:316` remounts the child on each of them — a
guard inside the child would run after its state was already destroyed.

- [ ] **Step 5: Reset the flag when discarding, and render the dialog**

```tsx
<AiAgentManager
  key={`${platform}-${dmsActive ? "dms" : ""}-${commentsActive ? "comments" : ""}`}
  platform={platform}
  onDirtyChange={setAgentDirty}
  …
/>

<UnsavedChangesDialog
  open={pending}
  onCancel={cancel}
  onDiscard={() => { setAgentDirty(false); confirmDiscard(); }}
/>
```

⚠️ `setAgentDirty(false)` before `confirmDiscard()` is required, not cosmetic. After a confirmed
discard the child remounts and will report `false` — but only on its next effect. Without the manual
reset the page still holds `true` during that gap and the very next transition prompts spuriously.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/pages/automation/__tests__/UnifiedAgentSetupPage.guard.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 7: Run every gate**

```bash
npx tsc -b --noEmit
bun run test
bun run build
```
Expected: tsc exit 0; the full vitest suite green with 17 more tests than before this plan
(5 + 5 + 4 + 3); build succeeds. Paste the real output — never assert "tests pass" without it.

- [ ] **Step 8: Commit**

```bash
git add src/pages/automation/
git commit -m "feat(agent-setup): guard platform and surface switches that remount the form"
```

---

### Task 5: Land it

**Files:** none modified.

- [ ] **Step 1: Manual check against the running app**

`bun run dev`, open Agent Setup, then confirm each case by hand — automated tests use a stubbed
child, so this is the only check that exercises the real form:

| action | expected |
|---|---|
| edit persona → switch account | dialog; "Keep editing" preserves text **and** the original account |
| edit persona → switch platform | dialog before the remount |
| edit persona → toggle DMs or Comments | dialog |
| edit persona → close the browser tab | browser's own leave-site prompt |
| save, then switch anything | no dialog (baseline reset on save) |
| switch with no edits | no dialog |

- [ ] **Step 2: Guard passes**

Run `clean-code-guard` over the changed production code and `test-guard` over the new tests.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin <branch>
gh pr create --title "feat(agent-setup): warn before unsaved agent edits are discarded" --body "…"
```

State plainly in the PR body that in-app route navigation is **not** covered, and why: `App.tsx`
uses `<BrowserRouter>`, and `useBlocker` needs a data router. Address CodeRabbit and Codex findings,
capped at two rounds, then merge.
