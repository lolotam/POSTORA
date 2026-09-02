# Pagination

List routes use opaque cursor pagination (`limit`, `cursor`, `next_cursor`). There is no offset/page-number mode.

## Parameters

- `limit` — page size. Bounds and default are defined in `docs/api/openapi.yaml` `components.parameters.Limit` and enforced in `supabase/functions/partner-api/v1/pagination.ts` (`LIMIT_MIN`, `LIMIT_MAX`, `LIMIT_DEFAULT`). Cite the document for the numbers; the code clamps to them.
- `cursor` — opaque string from a previous `next_cursor`. Do not construct or decode it.

## Response

Every listing returns `CollectionEnvelope` with `data: []` and `next_cursor: string | null`. When `next_cursor` is `null` there is no next page. Some listings (accounts, templates, webhooks) always return `null` because they are bounded.

## Cursors

Cursors are base64url of `{"t": timestamp, "i": id}` ordered by `(timestamp, id)` descending. An invalid cursor answers `invalid_request` 400. A tampered cursor never silently resets to page 1.

Loop as:

```
cursor = null
do {
  page = GET /v1/conversations?limit=20&cursor=cursor
  process(page.data)
  cursor = page.next_cursor
} while (cursor !== null)
```

Reference: `supabase/functions/partner-api/v1/pagination.ts` and `docs/api/openapi.yaml` `components.schemas.CollectionEnvelope`.
