# Changing the Higgsfield consent-screen logo

The logo a user sees when authorizing Postora on Higgsfield comes from the
`logo_uri` of the **client already registered** with Higgsfield — not from the
string in `supabase/functions/_shared/higgsfield-oauth.ts`. Editing that string
changes only what a *future* registration would send.

## Why the registration cannot be updated

| Fact | Consequence |
|---|---|
| `oauth_clients` row `provider_code='higgsfield'` carries no `registration_client_uri` and no `registration_access_token` | RFC 7592 in-place `PUT` is impossible — Higgsfield's DCR returns no management credentials |
| `getOrRegisterClient` returns the stored row whenever `client_id` is set | The registration endpoint is never called again |
| A new registration mints a new `client_id` | Every stored refresh token — platform-wide and BYO — stops refreshing |

**Never delete the `oauth_clients` row to force a re-registration.**

## The only lever: the bytes at the registered URL

The registered `logo_uri` is
`https://openinary.walidmohamed.com/t/postora.cloud/logo2.png` — an asset we
control. Replacing the file behind it changes the consent screen with no
registration change and no risk to existing connections.

The consent screen is **Clerk's** (`mcp.higgsfield.ai/oauth2/authorize` →
`clerk.higgsfield.ai/oauth/authorize/continue`), which renders the client logo as
a **circular avatar**. Postora cannot change that CSS. So the artwork must be a
**full-bleed square mark**: no outer margin, no card border, no wordmark. A
framed card with "POSTORA" under it shrinks to a tiny glyph inside the circle —
that was the 2026-08-23 complaint.

## Procedure

Openinary **suffixes** a duplicate upload rather than overwriting it, so the old
file must be deleted first. Read the credentials from the functions env on the
Contabo host (`ssh-contabo-mcp`); do not copy them anywhere.

```bash
V=/etc/dokploy/compose/postorasupabase-supabase-j8axyh
K=$(grep -hoP '(?<=^OPENINARY_API_KEY=).*'   $V/code/.env $V/.env | head -1)
U=$(grep -hoP '(?<=^OPENINARY_SERVER_URL=).*' $V/code/.env $V/.env | head -1)
```

Crop server-side with the Supabase stack's own **imgproxy** — the box has no
Pillow and no ImageMagick, and this avoids uploading anything from a workstation.
`fp` is the focus point as a fraction of the source; the values below centre a
740x740 crop of the 1024x1024 source on the "P", dropping the white corners and
the wordmark band.

```bash
IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' \
     postorasupabase-supabase-j8axyh-supabase-imgproxy | awk '{print $1}')
SRC="https://openinary.walidmohamed.com/t/postora.cloud/logo2.png"
ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$SRC")
curl -s -o /tmp/ic.png \
  "http://$IP:5001/insecure/crop:740:740:fp:0.504:0.411/rs:fit:512:512/plain/$ENC@png"
```

Verify the crop before replacing anything: upload it under a throwaway name and
open the result, then delete the probe. The key is fed to curl through **stdin**
(`-H @-`) rather than interpolated into the command line — the Contabo host is
shared, and an argv-visible bearer token is readable in `ps` by anyone with a
shell on the box for as long as the request runs.

```bash
AUTH() { printf 'Authorization: Bearer %s\n' "$K"; }
AUTH | curl -sS --fail-with-body -m 60 -H @- -F "folder=postora.cloud" \
  -F "files=@/tmp/ic.png;filename=_probe.png;type=image/png" "$U/api/upload"
# open https://openinary.walidmohamed.com/t/w_320/postora.cloud/_probe.png
AUTH | curl -sS --fail-with-body -m 60 -X DELETE -H @- \
  "$U/api/storage/postora.cloud/_probe.png"
```

Then swap. The live asset has to be **deleted before** the replacement is
uploaded — Openinary offers no overwrite — so there is a window in which the
registered `logo_uri` 404s at the origin. Keep a copy of the old bytes first and
re-upload it if the new upload fails, and do not purge Cloudflare until the
replacement is confirmed: the stale edge copy is what keeps the consent screen
rendering while the origin is empty.

```bash
# Chained on && so a failed backup never reaches the delete and a failed delete never
# reaches the upload: Openinary would then suffix the new file and leave the old one live.
curl -sS --fail-with-body -m 60 -o /tmp/logo2.bak.png \
  "https://openinary.walidmohamed.com/t/postora.cloud/logo2.png" \
  && AUTH | curl -sS --fail-with-body -m 60 -X DELETE -H @- \
       "$U/api/storage/postora.cloud/logo2.png" \
  && { AUTH | curl -sS --fail-with-body -m 60 -H @- -F "folder=postora.cloud" \
         -F "files=@/tmp/ic.png;filename=logo2.png;type=image/png" "$U/api/upload" \
       || AUTH | curl -sS --fail-with-body -m 60 -H @- -F "folder=postora.cloud" \
            -F "files=@/tmp/logo2.bak.png;filename=logo2.png;type=image/png" "$U/api/upload"; }
```

Read the upload's JSON response rather than trusting the exit status alone:
Openinary reports the path it actually stored, and anything other than
`postora.cloud/logo2.png` means it suffixed a duplicate instead of taking the
name — delete that file and start again rather than purging. Then confirm the
origin is serving the new bytes at `/t/w_320/postora.cloud/logo2.png` — a
different cache key, so the edge cannot mask the result — before purging
anything.

## The step that cannot be automated: purge Cloudflare

`openinary.walidmohamed.com` sits behind Cloudflare and the `/t/` responses carry
`Cache-Control: public, max-age=31536000`. A delete-and-replace at the origin is
**invisible at the edge** — verified on 2026-08-24 by replacing a probe file with
completely different bytes and still receiving the old copy (`cf-cache-status:
HIT`). No Cloudflare API token exists on the Contabo host or in this repo, so
this step is manual:

> In the Cloudflare dashboard, open the zone serving
> `openinary.walidmohamed.com` and run a **single-file / purge-by-URL** purge for
> exactly `https://openinary.walidmohamed.com/t/postora.cloud/logo2.png`.
> (Cloudflare moves this control between releases — find it under the zone's
> caching settings rather than following a fixed menu path from here.)

Confirm with `curl -sI` on that URL: `cf-cache-status` should read `MISS` (then
`HIT` on the next request) and `age` should restart near `0`.

A transform URL such as `/t/w_400/postora.cloud/logo2.png` is a **different cache
key**, so it shows the new asset immediately — useful for confirming the origin
is right, but it is *not* the registered URL and proves nothing about what the
consent screen serves.

## Note on the delivered bytes

`/t/` always answers with **WebP bytes under `Content-Type: image/png`**
(the etag literally reads `{"format":"webp"}`), regardless of the request's
`Accept` header — it is a stored transform, not content negotiation. Browsers
sniff image bytes, so this renders; do not chase it as the cause of a logo
problem without evidence that the image failed to load.
