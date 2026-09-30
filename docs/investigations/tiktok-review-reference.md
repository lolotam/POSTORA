# TikTok review — Brandora reference capture

Captured 2026-09-30 from the authenticated Brandora Approvals page
(`/ws/<workspace>/approvals`), selected item "TikTok - The RAG Latency Trap",
desktop viewport 1910×901 CSS px, DPR 1, scrolled to the detail action row.
Values below were read with `getComputedStyle` on the live page; they are
reference measurements, not guesses. Nothing was approved, rejected, archived,
saved or published: the settings popover and the inline editor were opened and
closed with **Cancel**.

Screenshots were taken but are **not committed**: they show another product's
UI and a third-party test account's identifiers. The measurements below are the
durable record.

## Evidence status

| Spec item | Status |
| --- | --- |
| E1 queue + detail | Confirmed. Status filter (`PENDING`), agent filter, checkbox rows, detail card with preview, summary strip, destination, schedule, actions. |
| E2 controls | Confirmed. Change video, Remove video, Reject, Edit, Archive, TikTok settings (the `…` button, `aria-label="TikTok settings"`), Approve, Schedule, Now, In 1 hour, Tomorrow 9:00, keyboard hints `A` approve / `R` reject / `→` next. |
| E3 validation | Confirmed. Red line "Open TikTok settings and confirm this post for the selected account."; `PICK A TIME TO ENABLE SCHEDULE`; Approve and Schedule are `disabled` (opacity 0.6) until settings are confirmed. |
| E4 visuals | **Measured** — tokens below. |
| E5 settings/editor | **Resolved.** Both opened; contents below. |
| Approve meaning | **Not verified.** Approve was never executed. The button carries no title/description. POSTORA keeps the explicit label **Approve & publish** (spec R5). |
| 390 px mobile reference | **Blocked.** The browser window could not be resized below its maximised size. POSTORA's narrow layout follows spec R1 (stacked queue/detail with Back to posts) as a POSTORA design decision. |

## Measured tokens

| Role | Value |
| --- | --- |
| Page background | `rgb(245,240,227)` `#F5F0E3` |
| Card / queue surface | `rgb(251,248,239)` `#FBF8EF`, radius 12px, border `1px rgba(26,24,20,.1)` |
| Sidebar / secondary surface, Edit button, inputs | `rgb(237,229,207)` `#EDE5CF` |
| Text primary | `rgb(26,24,20)` `#1A1814` |
| Text secondary | `rgb(74,70,62)` `#4A463E` |
| Text muted / idle tab | `rgb(138,133,120)` `#8A8578` |
| Accent red (eyebrow, validation, Reject, selected-row rule) | `rgb(230,57,70)` `#E63946` |
| Positive green (Approve outline, Schedule fill) | `rgb(45,122,76)` `#2D7A4C` |
| Awaiting badge | bg `#FDF7BF`, border `1px #F7E733`, pill 9999px, Courier Prime 10.88px/700, tracking 1.088px, uppercase |
| "Edited" chip | text `#1D3557`, bg `rgba(29,53,87,.1)`, border `1px rgba(29,53,87,.4)`, pill |
| Neutral chip | text `#4A463E`, bg `#EDE5CF`, pill |
| Control border | `1px rgba(26,24,20,.2)` |

Typography:

| Role | Font |
| --- | --- |
| Page title "Approvals" | Shrikhand 38.4px/400, tracking −0.96px |
| Detail title | Shrikhand 25.6px/400, tracking −0.64px |
| Eyebrow / tabs / field labels | Courier Prime 11.52px/700, uppercase, tracking ≈1.15–2.07px |
| Body, queue titles | Space Grotesk; queue title 14.4px/600; subtitle 14px/400 |
| Validation hint | Courier Prime 9.92px, red, uppercase |

Controls:

| Control | Measured |
| --- | --- |
| Reject | pill, transparent, red text + red 1px border, 99×40 |
| Edit | pill, `#EDE5CF` fill, 83×40 |
| Archive | pill, transparent, secondary text, 106×40 |
| Approve | radius 12px, green outline, Space Grotesk 14px/600, 120×40 |
| Schedule | radius 12px, green fill, ivory text, 125×40 |
| Now / In 1 hour / Tomorrow 9:00 | pill 28px high, `#F5F0E3` fill, 11.52px/600 |
| Change video / Remove video | pill 36px high, card fill, 12px/600 |
| Date-time input | radius 10px, `#EDE5CF` fill, 231×40 |
| Keyboard hint `kbd` | Courier Prime 11.2px/700, 22×22, radius 4px |

## Settings popover (E5)

320×631 px, `#FBF8EF`, radius 12px, border `1px rgba(26,24,20,.2)`, anchored to
the `…` button, scrollable. Top to bottom:

1. `TIKTOK SETTINGS` eyebrow; "Posting as <nickname> (@<handle>)".
2. Toggle "Send to the TikTok inbox instead of posting" (off).
3. `WHO CAN VIEW` select: placeholder "Choose audience…" (disabled option), then the creator's options (here Followers, Friends, Only me).
4. `POST TYPE` Video / Photo radios, both disabled — "Set by what the post carries". "Maximum video length: 3600 seconds." (from creator info).
5. Checkboxes Allow comments / Allow Duet / Allow Stitch — Duet and Stitch disabled for this creator.
6. Toggle "AI-generated content" — **on by default** in Brandora (their content is agent-written). POSTORA keeps it off for a new draft; the user sets it.
7. "Disclose whether this content promotes yourself, a brand, product or service." + toggle "Disclose commercial content".
8. Music Usage Confirmation wording and the processing notice.
9. Checkbox "I consent to send this content to the selected TikTok account when scheduled" — disabled until an audience is chosen.
10. "Choose who can view this TikTok post." helper; **Cancel** / **Save** (Save disabled until valid).

## Inline editor

Replaces the settings/destination block below the summary strip: `EDIT CONTENT`
eyebrow, `POST TEXT` textarea (Space Grotesk 14px, `#F5F0E3`, radius 10px) with a
live `447 CHARS` counter, `HASHTAGS` input + Add, `IMAGE` "Choose images" (0 of 35
for TikTok), `VIDEO` thumbnail with Download/Remove, media constraints text
("TikTok: 23–60 fps, 360–4096 px on each side, up to 10 minutes"), `NOTE
(OPTIONAL)`, **Cancel** / **Save changes**.

## Summary strip

Five columns under the preview: `SCHEDULED` (—), `TYPE` (Post), `LENGTH` (447
chars), `TIKTOK` ("Friends · Video · Comments on"), and an agent confidence
score. POSTORA omits the confidence column (spec §1: no invented scores).
