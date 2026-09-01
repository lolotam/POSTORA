# /v1 CORS is decided at the gateway, not in the function

**Date:** 2026-09-01 · **Owner:** Partner API programme · **Status:** finding recorded, decision
still open

**Related:** `docs/decisions/2026-08-30-partner-api-cors.md` (covers the ALIAS only, and explicitly
declines to pre-adopt anything for `/v1`), plan deliverable 0.10.

---

## What was intended

Phase 2's `/v1` router (deliverable 2.1, PR #105) deliberately emits **no `Access-Control-*`
headers at all**. The `/v1` branch in `index.ts` is placed *before* the alias's `OPTIONS`
short-circuit specifically so that a `/v1` preflight is not answered with the alias's
`Access-Control-Allow-Origin: *`, and `v1/errors.ts` carries a comment saying so. The reasoning was
that the recorded CORS decision covers the alias only, so `/v1` should make no CORS claim until its
own decision exists.

## What actually happens

The intent does not survive to the wire. Verified on 2026-09-01 by probing each layer:

| Probed at | `Access-Control-Allow-Origin` |
|---|---|
| the edge-functions container directly (`172.21.0.2:9000`) | **absent** — the function is doing exactly what it intends |
| Kong directly (`172.21.0.15:8000`, bypassing Cloudflare) | **`*` present** |
| the public URL (`https://api.postora.cloud/...`) | **`*` present** |

**Kong adds it**, for every route it fronts. Not Cloudflare, and not the function.

## Why this matters

Not because it is exploitable today. The argument in the alias's CORS record still holds for
`/v1`: the credential is a **custom header** (`x-postora-key`), not a cookie, so a browser's
ambient authority cannot be abused — a cross-origin page cannot make an authenticated call it could
not already make. Nothing here is an open vulnerability.

It matters because **a deliberate decision was silently pre-empted by infrastructure.** The
programme chose to leave `/v1`'s CORS posture open, and the gateway closed it to `*` anyway. Anyone
reading `v1/errors.ts` would conclude `/v1` makes no CORS claim; anyone reading the response would
conclude it claims `*`. That gap is the same class of drift this programme keeps finding — a
document (here, a comment) asserting something the running system contradicts.

## Consequences for the eventual /v1 CORS decision (0.10's `/v1` half)

1. **It cannot be made in the function alone.** Whatever `/v1` decides, Kong is the layer that
   currently determines the answer. A decision that only changes edge-function code will not change
   what a browser sees.
2. **The options are therefore:** accept `*` for `/v1` explicitly, with the custom-header argument
   written down as the justification (cheapest, and consistent with the alias); or configure Kong
   to scope CORS per route, which is a real infrastructure change and affects every other function
   Kong fronts.
3. **Until it is decided, `v1/errors.ts`'s comment is misleading** and should say "the function
   makes no CORS claim; the gateway currently adds `*`" rather than implying `/v1` carries none.

## What would change the answer

If `/v1` ever adopts a cookie or `Authorization`-header credential, or if a `/v1` route is ever
made safe to call from a browser with ambient authority, `*` stops being defensible and the Kong
configuration becomes a security control rather than a convenience.
