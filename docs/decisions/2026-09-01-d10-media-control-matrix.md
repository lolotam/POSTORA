# D10 — the media control matrix, filled in

**Date:** 2026-09-01
**Deliverable:** 4.1 (and 4.2, which is whatever 4.1 could not answer)
**Status:** decided; the malware row needs owner ratification, marked below

---

## Why this document exists before any code

D10 does not say "reuse the existing media pipeline". It says reuse is
**conditional** on eight controls being specified and verified *before the
endpoint ships*, because "reuse the existing pipeline" is a routing decision,
not a security contract, and leaving it there makes an implementer invent
security-sensitive behaviour by accident.

The plan's 4.2 exists for the rows the existing pipeline cannot satisfy: those
become implementation work **in this phase**, not assumptions.

Three rows could not be satisfied. They are marked **GAP** and each says what
was built instead.

---

## The matrix

| Control | Answer |
|---|---|
| **Max size** | Per type, below. Enforced twice: `Content-Length` before the body is read, actual byte length after |
| **Accepted types** | An allowlist of 9 media types, **sniffed from magic bytes on every upload**, with a declared-vs-sniffed disagreement rejected outright |
| **Malware handling** | **No scanner. The surface is constrained so the state machine collapses to one state** — see below. Needs owner ratification |
| **Availability semantics** | A `media_id` is returned only after the bytes are sniffed, sized and stored. There is no pending state, because there is no scan to wait for |
| **Tenant ownership** | `media_files.workspace_id`, checked on the metadata read **and inside the send path**. NULL never matches, so no pre-existing upload is reachable |
| **Download URL TTL** | **900 seconds** (15 min), and the URL is never given to the partner — it exists only so Meta can fetch the bytes |
| **Retention and deletion** | Follows the account: rows and objects live until the workspace's media is cleaned up. **Partner-initiated deletion is deferred** with `DELETE /v1/media/{id}` |
| **Quota dimension** | **Deferred, explicitly**, to 2.7's counter decision. Per-request rate limiting and the monthly send quota both apply today; storage and transfer bytes are not metered |

---

## Max size, per type

| Type | Limit | Why this number |
|---|---|---|
| Image | **5 MB** | WhatsApp Cloud's own image cap |
| Audio | **16 MB** | WhatsApp Cloud's own audio cap |
| Video | **16 MB** | WhatsApp Cloud's own video cap |
| Document | **25 MB** | WhatsApp allows 100 MB. Ours is lower on purpose: the bytes pass through an edge worker with a bounded memory budget, and a 100 MB upload would fail as a worker death rather than as a typed refusal. A limit we can enforce beats one we can only advertise |

Accepting a file WhatsApp will refuse is worse than refusing it ourselves: the
partner would spend a quota unit and an idempotency key to learn it from Meta.

---

## The allowlist, and what is deliberately not on it

Sniffed by magic number, never by extension and never by the client's declared
`Content-Type`:

| Kind | Types | Signature |
|---|---|---|
| Image | `image/jpeg`, `image/png` | `FF D8 FF`; `89 PNG\r\n\x1a\n` |
| Video | `video/mp4`, `video/3gpp` | `ftyp` at offset 4, brand distinguishes |
| Audio | `audio/mpeg`, `audio/ogg`, `audio/aac`, `audio/amr` | `ID3` or `FF Ex`; `OggS`; ADTS `FF F1`/`FF F9`; `#!AMR` |
| Document | `application/pdf` | `%PDF-` |

**`image/webp` is excluded** even though the existing sniffer recognises it:
on WhatsApp a webp is a *sticker*, a different message type with different
rules, and accepting it as an image would produce a send Meta rejects.

**Office formats are excluded** for a reason that will not change by trying
harder: `.docx`, `.xlsx` and `.pptx` are ZIP containers, and ZIP sniffing
cannot tell one from another — or from any other zip — without parsing the
archive. An allowlist that cannot distinguish its members is not an allowlist.
Adding them later is additive and needs a real container parser.

An unrecognised payload is refused rather than guessed. Guessing is how an
executable gets stored as `application/pdf`.

---

## Malware handling — the row that could not be answered, and what was done

**There is no malware scanner anywhere in Postora.** Not in this pipeline, not
in the app's own uploader, not in the inbound media path. D10 asks for
"scan-before-availability, with the state machine made explicit", and the
honest answer is that the mechanism does not exist and this phase does not
invent one — a scanner is infrastructure and a running cost, not a function.

So the surface is constrained until the row collapses. What a scanner protects
against is bytes that *act* somewhere. These bytes never do:

1. **Postora never executes or renders them.** They are sniffed 12 bytes deep,
   written to storage, and handed to Meta as a URL. No decoder, no thumbnailer,
   no archive expansion, no office parser — the last of which is most of why
   Office formats are off the allowlist.
2. **They are never served to a browser from a Postora origin.** The bucket is
   private; the only URL generated is short-lived, server-side, and goes to
   Meta. There is no path by which a partner-uploaded file is fetched by a
   victim's browser under a Postora domain, which is the delivery mechanism
   that makes stored files dangerous.
3. **The allowlist is nine types, each byte-confirmed.** A payload that is not
   one of them never reaches storage.
4. **The recipient's platform scans.** WhatsApp scans media on delivery. We are
   not the last line, and we do not pretend to be.
5. **The uploader is identified.** An authenticated, key-bound, audited partner
   — not an anonymous form. Abuse is attributable and the credential is
   revocable.

**The state machine is therefore one state: `available`.** That is not the row
being skipped; it is the row being answered with the reason it has one state.

**Owner ratification.** This is the one row that trades a control for a
constraint, so it should be a decision the owner has seen rather than one an
implementer made. If the answer is "scan anyway", the shape is known: a
`scan_state` column on `media_files`, a `pending` state that
`POST /v1/messages` refuses, and a worker. Nothing built here forecloses it —
adding a column and a refusal is additive.

---

## Tenant ownership — the second gap

`media_files` has **`user_id` and no `workspace_id`**. D10(R3) says media is
**workspace-owned**, with the creating key recorded for audit, precisely so a
rotated key can still reach media it uploaded — and D12 makes rotation routine.

Migration `20260901190000` adds `workspace_id` and `created_by_key_id`, both
nullable, and **deliberately does not backfill**. Every partner read filters
`workspace_id = <the key's workspace>`, and SQL `NULL` matches nothing, so all
existing user uploads are invisible to every partner key by construction. A
backfill would have had to guess which workspace a user's media belonged to,
and guessing wrong is a cross-tenant read.

`media_files.user_id` is `NOT NULL`, so a partner upload still needs a user: it
takes `workspaces.owner_id`. That keeps the row valid for the app's own queries
without inventing a synthetic user.

---

## Storage — the third gap

The existing uploader **delegates to Cloudinary** (`uploadFileFromBase64` →
`uploadToCloudinary`). It cannot be reused here, and the reason is D10's own
first sentence: partners never receive provider credentials or raw provider
URLs, and a Cloudinary URL is both a provider URL and unbounded in time.

Partner uploads therefore go to Supabase Storage, in a **new private
`partner-media` bucket** created by migration `20260901190000` with
service-role-only policies.

**Why a new bucket rather than the app's `media` bucket.** The `media` bucket
is private in production — but the migration that creates it says
`public = true` and adds a `"Public can view media"` policy of
`USING (bucket_id = 'media')`, which grants every authenticated user read of
every object. Production was tightened out of band and the repository never
recorded it. That is the same drift as the `ai-knowledge` incident, still
present, and a replay of migrations would restore the public bucket.

Partner media must not inherit a privacy property that exists only as an
undocumented production state. `partner-media` is private in committed SQL, so
the matrix's "tenant ownership" and "time-bounded URL" rows are true by
construction rather than by a fix nobody wrote down.

*(The `media` bucket's own drift is pre-existing and out of scope here. It is
worth its own change.)*

---

## What the partner can and cannot do with a URL

The partner never receives one. `POST /v1/media` returns an id;
`GET /v1/media/{id}` returns metadata. The only URL that exists is a 900-second
signed URL generated **inside the send path**, handed to Meta as `link:`, and
never written to a log, a response body or the dispatch intent's
`request_summary`.

`GET /v1/media/{id}/download` is **deferred**, and not for lack of time: it is
the endpoint that creates a *partner-facing* TTL contract, and it is not needed
to send a message. Deferring it keeps this phase's exposure to one internal
consumer whose behaviour we control.

---

## D13 is unchanged, and that is the point

A media send reaches a real customer and costs money, so it is a send in every
sense D13 means: `Idempotency-Key` required, a durable dispatch intent written
**before** the provider call, takeover resolving to `indeterminate` and never
re-dispatching. The media arm is a third `kind` inside the same
`performSend` — which stays unexported — not a second path to the provider.

`request_summary` records `media_file_id`, the media type and the caption
length. Never the signed URL, which is a live capability, and never the
caption, which is customer content. An intent row outlives the key that
created it.

**Media sends ship unsuspended.** The 0A suspension covers `send_template`
because a template's duplicate-send window was the defect it was raised
against. A media message is a session message, like text, which has shipped
unsuspended since 3.5. They are live on merge.
