# Spec B — Unsaved-Changes Guard in Agent Setup

Date: 2026-08-29 · Subsystem: Frontend (React) · Independent of Spec A.

## Why this is worth building

`src/components/messaging/AiAgentManager.tsx` holds a long free-text persona form. The account
dropdown is a bare setter (`:169`, `onValueChange={setSelectedAccountId}`), and an effect (`:83-100`)
overwrites `form` as soon as the newly selected account's config arrives. **Typed text is discarded
silently.**

This file has already caused two production incidents of exactly this class — its own comments record
them:

> *"Returning early here let account A's persona sit in the fields while account B was selected — and
> since null counts as loaded, Save was enabled and would have written A's brand voice into B."*

and the disabled-save guard at `:299`: *"a blank form must not overwrite the stored persona."*

So the surrounding code already defends against *writing the wrong data*. Nothing yet defends against
*losing the user's data*. That is this spec.

## The finding that shapes the design

`src/pages/automation/UnifiedAgentSetupPage.tsx:316`:

```tsx
<AiAgentManager
  key={`${platform}-${dmsActive ? "dms" : ""}-${commentsActive ? "comments" : ""}`}
  platform={platform}
  …
/>
```

**The `key` forces a full remount** whenever the platform changes *or* the DMs/Comments toggles
change. React destroys the old instance and its `form` state before anything inside the component
could intervene.

Consequences the naive design gets wrong:

1. A dirty flag held privately inside `AiAgentManager` **cannot** protect a platform switch — by the
   time the guard would run, the state it was guarding is already gone.
2. The DMs/Comments toggles are a third data-loss trigger the original task never listed.
3. Platform lives in `searchParams` (`:87-92`), so switching it is also a URL write.

Therefore the dirty flag must be **published upward** to `UnifiedAgentSetupPage`, which owns every
transition that remounts the child.

## Scope

In (decided 2026-08-29):

- Account-selector switch inside a platform
- Platform switch (the remount case)
- DMs / Comments toggles (same remount, found during design)
- Browser tab / window close — `beforeunload`

Out, deliberately:

- **In-app route navigation.** `App.tsx:62` uses declarative `<BrowserRouter>`. `useBlocker` and
  `unstable_usePrompt` require a data router (`createBrowserRouter` + `RouterProvider`), which
  nothing in this codebase uses. Adding it means migrating every route — a separate project with its
  own blast radius. Clicking a nav link away from the page will still lose edits; that gap is
  accepted and recorded here rather than discovered later.
- Custom copy on the `beforeunload` prompt. Browsers replaced author text with a generic string years
  ago. We get *a* prompt, not *our* prompt. Do not spec wording for it.

## Design

### 1. `useDirtyForm` — the state primitive

New hook, `src/hooks/useDirtyForm.ts`. One job: given the current value and the last-saved baseline,
say whether they differ.

```ts
export function useDirtyForm<T>(current: T, baseline: T | null): boolean
```

Deep-equality by value, not reference — the form is reset from a fresh object on every config load,
so reference comparison would report dirty immediately and permanently. Returns `false` while
`baseline` is `null` (config not yet loaded), which matches the existing "Save disabled until
loaded" rule at `:299` and avoids claiming dirtiness over a form the user has not seen.

`AiAgentManager` stores the baseline when it populates `form` from `config`, and again on a
successful save.

### 2. `useUnsavedChangesGuard` — the transition gate

New hook, `src/hooks/useUnsavedChangesGuard.ts`. One job: intercept a transition while dirty.

```ts
export function useUnsavedChangesGuard(isDirty: boolean): {
  guard: (proceed: () => void) => void;   // runs proceed(), or opens the dialog
  pending: boolean;                        // dialog open
  confirmDiscard: () => void;              // run the held transition
  cancel: () => void;                      // drop it, keep the text
}
```

It also registers the `beforeunload` listener while `isDirty` is true, and removes it when clean —
an always-on listener would nag on every navigation away from a pristine form.

Holding the pending transition as a closure keeps the hook ignorant of *what* it is guarding, so the
same instance covers the account switch, the platform switch and both toggles.

### 3. Wiring

`AiAgentManager` gains one optional prop:

```ts
onDirtyChange?: (isDirty: boolean) => void;
```

It reports its own dirty state upward via an effect. It keeps owning the account-selector guard
locally (no remount there — it is internal state, so a local guard works and is simpler).

`UnifiedAgentSetupPage` holds `const [agentDirty, setAgentDirty] = useState(false)`, passes
`onDirtyChange={setAgentDirty}`, and routes the platform switch and both toggles through
`guard(...)`. It renders one `UnsavedChangesDialog`.

**Why a prop rather than context:** exactly one parent needs this, one level up. Context would be
speculative generality for a single consumer.

**Stale-flag hazard, and its fix:** after a *confirmed discard* the child remounts and reports
`false`, but there is a render gap during which the parent still holds `true`. The parent must reset
`agentDirty` to `false` as part of `confirmDiscard`, not wait for the child. Otherwise the next
transition prompts spuriously.

### 4. `UnsavedChangesDialog`

`src/components/ui/UnsavedChangesDialog.tsx`. Presentational, no state. Built on the existing
`AlertDialog` primitive to match the codebase — this is not a place to introduce a second dialog
pattern.

- Title: "You have unsaved changes"
- Body: "Your edits to this agent have not been saved. Discarding will lose them."
- `AlertDialogCancel` → "Keep editing" (cancel)
- `AlertDialogAction` → "Discard changes" (destructive styling)

Cancel is the default focus: the safe action wins an accidental Enter.

## Testing

`src/hooks/__tests__/useDirtyForm.test.ts` — clean at baseline; dirty after an edit; clean again when
the edit is reverted (proves value not reference comparison); never dirty while baseline is null.

`src/hooks/__tests__/useUnsavedChangesGuard.test.ts` — clean transition runs immediately without a
dialog; dirty transition is held; `confirmDiscard` runs the held closure exactly once; `cancel` never
runs it; the `beforeunload` listener is added only while dirty and removed when clean.

`src/components/messaging/__tests__/AiAgentManager.unsavedGuard.test.tsx` — editing the persona then
switching account opens the dialog; "Keep editing" leaves the typed text intact **and the original
account still selected**; "Discard changes" switches and loads the new account's values.

`src/pages/automation/__tests__/UnifiedAgentSetupPage.guard.test.tsx` — the case a component-level
test cannot reach: a dirty child plus a platform switch prompts *before* the remount.

**Use `fireEvent`, not `userEvent`.** `userEvent.setup()` throws `Cannot redefine property: clipboard`
in this project's jsdom — a known constraint, confirmed again on 2026-08-28.

## Gates

`npx tsc -b --noEmit` · `bun run test` · `bun run build`.

No Deno gate. This change touches no Edge Function; running `deno test` here would be ceremony that
passes regardless of the diff and proves nothing about it.

## Noted, not touched

`InstagramConnectMethodDialog` and `ProfileRow` both have zero consumers — pre-existing dead code
adjacent to this work. Removing them is not bundled into a feature change.
