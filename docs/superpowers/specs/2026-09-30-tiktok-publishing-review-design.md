# TikTok publishing review and Brandora parity specification

Date: 2026-09-30
Status: Proposed specification, ready for review. Implementation has not started.
Requested scope: Specify the redesign of `/tiktok-publish`, its publishing behavior, and its implementation plan; save both locally.

## 1. Outcome and boundaries

Replace the current three-tab TikTok utility with a cohesive content review workspace, closely matching the observed Brandora Approvals experience while retaining POSTORA identity. Users prepare a video post, review exactly what will be sent and to which account, configure TikTok settings, explicitly authorize publishing or scheduling, and follow its actual outcome.

The target is high visual and interaction fidelity for the TikTok review area: queue, detail card, media preview, settings, schedule controls, actions, and feedback. Global Brandora navigation, its brand name/logo, AI agents, chat integration, and confidence scoring are outside this change. Do not invent confidence scores or a nonfunctional Open in chat button. Preserve the existing `/tiktok-auth` route.

This work does not guarantee TikTok approval. Brandora's approval status was supplied by the user and was not independently verified. Its backend implementation is not available from the inspected interface.

## 2. Evidence and limitations

Evidence collected during this chat on 2026-09-30:

| ID | Observation | Confidence / limitation |
| --- | --- | --- |
| E1 | Brandora Approvals has a selectable pending-post list and a detail pane with caption, video, destination account, audience/comments summary, and awaiting-review badge. | Observed in the authenticated live UI. |
| E2 | Brandora shows Change video, Remove video, Reject, Edit, Archive, TikTok settings, Approve, Schedule, Now, In 1 hour, and Tomorrow 9:00. | Controls observed; consequential actions were not executed. |
| E3 | One post lacked audience selection; another requested confirmation of settings for the selected account. Approve was disabled. Schedule displayed a missing-time explanation. | Observed; the complete validation hierarchy remains unverified. |
| E4 | Brandora uses ivory/beige surfaces, dark text, red/pink accents, a pale yellow waiting badge, and muted green action styling. | Visual description only; no exact CSS values, font names, or dimensions were extracted. |
| E5 | Brandora settings and editor did not open during inspection. | Unresolved interaction limitation; do not infer the content of those panels. |
| E6 | Postora has Publish Video, Schedule, and manual Check Status tabs; privacy starts blank and interactions start off on a clean form. | Live UI observed. |
| E7 | `TikTokPublish.tsx` sends interaction, commercial, and AI flags, but `tiktok-demo-publish/index.ts` ignores several of them and sets both commercial flags from one disclosure toggle. | Verified local source; server file hashes were not compared with this checkout. |
| E8 | The demo function returns a publish ID without persisting a corresponding platform post; the webhook searches `platform_posts.response_data` for the ID. | Verified local source; live webhook delivery was not tested. |
| E9 | The demo schedule path calls video init immediately and adds `post_info.schedule_time`. This property is absent from the inspected official Direct Post request schema. | Local behavior confirmed; a live scheduled post was not attempted. |
| E10 | Local-file immediate publishing checks duration. The schedule path and URL path do not provide equivalent verified duration checks. | Verified local source. |

Primary local references:

- [Current page](../../../src/pages/TikTokPublish.tsx)
- [Demo publishing function](../../../supabase/functions/tiktok-demo-publish/index.ts)
- [Webhook](../../../supabase/functions/tiktok-webhook/index.ts)
- [Existing publishing engine](../../../supabase/functions/process-post/index.ts)
- [Existing scheduler](../../../supabase/functions/process-scheduled-posts/index.ts)
- [Existing preview](../../../src/components/post/TikTokVideoPreview.tsx)
- [Architecture rules](../../../ARCHITECTURE.md)
- [Self-hosted deployment runbook](../../runbooks/deploy-edge-function.md)

Official references inspected during the comparison; recheck before implementation because provider contracts can change:

- [TikTok UX requirements](https://developers.tiktok.com/doc/content-sharing-guidelines)
- [Direct Post request](https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post)
- [Publish status and webhook overview](https://developers.tiktok.com/docs/en/content-posting-api-reference-get-video-status)
- [Media transfer](https://developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide)

## 3. Product decisions

Use the observed Brandora review structure as the target, then validate unobserved panels in a dedicated reference-capture task. Exact visual parity must not be claimed until computed styles or measured reference values and comparable screenshots exist.

Alternatives considered:

1. Restyle the existing three tabs: lowest effort, but preserves fragmented review and manual tracking.
2. Build a separate TikTok publishing backend: isolates the page, but duplicates dispatch, scheduling, retries, and webhook reconciliation.
3. Build a TikTok review feature over the existing publishing lifecycle: selected approach. It provides the requested interface while keeping durable publishing and scheduling in one operational flow.

The review queue belongs to the authenticated user's active TikTok account. The first release supports owner review, not a new team approval/permissions product. Users can create a draft and import/select their own existing media. Existing posts must not be silently converted into new drafts or republished.

## 4. Global constraints

- Route: `/tiktok-publish`; preserve `/tiktok-auth`.
- Runtime API base comes from configured Supabase environment variables; production is self-hosted.
- Keep POSTORA identity; use Brandora's observed review structure as the visual reference.
- English review copy is the baseline; all layout must remain compatible with Arabic and RTL.
- No provider upload or publication before explicit user consent.
- Consent is bound to user, account, draft revision, media, settings, and requested publish time.
- Every ownership check must be enforced server-side, including service-role paths.
- Failed reads must remain errors; they must not become empty drafts or unrestricted publishing.
- New schema must be applied before dependent functions or frontend are released.
- Do not add another scheduler or publish directly from a browser timer.
- No claimed exact Brandora parity without measured reference evidence.

## 5. Screen and visual requirements

### R1: Layout

Desktop uses a header with pending count, a compact filter row, a selectable post queue, and a larger detail card. The detail card contains, in order: post title/status, preview, post/settings summary, validation feedback, destination account, schedule controls, and review actions. At narrow widths the queue and detail become separate stacked views with a clear Back to posts action. No horizontal overflow at 390px.

Reference capture must record the viewport, scroll position, selected item, exact color values, font family/weight/size, spacing, border radius, border/shadow values, and default/hover/focus/disabled/error states. Record values as reference measurements only when obtained from the actual page. Proposed fallback styling must be labeled as a POSTORA design decision.

The page has scoped style tokens so the change does not alter the rest of the dashboard. Match Brandora's surface and action roles, including ivory main surface, beige secondary surface, dark text, red destructive/validation accents, yellow awaiting-review badge, green positive actions, and rounded controls. Any contrast adjustment is documented. No imitation branding or invented agent score.

### R2: Queue and draft management

Filters: account and review status. Default to pending review. Selecting a row loads that draft without saving or publishing it. Pending count comes from authorized durable records. Loading, empty, failed-load, and stale-edit states must be distinct. Drafts survive refresh and navigation. Persist a local recovery copy only as a convenience, scoped by user/account/draft; never restore consent as already granted.

### R3: Preview and editing

Show account nickname/avatar, editable caption, and video playback. Reuse `TikTokVideoPreview` where it meets the reference. Use a single caption editor with an accurate counter; preserve existing draft title/description content when transitioning to the combined representation. Do not silently truncate text.

Change video opens media selection; Remove video clears the draft attachment, invalidates consent, and disables submission until valid media exists. This action does not delete the underlying media library object. Edit opens an explicit editable state with Save and Cancel. Cancel restores the last saved revision. All preview updates must reflect the draft actually submitted.

### R4: TikTok settings

Fetch fresh creator information when entering review, changing accounts, and before submission. Block submission during load, errors, posting restrictions, or when media duration cannot be validated. Show Retry for recoverable reads. Privacy choices must come from the current creator response and require explicit selection; account/media changes clear incompatible choices.

Comment, Duet, and Stitch begin off for a new draft. Disabled creator capabilities remain greyed out with a reason. Both UI and server enforce these restrictions. Validate video type, size, duration, and transfer constraints for local and URL sources, including scheduled content.

Commercial disclosure exposes Your brand and Branded content independently and requires at least one when enabled. Enforce the provider's privacy restrictions and corresponding consent wording. AI-generated content maps to `is_aigc`. No flag may be displayed as accepted but discarded by the server.

### R5: Scheduling and actions

Display destination account beside publishing controls. Show the user's time zone explicitly, retain its identifier, and store execution timestamps in UTC. Provide Now, In 1 hour, Tomorrow 9:00, and a date/time picker. Now selects immediate mode; a schedule action requires a future instant. Reject past or invalid times and explicitly resolve nonexistent/ambiguous DST times.

| Control | Required behavior |
| --- | --- |
| Reject | Open a reason dialog; require a nonblank reason; save a rejected review state and keep the content editable for resubmission. Cancel changes nothing. |
| Edit | Enter the editor without publishing; saving increments revision and invalidates consent. |
| Archive | Move an unsubmitted draft to a reversible archived state. Do not treat archive as cancellation of an already scheduled/submitted post. |
| TikTok settings | Open an accessible panel with account-specific settings and explicit confirmation for the current draft revision. |
| Approve & publish | Authorize and dispatch an immediate post only after all requirements and consent are satisfied. The visible action must make its publishing consequence clear. |
| Schedule | Authorize the reviewed revision for its future time and create a durable scheduled job. Do not call provider init at schedule creation. |
| Next | Select the next queue item without modifying either post. |

Brandora labels its positive action Approve. POSTORA will label the consequential action Approve & publish unless reference verification proves approval is a separate non-publishing step, in which case keep separate approval and publish controls and document that adjustment before coding.

Provide a concise visible reason beside disabled submit controls. Keyboard shortcuts A/R/Right are active only outside editors, dialogs, and editable elements; A opens the same explicit confirmation as the button and never bypasses consent.

### R6: Submission and outcome

Saving a draft and selecting a file must not send material to TikTok. At final consent, persist an immutable submission snapshot, request identity, and authorized destination. A duplicate click or network retry with the same request identity returns the existing attempt. Changing content requires a new review revision.

Show Scheduled, Queued, Uploading/Processing, Published, Failed, and Needs attention with accurate meanings. A provider `publish_id` means accepted/processing, not published. Explain that TikTok processing can take several minutes. Show the eventual post link only when returned/confirmed. Provide retry only when it cannot create an unnoticed duplicate; ambiguous submission outcomes require reconciliation first.

Automatic status tracking uses the provider status endpoint and verified webhook events. Manual refresh remains available on the relevant post; users do not have to copy a publish ID into another tab.

## 6. Architecture and data contracts

Keep `src/pages/TikTokPublish.tsx` as route composition. Introduce `src/features/tiktok-publishing/{domain,application,infrastructure,ui}` following ARCHITECTURE.md. UI talks to application ports, and only the feature composition root constructs infrastructure adapters. Reuse the existing preview and publishing infrastructure where compatible.

Review state is separate from publishing state. Draft review states: draft, pending_review, rejected, archived, submitted. Publishing state is read from durable attempts and existing `posts`/`platform_posts`; never overload one status to mean both approval and provider publication.

Proposed persistence extension: `tiktok_review_drafts`, with owner/account identity, revision, content/settings, media reference, review state, rejection reason, and timestamps; plus a durable link from a submission revision to existing `posts` and provider attempts. Reuse an existing equivalent draft/attempt relation if discovery proves it enforces the same guarantees. The first implementation task must record the exact schema and existing creation RPC/transaction boundary before migrations are authored. This is a bounded integration decision, not permission to create a second publishing engine.

Required atomic operations: save a revision with optimistic concurrency; reject/archive an authorized revision; submit an authorized revision once and create/link its publishing job. Cross-user account, media, draft, and post combinations must be impossible through these operations. Define grants and RLS for new relations, and audit service-role writes structurally. Additive migrations must remain compatible with the old UI.

Provider mapping is an explicit contract:

| User choice | TikTok payload |
| --- | --- |
| Caption | `post_info.title` |
| Audience | `post_info.privacy_level` |
| Allow comment | `post_info.disable_comment = !allowComment` |
| Allow Duet | `post_info.disable_duet = !allowDuet` |
| Allow Stitch | `post_info.disable_stitch = !allowStitch` |
| Your brand | `post_info.brand_organic_toggle = disclose && yourBrand` |
| Branded content | `post_info.brand_content_toggle = disclose && brandedContent` |
| AI generated | `post_info.is_aigc = aiGenerated` |

Runtime validation checks the latest creator capabilities server-side. Source selection follows the provider media-transfer contract: owned/verified URL source or supported file transfer. Never persist temporary signed upload URLs or tokens as normal job metadata. Restrict any server fetching to the existing approved media ingestion boundary with SSRF protection.

## 7. Scheduling, webhook, and failure requirements

Scheduled jobs execute through the existing scheduler. Revalidate account connection, creator capabilities, content limits, and the authorized snapshot at execution. If settings became invalid, move to Needs attention instead of silently changing the user's choices. Editing or cancelling a scheduled job must use the scheduler's lifecycle rules and invalidate the prior authorization where content changes.

Provider init results must be associated with the attempt before normal status processing. Handle a webhook that arrives before association by durable reconciliation, not permanent loss. Verify the actual official event envelope, event names, signature header, timestamp policy, and ID format before editing the existing webhook: current local assumptions are not proof of the provider contract. Duplicate/out-of-order events must not duplicate publication or regress terminal state. A request timeout after provider acceptance must not trigger blind re-init.

Every refusal writes a sanitized log row with reason and request/job identity. Log validation failures, creator-info failures, restrictions, and unmatched webhook reconciliation. Do not log credentials, video base64, signed URLs, or full sensitive payloads.

## 8. Acceptance criteria

| ID | Required evidence |
| --- | --- |
| AC1 | Reference inventory includes settings/editor and measured visual values, or explicitly records the blocked states; no false exact-parity claim. |
| AC2 | Comparable desktop screenshots and 390px mobile review show queue, preview, settings, time, destination, and actions without overflow. |
| AC3 | Reload preserves draft content; user/account changes do not restore another draft or consent. Conflicting edits are refused. |
| AC4 | Each interaction/commercial/AI setting reaches the captured TikTok request correctly, including false values. |
| AC5 | Creator-info errors, missing audience/consent/media, invalid disclosure, blocked account, and invalid duration prevent init with a visible reason. |
| AC6 | Scheduling creates no immediate provider init. A due job executes once, and changed capabilities require attention. |
| AC7 | Duplicate clicks, concurrent submitters, and retry-after-timeout cannot cause blind duplicate publication. |
| AC8 | UI updates from processing to confirmed success/failure automatically; duplicate, early, malformed, and out-of-order webhooks are handled. |
| AC9 | Cross-user account/media/post access is denied at the server/database boundary. |
| AC10 | Reject/Edit/Archive/Next, dialog cancellation, keyboard operation, and focus restoration behave as specified. |
| AC11 | An authorized controlled live post proves consent, transfer, status completion, and resulting TikTok visibility; scheduled behavior gets separate live evidence. |
| AC12 | Recording demonstrates the actual shipped flow with original authorized media and includes processing/error explanations; approval is never represented as guaranteed. |

## 9. Release and completion

Complete reference and integration discovery, land additive schema before dependent code, then roll out durable publishing and the review UI. Verify self-hosted function hashes and frontend version after deployment using the repository runbook and Contabo tooling. Keep pre-release legacy data readable. On rollback, disable new submission entry points while allowing accepted jobs and status reconciliation to finish; never delete queued jobs or revert schema destructively.

The implementation plan is [2026-09-30-tiktok-publishing-review-plan.md](../plans/2026-09-30-tiktok-publishing-review-plan.md). Completion requires every acceptance criterion to have evidence or a specifically documented blocker. Documents alone are not an implemented or deployed feature.
