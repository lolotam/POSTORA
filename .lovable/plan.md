## Goal

In the LinkedIn destination checkbox popover (used in the Post page settings), split the list into two clearly labeled sections so it's obvious which entries are personal profiles vs. company/commercial Pages.

## Changes

**File:** `src/components/post/settings/LinkedInSettings.tsx`

1. Inside the existing multi-select popover, partition destinations into two groups:
   - **Personal account** — the user's personal LinkedIn profile (`isPersonal: true`)
   - **Commercial pages** — all managed LinkedIn Pages (`urn:li:organization:*`)

2. Render each group with a small uppercase muted section header (matching the styling already used in `PlatformAccountMultiSelect.tsx` for grouped lists), with a thin divider between groups.

3. If a group is empty (e.g., no Pages managed), hide that section's header instead of showing an empty block.

4. No behavior changes: still multi-select via checkboxes, still requires ≥1 destination (falls back to personal), still writes `linkedinSelectedDestinationIds` exactly as today.

## Out of scope

- No backend / edge function changes (`process-post` already loops over destination IDs).
- No DB, env, or schema changes.
- No changes to other platforms or to the Scheduled Posts quick-edit selector.

## Validation

- Open the Post page, select LinkedIn, open the destinations popover, confirm:
  - Two labeled sections appear when both a personal account and ≥1 Page exist.
  - Single section appears (without an empty header) when only one type is connected.
  - Selections persist and publishing still fans out to all chosen destinations.

Final status target: `completed` (UI-only change, no manual deploy needed).
