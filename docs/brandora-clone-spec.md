# Brandora UI/behaviour reference (for the Postora rebuild)

Working reference captured read-only from `app.brandora.ai` on 2026-10-14 (workspace `e56cb672-…`, user on a trial). Most measurements were taken at a 1600×1000 viewport; the default pane was 1105×914, where the Approvals detail column is clipped. Copy in quotes is verbatim; uppercase in quotes means the UI renders it uppercase via CSS (`text-transform: uppercase`), the source string is usually Title/sentence case.

Legend: **[observed]** seen directly, **[inferred]** deduced from data or behaviour, **[not inspected]** deliberately not opened (commit risk or permission denied).

---

## 0. Routes

Base: `/ws/<workspaceId>/…`

| Page | Route | Notes |
|---|---|---|
| Home | `/dashboard` | |
| Studio | `https://studio.brandora.ai/auth/brandora/start` | external, sidebar badge "NEW" |
| Brand | `/brand` | |
| Strategy | `/strategy` | |
| Activity | `/work-items` | `?item=<id>` = expanded row |
| Calendar | `/calendar?date=YYYY-MM-DD[&view=week\|day]` | default view = month (no `view` param) |
| Approvals | `/approvals[?tab=pending\|approved\|rejected\|all][&item=<id>]` | default tab = pending |
| Competitors | `/competitors` | |
| Performance | `/performance` | |
| Workspace | `/settings[?tab=general\|members\|plan\|usage\|notifications]` | |
| Integrations | `/integrations` | |
| Chat thread | `/conversations/<id>` | target of "Open in chat" |

URL logic:
- Sidebar Calendar link and the header CALENDAR tab carry `?date=` = the date of the item needing attention (here the failed post, `2026-10-12`). Home "Resolve publishing" links to `calendar?date=2026-10-12&view=week`.
- Calendar `Previous`/`Next`/`Today` change the visible period **without** changing the URL (the `date` param is only the initial anchor). Changing View rewrites `&view=`.
- Selecting an item in the Approvals list does **not** change the URL; deep links use `?item=<id>&tab=all|approved`.
- Expanding a row in Activity sets `?item=<id>`.

---

## 1. Design tokens

### 1.1 Fonts (correction to the brief)
There is **no serif-italic heading font and no monospace label font** in the app UI.
- UI font everywhere: `"Nunito Sans", system-ui, sans-serif` (weights 400/500/600/700). Exposed as `--font-nunito-sans`, wired via `body:has([data-dashboard-font]) { --dashboard-ui-font: var(--font-nunito-sans), system-ui, sans-serif }`.
- Display font: `Shrikhand` (heavy, slanted-looking display face) used **only** for the logo mark "b" (16px) and wordmark "brandora" (20px, letter-spacing −0.5px).
- Other loaded font variables (unused on inspected pages): Space Grotesk, Courier Prime, Kalam.
- "Small-caps" labels are Nunito Sans 700, `uppercase`, tracking 1.4–2.3px, sizes 9.6–11.5px.
- "Fraunces" appears on the Brand page only as the *customer's* brand typography.

### 1.2 Colour palette (Tailwind custom tokens, read from the stylesheet)

| Token | Value | Use |
|---|---|---|
| `paper` | `#F5F0E3` rgb(245,240,227) | app/page background, light text on dark |
| `paper-card` | `#FBF8EF` rgb(251,248,239) | cards, panels, popovers, inputs-on-page |
| `paper-warm` | `#EDE5CF` rgb(237,229,207) | sidebar bg, input fill, hover/selected rows, neutral chips |
| body bg | `#FFFEF9` rgb(255,254,249) | `<body>` behind the shell |
| `ink` | `#1A1814` rgb(26,24,20) | primary text, primary (black) buttons, active nav item, TikTok icon tile |
| `ink-soft` | `#4A463E` rgb(74,70,62) | secondary text, nav item text |
| `ink-mute` | `#8A8578` rgb(138,133,120) | meta text, labels, captions |
| `rule` | `rgba(26,24,20,0.10)` | hairline borders, dividers |
| `rule-strong` | `rgba(26,24,20,0.20)` | input/button outline borders |
| `tomato` | `#E63946` rgb(230,57,70) | accent red: eyebrow labels, count badges, "Schedule…" CTA, active tab underline, today marker, errors |
| `tomato-soft` | `#FAEAEC` rgb(250,234,236) | failed chip bg, "NEW" pill bg, warning banners |
| `mint-deep` | `#2D7A4C` rgb(45,122,76) | Approve/Schedule/Save buttons, success text, toggles on |
| `mint` | `#7EC8A7` | image-type icon tile, mint borders |
| `mint-soft` | `#E4F2EC` rgb(228,242,236) | SAVED / CONNECTED pills |
| `brand-indigo` | `#1D3557` rgb(29,53,87) | avatar circle, EDITED pill text, LinkedIn tile on Integrations |
| `highlighter` | `#F7E733` | Vee/PENDING pill border |
| `highlighter-soft` | `#FDF7BF` rgb(253,247,191) | Vee agent pill, PENDING pill |
| `danger` | `#DC2626` | (defined, not seen) |
| LinkedIn tile (Approvals) | `#0A66C2` | |
| competitor icon tile | `#E6EBF2` | |

shadcn HSL variables also exist in `:root` (`--primary: 250 96% 68%` purple, `--radius: .75rem`, `.dark` set) but are **not** used by the observed screens; the custom tokens above are what render.

### 1.3 Radius, borders, shadows
- Cards/panels/popovers: `12px`, border `1px rule`, no shadow (box-shadow none).
- Nav items, inputs, list chips, icon tiles: `10px`. Dropdown option rows: `8px`. Detail-header status tag: `4px`.
- Buttons and pills: fully round `9999px`, except the Approval footer's Approve / Schedule / Confirm reject / Save changes / Undo buttons which are `12px`.
- Dividers: 1px `rule`.

### 1.4 Type scale (px / weight)
- Page eyebrow ("PIPELINE", "SETTINGS", "FOUNDATION", "INSIGHTS"): 11.52/700 uppercase, tracking 2.07px, **tomato**.
- Page H1: 38.4/600, tracking −0.96px, ink.
- Page subtitle: 14/400 ink-soft.
- Section H2 small caps (e.g. "CONNECTED ACCOUNTS"): 11.52/700 uppercase tracking 2.3px ink, followed by "· N" (10.4 ink-mute) and a hairline that fills the row.
- Card titles: 14–16/600–700. Integration card H3: 24/600 tracking −0.6px.
- Body: 12–14/400. Meta: 10.4/400 ink-mute, often uppercase tracking 0.8px.
- Filter label ("STATUS", "AGENT", "VIEW", "TYPE"): 10.4/700 uppercase tracking 1.56px ink-mute.

### 1.5 Buttons
- **Primary black**: bg ink, text paper, 12–14/600, pill. ("Activate", "Open", "Connect LinkedIn", "Add another TikTok" outline variant)
- **Primary red (CTA)**: bg tomato, text paper, pill, leading icon ("Schedule…", "Schedule", "Schedule in Calendar", "Resolve publishing →").
- **Green confirm**: bg mint-deep, text paper ("Schedule" in approval footer, "Save settings", "Save changes", "Reschedule"). Outline green variant: transparent bg, 1px mint-deep border + text ("Approve").
- **Secondary cream**: bg paper or paper-warm, 1px rule-strong border, ink text ("Edit", "Change", "Undo — return to pending", preset chips "Now"/"In 1 hour"/"Tomorrow 9:00").
- **Outline red**: transparent, 1px tomato border + text ("Reject").
- **Ghost**: text only ink-soft ("Cancel", "Edit caption", "Why Vee made this").
- Disabled: `disabled:opacity-60` style (Approve/Schedule disabled appear muted; integration Connect buttons greyed).

### 1.6 Pills / badges
| Label | Text | Bg | Border | Radius |
|---|---|---|---|---|
| Count badge (nav/tab) | paper 9.6/700 | tomato | – | 9999 |
| "NEW" (sidebar) | tomato 9.6/700 | tomato-soft | – | 9999 |
| Agent "VEE" (Activity) | ink | highlighter-soft | 1px highlighter/50% | 9999 |
| Agent RILEY/DANNY/LUKE (Activity) | ink-soft | paper-warm | 1px rule-strong | 9999 |
| Agent pill (Approvals list) | ink-soft 10.4/400 | paper-warm | none | 9999 |
| SAVED (Activity) | mint-deep | mint-soft | 1px mint/50% | 10 |
| PUBLISHED (Activity) | paper | ink | 1px ink | 10 |
| PENDING (Activity) | ink | highlighter-soft | 1px highlighter/60% | 10 |
| PUBLISH FAILED (Activity) | tomato | tomato-soft | 1px tomato/40% | 10 |
| ARCHIVED (Activity) | ink-mute | paper-warm | 1px rule | 10 |
| PUBLISHED / NEEDS SCHEDULING (Approvals list) | mint-deep 9.6/700 | mint-deep/10% | 1px mint-deep/40% | 9999 |
| EDITED (Approvals list) | brand-indigo | indigo/10% | 1px indigo/40% | 9999 |
| PENDING / SAVED / PUBLISH FAILED / ARCHIVED (Approvals list "All") | ink-soft | paper-warm | 1px rule-strong | 9999 |
| CONNECTED (Integrations) | mint-deep 9.92/700 | mint-soft | 1px mint/40% | 9999 |
| AVAILABLE | ink-soft | transparent | 1px rule | 9999 |
| SOON | ink-mute | transparent | 2px **dashed-look** ink-mute | 8 |

Inconsistency to note: "PUBLISH FAILED" is red in Activity and the Calendar, but neutral grey in the Approvals list and Approvals detail header.

---

## 2. Global shell

### 2.1 Layout
- Two columns: fixed sidebar 256px wide (bg paper-warm `#EDE5CF`, full height) + content (bg paper `#F5F0E3`).
- Pipeline pages: content left-anchored at x≈296 (40px gutter from sidebar), widths grow with viewport (calendar ~754px at 1105 wide; approvals list 360px + detail column fills the rest at 1600).
- Integrations / Settings: centred column ≈1072px max.
- Top-right of Home only: search icon button ("Search conversations") and "History" button. A hidden "Open navigation menu" button exists for narrow screens.
- Pages first render a skeleton (grey bars/rows on paper) before content.

### 2.2 Sidebar (top → bottom)
1. Logo: 32×32 tomato square (radius 10) with Shrikhand "b" in paper; wordmark "brandora" Shrikhand 20px ink.
2. Collapse button (24px circle on the sidebar's right edge, bg paper, border rule-strong): aria "Collapse sidebar". [collapsed state not inspected]
3. Nav items: 40px tall, radius 10, padding-left 12, icon 16px + label 14/500 ink-soft. Active item: bg **ink**, text **paper** (black pill). Groups with section labels 11.2/700 uppercase tracking 1.68px ink-mute:
   - (no label) "Home", "Studio" + "NEW" pill
   - "FOUNDATION": "Brand", "Strategy"
   - "PIPELINE": "Activity", "Calendar" + badge, "Approvals" + badge
   - "INSIGHTS": "Competitors", "Performance"
   - "SETTINGS": "Workspace", "Integrations"
4. Badges: 18px red circles. Calendar badge = needs-scheduling + failed count ("2"), screen-reader text "1 need scheduling · 1 failed to publish". Approvals badge = pending count ("6"), SR text "6 waiting for approval".

### 2.3 Footer (sidebar bottom)
- Trial card: bg paper-card, border rule, radius 12, height 50. Left: "TRIAL" (9.6/700 uppercase ink-mute) over "3 days left" (12/500 ink-soft). Right: black pill button "Activate" (aria "Activate subscription"). [not clicked]
- User row (button, aria "User menu"): 32px avatar circle bg brand-indigo with initial "T" (paper, 12/700); name "tiktok.test" (14/600) over email (12/400 ink-mute); chevron-up-down icon. Menu contents: "SIGNED IN AS" / name / email, then "Switch workspace", "Account settings", "Take the tour", "Log out".

### 2.4 Pipeline header (shared by Activity, Calendar, Approvals)
- Eyebrow "PIPELINE" (tomato), H1 = page name (Calendar shows the period instead: "October 2026", "Oct 11 – 17, 2026", "Monday, October 12, 2026").
- Subtitle: Activity "45 of 45 shown · click a row to unfold"; Approvals "6 items waiting." / "17 approved items." / "0 rejected items." / "45 total items."; Calendar none.
- Tab nav (`<nav aria-label="Content views">`, bottom hairline): three tabs 44px tall, icon + label 11.52/700 uppercase tracking 1.15px: "ACTIVITY", "CALENDAR" + red pill with small icon and count ("2", aria "1 need scheduling · 1 failed to publish"), "APPROVALS" + red count "6". Active tab text ink + 2px tomato underline; inactive ink-mute.
- Calendar-only header controls (right): "TODAY" outline pill (10.4/700 uppercase), round outline "Previous" and "Next" chevron buttons (36px).

---

## 3. Approvals (`/approvals`) — primary page

### 3.1 Layout
- Header (§2.4) then a filter row, then two columns: **list** (360px card, bg paper-card, border rule, radius 12) and **detail** (`<article aria-label="Approval detail: <title>">`, bg paper-card, border rule, radius 12, fills remaining width, gap ≈20px). The page scrolls as a whole; detail is tall.
- Default selection: first item in the list.

### 3.2 Filters
- "STATUS" + pill combobox (bg paper-card, border rule-strong, 11.2/600 uppercase). Options: "Pending" (default, checked tick), "Approved", "Rejected", "All". Maps to `?tab=`.
- "AGENT" + pill combobox showing "ALL" + count in ink-mute ("ALL 6"). Options with counts: "All 45", "Vee 32", "Riley 8", "Danny 3", "Luke 2" (counts are over all statuses in the "All" view).
- "× CLEAR" ghost button appears when a non-default filter is active.
- Empty state (e.g. Rejected): list card shows "NOTHING IN THIS FILTER" (small caps), detail card shows "Nothing rejected."

### 3.3 List item (`role=option`)
- Row ~97px, full-width, separated by hairlines. Selected row: bg paper-warm 70% and title weight 700 (others 600).
- Left: checkbox (16px, aria "Select <title>") — **only in Pending view**.
- 32px platform tile, radius 10: TikTok = ink bg + white TikTok glyph; LinkedIn = `#0A66C2`; image = mint; competitor/intel = `#E6EBF2`.
- Title 14.4/600–700 ink, one line, ellipsis.
- Meta line 10.4 uppercase ink-mute: platform/type ("TIKTOK", "LINKEDIN", "IMAGE", "COMPETITOR", "INTEL", "REPORT") and, when scheduled, " · THU, SEP 17, 4:58 PM".
- Pills row: agent ("VEE"), status (in Approved/All views: "PUBLISHED", "NEEDS SCHEDULING", "PENDING", "SAVED", "PUBLISH FAILED", "ARCHIVED"), and "EDITED" when a human changed it.

### 3.4 Bulk selection
Ticking any checkbox shows a sticky bottom bar across the content area: left "1 SELECTED" (count), right buttons "Approve" (green filled), "Archive" (outline), "× Clear". [actions not clicked]

### 3.5 Detail — header (all states)
- 28px platform tile + H2 title (16/600).
- Meta: "Post · TIKTOK" (+ " · SCHEDULED Thu · Sep 17, 4:58 PM" when scheduled) 10.4 ink-mute, separator dots at 60% opacity.
- Status tag (radius 4, 10.4/400): "Awaiting review" (paper-warm), "Needs scheduling" (paper-warm), "Published" (mint-deep text on mint/10%), "Publish failed" (paper-warm, neutral).
- "Open in chat" link with chat icon → `/conversations/<id>`.

### 3.6 Detail — "Post preview" (pending TikTok)
- Section title "Post preview" (14/700) with "Edit caption" ghost button at right. Preview is a centred 540px card (bg paper, border rule-strong, radius 12):
  - 40px ink avatar circle with "T", name "Tiktok Test" (14/600), sub-line "Choose an account to finalize the preview" (12 ink-mute) until a publish account is picked; once scheduled the sub-line shows the time "THU · SEP 17, 4:58 PM" (uppercase). For a published/failed post the avatar is the account photo and the name the account's display name.
  - Caption 16/400 ink, preserving line breaks (some captions show literal `\n\n`).
  - Media: video player (`<video aria-label="Post video">`) or image (button "Open Post image full size"), radius 10, bg paper-warm; round "Download" button top-right (aria "Download Post video"/"Download Post image").
  - Under media (pending only): "Remove video" (ghost, trash icon) and "Change" (outline pill). LinkedIn posts instead show a thumbnail strip ("Image 1 of 1" selected with mint-deep border, small × "Remove image 1 of 1"), a dashed "+" "Add image" tile and "Change".
  - LinkedIn preview variant is white with LinkedIn chrome ("Draft · 🌐") and a reactions row ("0 0 0").
- "Why Vee made this" disclosure (chevron, 14/400 ink-soft) → expands one paragraph of rationale, e.g. 'Addresses the "Senior-Only Production Rigor" pillar by calling out the financial impact…'.

### 3.7 Detail — facts row
Inline label/value pairs (label 10.4 ink-mute, value 12 ink): "Scheduled Thu · Sep 17, 4:58 PM" (when set), "Type Post", "Length 447 chars", "TikTok <summary>", "vee's confidence ★ High · 95%" (value mint-deep).

TikTok summary string = `<audience> · <type> · <comments>`:
- audience: "Only me" (SELF_ONLY), "Friends" (MUTUAL_FOLLOW_FRIENDS), "Choose audience" (unset), or "To TikTok inbox" when post_mode is draft/inbox; [labels for FOLLOWER_OF_CREATOR / PUBLIC_TO_EVERYONE not observed — likely "Followers"/"Everyone", inferred]
- type: "Video" / "Photo"
- comments: "Comments on" / "Comments off"
Observed inconsistency: one pending item's summary read "Friends · Video · Comments on" while its settings popover showed no audience and comments unchecked — the summary seems to reflect agent-proposed values, the popover the saved settings.

### 3.8 Detail — publish panel (pending TikTok only)
Top-bordered section, padding ~32px:
- Helper: "Choose a TikTok account when you’re ready to publish. You can keep preparing this post."
- Two columns:
  - "Publish from" (12/500 ink-soft) + 48px select (bg paper, radius 10) placeholder "Choose an account…". Dropdown lists connected TikTok accounts: 32px round avatar + display name (12/600) + "TikTok" (10.4). Validation text below in tomato 11.2 (role=alert): "Choose which @account this publishes to".
  - "Publish at" + `datetime-local` input (48px), preset chips "Now", "In 1 hour", "Tomorrow 9:00", helper "Choose a time to schedule." (10.4 ink-mute).
- Footer action bar (top hairline):
  - Left: "Reject" (outline red, X icon, tooltip/aria "Reject & tell why"), "Edit" (cream, pencil, aria "Edit inline"), "Archive" (outline, box icon, aria "Archive"), and a 40px round "⋯" button (aria "TikTok settings", `aria-haspopup=dialog`) with a 10px **red dot** when settings need attention. This "⋯" is the "three dots" referred to in the Loom.
  - Right: "Approve" (outline green, check icon) and "Schedule" (filled green, calendar icon). Both **disabled** with `title="Choose which account this publishes to first"` until an account is chosen.
- LinkedIn pending items show only "Publish at" + presets + the same footer (no account picker, no ⋯).

### 3.9 TikTok settings popover (the "⋯")
304px popover, bg paper-card, border rule-strong, radius 12, anchored above the button:
- Heading "TIKTOK SETTINGS" (10.4/700 uppercase ink-mute).
- Intro: "Prepare your post now. Account settings and publishing consent can be confirmed before scheduling."
- Toggle row: "Send to the TikTok inbox instead of posting" (switch, off) → `post_mode` draft vs direct.
- "WHO CAN VIEW" select, placeholder "Choose audience…"; **disabled** until an account is chosen [options not inspected; enum values from data: `SELF_ONLY`, `MUTUAL_FOLLOW_FRIENDS`, `FOLLOWER_OF_CREATOR`, presumably `PUBLIC_TO_EVERYONE`; per TikTok rules options should come from the creator-info API].
- "POST TYPE" radio "Video" / "Photo" (disabled), helper "Set by what the post carries — attach a video or images to change it."
- Divider, checkboxes (right-aligned): "Allow comments", "Allow Duet", "Allow Stitch" (all unchecked by default observed).
- Toggle: "AI-generated content" (on, mint-deep track) → `is_aigc`.
- Divider, helper "Disclose whether this content promotes yourself, a brand, product or service." + toggle "Disclose commercial content" (off). [sub-options when enabled **not inspected** — the toggle click was denied; data fields are `brand_organic_toggle` ("Your brand") and `brand_content_toggle` ("Branded content"), labels inferred]
- Footer: "Cancel" (ghost) and "Save settings" (green pill). [not clicked]
- Switch style: 34×19 track, 15px knob paper; off track `rule-strong`, on track mint-deep.

Settings data model (from the activity diff log):
```json
{"is_aigc":false,"post_mode":"direct|draft","content_type":"photo|video",
 "privacy_level":"SELF_ONLY|MUTUAL_FOLLOW_FRIENDS|FOLLOWER_OF_CREATOR",
 "disable_comment":false,"disable_duet":true,"disable_stitch":true,
 "auto_add_music":true,"consent_accepted":true,"creator_account_id":"<uuid>",
 "disclose_commercial":false,"brand_content_toggle":false,"brand_organic_toggle":false}
```
Other logged fields: `VIDEO_ATTACHMENT_ID`, `PUBLISH_ACCOUNT_ID`; one caption contained an inline `[TikTok Config: {"publish_account_id":…, "content_type":"photo", "disable_duet":false, "post_mode":"draft"}]` block.

Consent UI: the Music Usage Confirmation text ("By posting, you agree to TikTok's Music Usage Confirmation." linking to `https://www.tiktok.com/legal/page/global/music-usage-confirmation/en`, new tab) and "After publishing, TikTok may take a few minutes to process your post and show it on your profile." were seen only in the Calendar failed-post popover. [Where consent appears on the approve path was not observed.]

### 3.10 Reject flow (opened, not confirmed)
Clicking "Reject" replaces the publish panel and footer with:
- Label "REASON (OPTIONAL — TEACHES THE AGENT)"; textarea (70px, bg paper-warm) placeholder "e.g., wrong tone, already said something similar, not now…".
- Right-aligned "Cancel" (ghost) and "Confirm reject" (tomato, radius 12). Media controls are hidden in this mode.

### 3.11 Edit caption / Edit content (opened, cancelled)
"Edit caption" turns the detail into an editor section "EDIT CONTENT":
- "POST TEXT" + live counter at right ("636 CHARS"), textarea with the caption.
- "HASHTAGS": text input placeholder "brand, launch, story" + "Add" button (disabled when empty).
- "IMAGE": "Choose images" button + "0 of 35 for TikTok".
- "VIDEO": current video with round × "Remove video"; helper "Up to 200 MB. MP4, MOV or WebM (WebM is TikTok only — Instagram requires MP4 or MOV). TikTok: 23–60 fps, 360–4096 px on each side, up to 10 minutes. Instagram: MP4/MOV (H.264 or HEVC, AAC), 3 s–15 min, up to 1920 px wide, 9:16 recommended."
- "NOTE (OPTIONAL)" textarea placeholder "e.g., tightened the hook".
- "Cancel" / "Save changes" (green, radius 12).
[The footer "Edit" (aria "Edit inline") button was not clicked; presumed to open the same editor.]

### 3.12 Other detail states
- **Needs scheduling** (approved, no time): banner row (bg paper-warm 50%) "Approved. Schedule this post to publish it." + red pill "Schedule in Calendar" → `/calendar`. Facts row then a cream button "Undo — return to pending". Then the Activity log.
- **Published**: no actions; facts row includes "Scheduled …"; Activity log.
- **Publish failed**: header tag "Publish failed"; facts + "Back to pending" outline pill; Activity log. (The error code is shown in the Calendar popover, not here.)
- **Activity log** (section "ACTIVITY", "Loading activity…" while fetching): entries "Edited & approved · Sep 16, 9:10 PM", "Approved · …", each optionally with a diff box (bg paper-warm, radius 10): field name small caps ("TIKTOK", "VIDEO_ATTACHMENT_ID", "PUBLISH_ACCOUNT_ID"), old value in tomato, new value in mint-deep, "—" for empty; or "No field-level changes recorded."

### 3.13 Approve → publish sequence (as observed; inferred steps marked)
1. Agent creates a draft → list shows "PENDING", detail "Awaiting review".
2. Reviewer optionally edits caption/media ("EDITED" pill is added), opens "⋯" TikTok settings and saves audience/interactions/disclosure.
3. Reviewer picks "Publish from" account (required; enables Approve/Schedule; enables "Who can view" — inferred).
4a. "Approve" without a time → status "NEEDS SCHEDULING"; appears in Calendar "Needs scheduling" panel and in the Calendar badge.
4b. Pick "Publish at" (or preset) → "Schedule" → item scheduled on the calendar (inferred: status becomes scheduled, then "PUBLISHED" or "IN TIKTOK INBOX" when post_mode is draft).
5. If publishing fails → "PUBLISH FAILED" (red chip in Calendar, red pill in Activity, Home "A post needs help publishing."). Recovery from the Calendar popover: "Retry at" + "Reschedule", or "Back to pending".
- Reject → "Rejected" filter; Archive → "ARCHIVED".

---

## 4. Calendar (`/calendar`)

- Header per §2.4 with "TODAY", Previous, Next.
- Row under tabs: "VIEW" + pill select ("MONTH" default; options "Month", "Week", "Day"); "× CLEAR" appears when view ≠ month.
- **Needs scheduling panel** (`section aria-label="Needs scheduling"`, bg paper-card, radius 12): title "Needs scheduling" + red count "1"; sub "Approved, not yet scheduled. Pick a time or drag onto a day to schedule."; SR hint "Drag onto a calendar day, or press Schedule… to pick a date and time." Each row: 24px ink TikTok tile, title (12/600), "Vee · No date chosen" (12 ink-soft), right red pill "Schedule…" (aria "Schedule <title>"). Rows are draggable onto days. [drag not tested]
- **Schedule… popover** (288px, radius 12): "Approved. This post won’t publish until you schedule it."; "PUBLISH AT" label; `datetime-local` prefilled with tomorrow 09:00 (`2026-10-15T09:00`); presets "Now", "In 1 hour", "Tomorrow 9:00"; full-width red "Schedule" button with calendar icon. [not confirmed]
- **Month grid** (`role=region aria-label="Calendar grid"`, border rule, radius 12): header row bg paper-warm, "SUN … SAT" 9.6/700 uppercase ink-mute; cells ~96px tall, bg paper-card (out-of-month cells paper-warm 40%), 1px rule gaps; day number 9.6 ink-mute top-left; **today** = number in an 18px tomato circle (paper text).
- **Chips** (draggable `role=button`, radius 10, 9.92px): 18px TikTok tile + title (ellipsis) on line 1, uppercase status line 2.
  - Published / In TikTok inbox: bg ink, text paper ("PUBLISHED", "IN TIKTOK INBOX").
  - Failed: bg tomato-soft, text tomato, border tomato/40% ("PUBLISH FAILED").
  - Week/Day views add the time: "10:52 AM · PUBLISH FAILED". Week view = 7 columns for "Oct 11 – 17, 2026"; Day view = single list "12 Monday".
- **Chip popover** (published): title, "TIKTOK · PUBLISHED", "Mon, Aug 31, 04:26 PM", caption excerpt, black "Open" button → `/approvals?item=<id>&tab=approved`.
- **Chip popover** (failed): title, "TIKTOK · PUBLISH FAILED", "Mon, Oct 12, 10:52 AM", caption, media preview, "Open" → `/approvals?item=<id>&tab=all`; red box "PUBLISH FAILED" + error code (e.g. `tiktok_init_http_403_url_ownership_unverified`); "RETRY AT" datetime-local (prefilled ≈ now+1h); Music Usage Confirmation line and processing notice; green "Reschedule" button; outline "Back to pending". [not clicked]

---

## 5. Activity (`/work-items`)

- Header subtitle "45 of 45 shown · click a row to unfold".
- Filters: "STATUS" (All 45, Pending 6, Saved 14, Approved 1, Published 16, Publish failed 1, Archived 7) and "TYPE" (All 45, Post 31, Image 3, Brief 1, Intel entry 5, Competitor scan 4, Weekly report 1). Options show counts.
- One card grouped by period; group header bar "EARLIER" with total "45" at right (bg paper-warm).
- Row (66px, `button aria-label="Expand <title>"`, chevron right): 32px type tile; title 14 ink; meta uppercase ink-mute "TIKTOK · POST · SEP 11 · SCHED OCT 12, 10:52 AM" (the SCHED part in tomato), or "COMPETITOR SCAN · 6D AGO"; right: agent pill + status pill (§1.6).
- Expanded row: "Post preview" with caption, "Why Vee made this", "Open in chat". URL gets `?item=<id>`.

---

## 6. Integrations (`/integrations`)

- Eyebrow "SETTINGS", H1 "Integrations", sub "Connect the channels you publish to. Brandora reads, posts and replies on your behalf."
- "CONNECTED ACCOUNTS · 2": list card; each row = 20px avatar, display name (14/600), "TIKTOK" (9.92 uppercase ink-mute), right "CONNECTED" mint pill and a round × (aria "Disconnect <name>"). Below: "2 OF 2 CONNECTIONS USED." + red "UPGRADE" link.
- Search input (pill, 448px) "Search integrations…".
- Categories, each "<NAME> · N" with hairline, 3-column grid of 347px cards (radius 12, bg paper-card, fade-in animation): 48px coloured icon tile, status pill top-right, H3 name, description, action.
  - Social channels · 5: "LinkedIn" ("Share posts to your personal LinkedIn profile."), "LinkedIn Page", "Instagram" (red tile) — black "Connect … →" buttons **disabled** with "Plan limit reached. See plans". 
  - **TikTok card**: pill "● CONNECTED · 2" (mint, dot), black tile, "TikTok", "Connect your TikTok account.", list of connected accounts (avatar + name + small ×), outline pill "Add another TikTok" (disabled at plan limit).
  - "Threads" — "SOON" stamp, hatched background, "IN THE WORKS".
  - Advertising · 1: "Meta Ads" ("Connect Meta Ads"). Email · 1: "Gmail" (soon). Analytics · 2: "Google Analytics", "Plausible" (soon). Communication · 2: "Slack", "Discord" (connect). Productivity · 2: "Linear" (connect), "Notion" (soon).
- Footer line: "✦ WANT AN INTEGRATION THAT ISN'T LISTED?   TELL US  ✦".
- [Connect / post-connect popup not inspected. The Loom says that after connecting, a popup appears where the user continues; contents unknown.]

---

## 7. Home (`/dashboard`)

- Top bar: search icon, "History".
- Dark strategy banner (bg ink, radius 12): "● Your active strategy" (tomato dot), "View strategy ↗", objective text (bold paper), "The direction behind your team’s current work."
- Greeting "Good morning, tiktok.test. Here’s what needs you, and what’s moving." and "On this page" anchors: "Your next step", "Team activity", "Results", "Research & evidence".
- "Your next step" card: "A post needs help publishing." / "Open Calendar to inspect the failed publication and its recovery options." / red "Resolve publishing →" (→ calendar week view of the failed date); "6 other items awaiting review" (→ approvals); tomato-soft row "1 approved post needs scheduling · Schedule posts →"; "1 task needs attention".
- "Team activity" (weekly cycle cards with "BLOCKED"/"CANCELLED" states, "Review drafts", "Details", "Cancel"), "Results at a glance" (Publishing: "0 posts published", "Last 7 complete days", "No change vs previous 7 days"), Performance (LinkedIn empty state), "What could shape the next move" research cards ("Read research", "riley · 13 Sep 2026", "high confidence").
- Bottom chat composer (fixed): textarea, "AUTO" mode pill, "Prompt library", "Attach files", "ENTER TO SEND", round send button; agent tag chips "@MEL ·default·", "@DANNY", "@RILEY", "@LUKE", "@VEE", "TAG FOR 1 TURN".

## 8. Brand (`/brand`)
Eyebrow "FOUNDATION", H1 "Your brand", sub "The identity behind everything your team creates.". Tabs "Brand kit" / "Business". Sections: "BRAND KIT" + "Edit"; "Brand logo" ("Dark background"); "Color palette" (swatches with role + hex + "Detected from the site"; "Click a swatch to copy."); "Typography" (Headings/Body samples with "Aa"); "Imagery style"; "Brand voice"; "Things to avoid"; "Reference imagery" ("Approved references 0 / 4", "View reference guide", "Add images"); "Reference guide · GUIDE ONLY" with Do's/Don'ts examples.

## 9. Strategy (`/strategy`)
"Your strategy" / "The direction behind everything your team creates." Buttons "Export", "Discuss with Mel". Sections each with "Discuss <X> with Mel": positioning, "Active strategy · Since 28 Aug 2026", objective, tabs "Overview | Targets | Content pillars | Channels & rhythm | Execution | Narrative", key results ("KEY RESULT 01", target, "12 weeks"), pillars (01–03), channels ("LinkedIn 3×/WK NOT CONNECTED CONNECT", "Company Blog 1×/WK"), tactics, narrative.

## 10. Competitors (`/competitors`)
"Who you're tracking and what changed. Riley adds and rescans competitors in chat." "You're tracking (1)" card: "DIRECT · COMPETITOR", "STOP TRACKING", name, domain link, "Scanned 1 week ago · <latest change>", "Ask Riley about …", "WHY THIS COMPETITOR", "PAGES TO WATCH 3/3" (BLOG/PRODUCT/HOMEPAGE). "Suggested by Riley (2)": "SUGGESTED", "Activate tracking", "Ask Riley why", "PAGES RILEY SCOUTED".

## 11. Performance (`/performance`)
"How your published posts are doing — the same numbers each platform shows you." Controls "All channels", "7 days" / "30 days" / "90 days". Empty state "Publish your first post — its numbers appear here about an hour later." + "Open the calendar".

## 12. Workspace (`/settings`)
"Name, people, plan, usage and notifications for this workspace." Tabs "General | Members | Plan | Usage | Notifications" (`?tab=`). General: "OWNER", workspace name + "Rename", "CREATED", "WORKSPACE ID". Plan: "Subscription", "TRIAL", "CURRENT PLAN Solo LEGACY", "STARTED", "TRIAL ENDS", "Subscription ending soon", "Trial period active", "Reactivate subscription" ($25/month). Notifications: table EVENT × EMAIL / SLACK (Connect) / DISCORD (Connect) for "Autopilot outcomes", "Daily standup", "Post published / failed", "Reconnect needed", "Competitor watch".

---

## 13. Loom (tab-1) "Syncing TikTok Approval and Publishing UI"
Visible transcript (rest gated): user connects their TikTok account on the Integrations page; after connecting "we're gonna have this pop-up" where they continue; then go to Approvals, open an item, and "give an option for all of these things… click on three dots" — i.e. the per-post TikTok settings behind the "⋯" button in the approval footer.

## 14. Not inspected / open questions
- Commercial-disclosure sub-options (toggle click denied), "Who can view" option labels (select disabled without an account), consent checkbox on the approve path.
- Post-connect TikTok popup on Integrations; Connect/Disconnect flows.
- Any confirm step: Approve, Schedule, Archive, Confirm reject, Save settings, Save changes, Reschedule, Back to pending, Undo, bulk actions, "Now/In 1 hour" presets (may schedule immediately).
- Footer "Edit" (inline), media "Change"/"Add image" pickers, drag-to-schedule, sidebar collapsed state, Members/Usage tabs, mobile layout.
