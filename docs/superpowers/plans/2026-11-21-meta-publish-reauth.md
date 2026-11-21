# Meta publishing reauthorization implementation plan

**Goal.** Surface a revoked native Facebook Reel or Instagram publishing grant in the existing dashboard reconnect flow.

**Architecture.** Bind an observer to the account snapshot used by the native publisher. Inspect essential Graph replies before they lose their structure and conditionally update the original account. Keep the observer independent of provider retries and result settlement.

**Stack and delivery.** Deno 2.9.8, TypeScript, existing Supabase client, mocked Graph transport. Approved Medium, no migration. Plan by Astra 6.2 medium, no debate elected. One OpenCode MiniMax M3.1 Flash Coding Plan implementer executes steps 1–5 sequentially, including tests. Parent owns independent review and delivery. [Design and evidence](../specs/2026-11-21-meta-publish-reauth-design.md)

### 1. Pin behavior with deterministic fixtures

- [ ] Create `supabase/functions/process-post/metaPublishReauth.test.ts`. Use Deno tests, synthetic identifiers, an in-memory account table and a recording update builder. Make the fake apply every filter to its rows. Keep two owners, two same-owner rows and both platforms in the fixture. Use a unique fake token marker in the provider message, URL and fake thrown storage error. Capture all diagnostics and returned/persisted errors. Assert they omit the marker.
- [ ] Drive the observer with this input table. Every test starts with an active account and future expiry. A positive match writes only the reconnect flag and stable human-readable reason.

| HTTP and payload | Expected new account writes |
| --- | --- |
| 400, top-level error with type OAuthException, code 190, error_subcode 458, arbitrary localized message | 1 |
| 200 with the same error envelope | 1 |
| 200 with an id, or 400 containing the sample message alone | 0 |
| 190 without 458, subcode 458 without the matching type/code, string numeric fields | 0 |
| Permission 10/200, content 100, throttle 4/17/32/613, 429, 408, 425, explicit is_transient, generic 5xx, timeout or unreadable JSON | 0 |
| 5xx with all three definitive fields and no conflicting retry signal | 1 |

- [ ] Run the targeted suite from repo root. Before implementation expect failure on the missing observer or assertion. After steps 2–4 expect all cases green.

```sh
deno test --allow-env --node-modules-dir=none --import-map=.github/deno/process-post-import-map.json supabase/functions/process-post/metaPublishReauth.test.ts
```

### 2. Implement the account-bound observer

- [ ] Create `supabase/functions/process-post/metaPublishReauth.ts`. Use `parseMetaError(status, reply)` and `isPermanentMetaError(parsed)` from `../_shared/metaErrors.ts`. Further restrict by the exact typed tuple from step 1 and explicit retry signals. Consume the parsed reply once. Never use message matching or project the raw body into a log.
- [ ] Define `type ObserveMetaReply = (status: number, reply: unknown) => Promise<void>`. Construct it from the trusted post owner and the native row supplying the request credential. Require row id, native platform, original nonempty token and original database timestamp string. Bind it to that token's request path. Skip on a missing snapshot, token substitution or unsupported platform. Keep the token out of the persistence port and logger. The binding is per account and per invocation.
- [ ] The persistence adapter uses one conditional update. The query below shows its complete write set and predicates. Preserve timestamp precision exactly as read from Postgres. Implement a bounded write using the client's abort signal within the request budget. Start it without making provider retries or later destinations wait for storage. Await only started writes during request cleanup. Handle both a resolved Supabase error and a rejected promise. Emit a stable `meta_publish_reauth_write_failed` warning with account id and platform only. A zero-match acknowledgement needs no retry. Prevent duplicate writes/warnings from parallel child observations in the same attempt by sharing the in-flight promise.

```ts
const result = await supabase.from("social_accounts")
  .update({
    needs_reauth: true,
    last_refresh_error: "Meta authorization was revoked. Reconnect this account.",
  })
  .eq("id", snapshot.accountId)
  .eq("user_id", snapshot.postOwnerId)
  .eq("platform", snapshot.platform)
  .eq("is_active", true)
  .eq("updated_at", snapshot.updatedAt)
  .or("needs_reauth.is.null,needs_reauth.eq.false")
  .abortSignal(signal);
```

- [ ] In the fake, interleave a refresh just after provider dispatch, then a same-token reconnect that clears reauth and advances the timestamp. Test these as separate races. Both old observations must match zero rows. Also cover mismatched owner/id/platform, inactive rows, legacy null flags, repeated failures across invocations, missing timestamp and unrelated row modifications. Assert the query never places a token in its URL or filters. Storage denial or timeout must leave the original publish outcome intact.

### 3. Observe essential native responses at the call sites

- [ ] Modify `supabase/functions/process-post/index.ts`. Extend its local `SocialAccount` type with the original timestamp, retain the tenant from `post.user_id`, and bind observers at the native dispatch. For `postToFacebook` pass it into `postFacebookReel` only. After each of its start/upload/finish JSON reads, await the observer before the existing success/error branch. Replace raw reply logging at these sites with allowlisted diagnostics. Preserve stage-specific failure context and use credential-safe output.
- [ ] Pass the observer through `postToInstagram` and `postToInstagramBusinessLogin`. Cover primary story, image, Reel and carousel container creation, including the callbacks passed to `createCarouselChildren`. Observe the actual response status and decoded envelope in the callback before returning the reply. Cover both `publishInstagramMedia` and `publishBusinessLoginMedia` in their `publishContainer` transport closures. Do not throw from the observer into the final POST's unanswered-request catch. Preserve error code and subcode for existing publish retry decisions. Sanitize any logging or exposed message at the touched boundaries before downstream code uses it.
- [ ] Modify `supabase/functions/_shared/metaContainerStatus.ts` with an optional `observeReply?: (status: number, reply: unknown) => Promise<void>` on poll options, invoked once on a decoded Instagram reply before the existing classification. Forward it from both native status wrappers and carousel child polls. If needed, extend `supabase/functions/process-post/carouselChildren.ts` options to forward that same callback. Thread it through `checkContainerOnce` too. On a non-OK one-shot response, inspect safely and still return its existing waiting state. Preserve all Threads behavior and existing status retry deadlines. Keep status URLs and raw reasons out of diagnostics. No new Graph requests.
- [ ] Format native Instagram errors for display in `instagramPublish.ts` after preserving the original provider reply for retry classification. Keep `graphResponse.ts`, `deferredPublish.ts`, `postSettlement.ts`, the scheduler, n8n, OAuth writers and dashboard read-only. Do not introduce a second retry decision, resubmit a container, or change notification, platform result or checkpoint contracts.

### 4. Prove native publishers use the observer

- [ ] Add `supabase/functions/process-post/metaPublishReauthRoutes.test.ts`. Exercise actual native publisher functions with fake fetch, time, storage and settlement ports. A narrow named export of those existing functions in `index.ts` plus a hermetic test import with the Deno.serve registration stubbed is acceptable. Restore every stub. Keep fixture paths free of live environment variables and public network. An observer-only test or source-text assertion cannot prove the wiring.
- [ ] Inject a structured failure separately at FB Reel start/upload/finish. Verify the failing stage, a single scoped update and no later provider publish call. For each IG host, exercise a create failure, carousel child failure, poll failure and final media_publish failure. Exercise a resume from a saved container with fresh credentials, and a final POST timeout followed by a one-shot auth failure. Check the latter preserves uncertainty and the existing container id, does not create another container and emits the reconnect observation.
- [ ] Exercise success, mixed account results, an already successful story alongside a failed primary publish, a transient deferred poll, and a best-effort permalink/comment failure. Compare result ids/statuses and provider call counts with the existing tests. Verify zero writes for unrelated failures. Inspect captured console output, stored reason and returned errors for the synthetic token, signed URL and authorization header. Run step 1's command again with both test file paths.

### 5. Validate using the repository CI commands

- [ ] Run the process-post CI step verbatim in Bash. The directory suite discovers the new hermetic tests automatically. Expected result is successful typechecking and no test failures, with guarded live tests skipped.

```sh
set -euo pipefail
map=".github/deno/process-post-import-map.json"
deno check --node-modules-dir=none --import-map="${map}" supabase/functions/process-post/index.ts
deno check --node-modules-dir=none --import-map="${map}" supabase/functions/process-scheduled-posts/index.ts supabase/functions/enqueue-post-publish/index.ts
deno test --allow-env --node-modules-dir=none --import-map="${map}" supabase/functions/process-post/ supabase/functions/_shared/composioFiles.test.ts supabase/functions/_shared/postProcessingClaim.test.ts supabase/functions/_shared/publishRequest.test.ts supabase/functions/process-scheduled-posts/ supabase/functions/enqueue-post-publish/
```

- [ ] Using CI Node 22.14.0, run `npm ci --no-audit --no-fund`, `npm run typecheck`, `npm run build`, `npm run test -- --shard=1/2` and `npm run test -- --shard=2/2`. Expect exit 0. Run clean-code-guard on production changes and test-guard on tests. Inspect `git diff --check`, the scoped diff and test selection. Commit only the task files. Leave unrelated worktree artifacts out.

### 6. Review, merge and verify serving code

- [ ] Parent conducts one independent whole-PR local review and records the Medium tier and owner exceptions in the PR. Apply the project CodeRabbit/MergePilot policy and three-round cap. Merge after required exact-head CI and review disposition, with no outstanding P0/P1. Record the PR head and actual merge SHA separately.
- [ ] Follow [the self-hosted deploy runbook](../../runbooks/deploy-edge-function.md). Check the next automatic `Edge Functions Sync (POSTORA)` execution through the authorized Contabo route. Record the successful schedule run and its target. Read the runner clone's verified HEAD at `/etc/dokploy/postora-runtime`. If it advanced further, use `git merge-base --is-ancestor "$MERGE_SHA" HEAD` in that clone and verify the reviewed files still contain the fix. Compare `git show "$DEPLOYED_SHA:supabase/functions/$file" | sha256sum` with `sha256sum "$VOL/$file"` for every changed runtime module. Use the runbook's functions volume. Expected result is matching hashes, a successful runner restart/boot check and no rollback. A green frontend deploy alone cannot establish this.
- [ ] Record HTTP status only for the two safe probes below. Expect 200 for config and successful preflight for process-post. If the runner parks or rolls back the commit, report the SHA and failing stage. Leave the marker and production state intact pending owner direction. No production publish, resend, reconnect, backfill or manual deployment.

```sh
curl -sS --max-time 10 -o /dev/null -w '%{http_code}\n' https://api.postora.cloud/functions/v1/get-public-config
curl -sS --max-time 10 -X OPTIONS -o /dev/null -w '%{http_code}\n' https://api.postora.cloud/functions/v1/process-post
```
