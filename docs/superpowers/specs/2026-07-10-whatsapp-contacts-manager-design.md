# WhatsApp Contacts Manager — Design

**Date:** 2026-07-10
**Route:** `/messaging/whatsapp/contacts`
**Approved by:** user (session 2026-07-10)

## Goal

Upgrade the contacts section from a basic table into a mobile-style contacts manager:
full contact-card fields, avatar photos, country-code phone entry, CSV import with
column mapping, bulk operations, groups, fast cached loading, and CSV/XLSX/vCard export.

## Decisions (user-confirmed)

- **Field set:** full mobile card — first/last name, avatar, primary WhatsApp number
  (country code + national number), secondary phone, email, company, job title,
  street/city/country, birthday, website, notes, tags.
- **Avatars:** file upload to Supabase `media` bucket (same pattern as message
  attachments), path prefix `whatsapp-contact-avatars/`, client-side square resize ~256px.
- **Exports:** CSV, Excel (.xlsx via new `xlsx` dependency), vCard (.vcf, generated in code).
- **Implementer:** Claude directly, phase-by-phase with guard passes.

## 1. Data model

One migration extending `public.whatsapp_contacts`:

```sql
ALTER TABLE public.whatsapp_contacts
  ADD COLUMN IF NOT EXISTS first_name TEXT,
  ADD COLUMN IF NOT EXISTS last_name TEXT,
  ADD COLUMN IF NOT EXISTS job_title TEXT,
  ADD COLUMN IF NOT EXISTS phone_secondary TEXT,
  ADD COLUMN IF NOT EXISTS street TEXT,
  ADD COLUMN IF NOT EXISTS city TEXT,
  ADD COLUMN IF NOT EXISTS country TEXT,
  ADD COLUMN IF NOT EXISTS birthday DATE,
  ADD COLUMN IF NOT EXISTS website TEXT;
```

- Existing columns unchanged; nothing that reads contacts today breaks
  (inbox names, broadcasts, webhook `handleContactSync`).
- `display_name` derived as `"first last"` (trimmed) on save from the new form;
  contact-sync from the phone still writes `display_name` directly.
- `phone_number` remains digits-only E.164 without `+` (matches webhook normalization
  and the `UNIQUE(user_id, phone_number)` key).
- Groups: existing `whatsapp_contact_groups` + `whatsapp_contact_group_members` reused as-is.

## 2. UI decomposition

`WhatsAppContactsContent.tsx` becomes a thin shell. New folder
`src/components/messaging/contacts/`:

| Unit | Responsibility |
|---|---|
| `useContacts.ts` | react-query hooks: paged contact list, counts, groups, members, mutations (create/update/delete/bulk), avatar upload |
| `ContactsTable.tsx` | table with avatar+name, phone, email, company, tags, groups columns; sortable name; checkbox column; row click opens edit |
| `ContactFormDialog.tsx` | add AND edit; mobile-card layout (avatar picker on top, then name row, phones, email, work, address, birthday, website, notes, tags, groups) |
| `PhoneInput.tsx` | country-code select (static country/dial-code list with flag emoji, no dependency) + national number field; emits combined digits |
| `ContactImportDialog.tsx` | CSV import wizard (see §4) |
| `ContactExportMenu.tsx` | dropdown: CSV / XLSX / vCard; scope = selection if any, else current filter |
| `GroupsBar.tsx` | group chips with counts, create/rename/recolor/delete group |
| `contactCodecs.ts` | pure logic: phone normalization/split, CSV header auto-mapping, vCard + CSV/XLSX row generation (unit-testable) |

## 3. Bulk operations

- Header checkbox = select page; "select all N matching" banner like Gmail.
- Action bar (appears when selection non-empty): Delete, Add to group, Remove from
  group, Add tag, Export selected.
- Bulk delete via single `.delete().in("id", ids)` behind a count-confirm dialog.
- Bulk group-assign via batch insert with `onConflict: "group_id,contact_id", ignoreDuplicates`.

## 4. CSV import wizard

1. **Parse** with papaparse (already a dependency), header row required.
2. **Map columns**: auto-match common headers (First Name, Last Name, Name, Phone,
   Mobile, E-mail, Company, Organization, Title, Address, City, Country, Birthday,
   Website, Notes, Tags, Avatar/Photo URL) with manual remap selects per column.
3. **Preview + validate**: first 10 rows shown; phones normalized to digits (with
   optional default-country-code applied to local numbers); invalid rows flagged.
4. **Options**: "add all imported contacts to group ___" (optional).
5. **Run**: chunked upsert 500 rows/batch, `onConflict: "user_id,phone_number"`,
   progress bar; final report imported/updated/skipped with downloadable error CSV.

## 5. Export

- **CSV**: papaparse `unparse`, all fields, re-importable by the wizard.
- **XLSX**: new `xlsx` (SheetJS) dependency, one worksheet, formatted headers.
- **vCard 3.0**: generated in `contactCodecs.ts` — FN, N, TEL;TYPE=CELL (primary),
  TEL;TYPE=HOME (secondary), EMAIL, ORG, TITLE, ADR, BDAY, URL, NOTE, PHOTO;VALUE=URI.
  Single `.vcf` file importable by iPhone/Android/Google Contacts.
- Export scope: selected rows if any, else all rows matching current search/group filter.

## 6. Avatars

- File input → canvas square-crop/resize to 256px JPEG → upload to `media` bucket at
  `whatsapp-contact-avatars/<postora file name>` (reuse `buildPostoraFileName`) →
  `getPublicUrl` → save to `avatar_url`.
- Rendered as `Avatar` with initials fallback in table + form.

## 7. Performance / caching

- Server-side pagination: `.range(page*50, page*50+49)`, page size 50.
- Debounced (300ms) server-side search across name/phone/email/company via `.or(ilike...)`.
- Group filter applied server-side via member-id `IN` subselect (two-step query).
- react-query: `staleTime: 5min`, `placeholderData: keepPreviousData`; mutations
  invalidate precisely; counts via `count: "exact", head: true`.

## 8. Error handling

- Duplicate phone on manual add → toast explaining the contact exists, offer "edit existing".
- Import errors never abort the batch; failed rows collected into the error report.
- Avatar upload failure keeps the form open with the error toast; contact save is
  independent of avatar success (save proceeds without photo).

## 9. Testing / verification

- Unit tests (vitest) for `contactCodecs.ts`: phone normalize/split round-trip,
  header auto-mapping, vCard output shape, CSV round-trip.
- `npx tsc --noEmit` gate.
- Live walkthrough: add w/ photo → edit → import sample CSV → bulk group-assign →
  export all 3 formats → confirm inbox still resolves saved names.

## Out of scope

- Syncing Postora-side contact edits back to the phone (Cloud API cannot write
  phone contacts).
- Contact dedupe/merge UI.
- Per-contact conversation history embed.
