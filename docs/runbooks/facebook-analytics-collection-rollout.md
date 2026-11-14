# Facebook analytics collection policy operators

Phase 2, 2026-11-14. No activation or production application is implied.
Use only after `20261114210000_analytics_policy_operator_controls.sql` and its
catalog/grants/triggers have been verified. Follow the shared
[pause-first installation procedure](instagram-collection-rollout.md#101-pause-first-install-and-verify)
before applying the restriction. It covers both Instagram and Facebook policy
keys. Preserve current masters, raw policies, schedule activity and private
authorization receipts; this migration changes none of those values.

The unchanged Facebook collection shape is `{"account_ids":[...]}`, an
allowlist with at most 100 unique UUIDs; empty admits nobody. Facebook-specific
validation also understands exact `{"version":2,"mode":"off|allowlist|all",
"account_ids":[]}` (the mode is one of the three words). **All v2 writes are
refused with `facebook_v2_evaluator_not_installed` until Phase 6 deliberately
replaces the gate with verified Facebook evaluator/dispatcher/request/write
fences and compatible runtime.** There is no client-editable readiness flag.
Do not write v2 through owner/admin maintenance. Threads and retention keep
their existing strict parser, settings and behavior.

The master remains `collection_facebook_analytics_enabled`. Neither the setter
nor this document changes it, credentials, permission observations or schedules.
All-customer enrollment/population preparation belongs to the
[owner design §§6–9](../superpowers/specs/2026-11-14-owner-analytics-for-all-customers-design.md#6-facebook-repair-the-first-failed-stage-then-enable-all-customers).
A successful policy write proves no provider collection.

Open a private interactive operator session (the authorized connection must
be able to `SET ROLE service_role`):

```bash
psql "$DB_URL" -X -v ON_ERROR_STOP=1
```

```sql
SET statement_timeout='10s';
SET lock_timeout='3s';
SET ROLE service_role;
\prompt 'Operator identity: ' actor
\prompt 'Concrete approval reference: ' approval_ref
SELECT public.get_facebook_analytics_collection_policy() AS snapshot \gset before_
SELECT :'before_snapshot'::jsonb->>'state'='valid' AS valid \gset
\if :valid
\else
 \echo 'Stop: use closed recovery below.'
 \quit
\endif
-- Supply the reviewed COMPLETE legacy allowlist, preserving existing members.
\prompt 'Reviewed account_ids JSON array: ' account_ids
SELECT jsonb_build_object('account_ids',:'account_ids'::jsonb)::text AS policy \gset candidate_
SELECT public.set_facebook_analytics_collection_policy(
 :'before_snapshot'::jsonb->>'fingerprint',(:'before_snapshot'::jsonb->>'revision')::bigint,
 :'candidate_policy'::jsonb,:'actor',:'approval_ref') AS result \gset applied_
SELECT (:'applied_result'::jsonb->>'ok')::boolean AS ok \gset
\if :ok
\else
 \echo :applied_result
 \quit
\endif
SELECT public.get_facebook_analytics_collection_policy() AS snapshot \gset after_
SELECT :'after_snapshot'::jsonb;
RESET ROLE;
SELECT created_at,metadata FROM public.system_logs
WHERE source='facebook-collection-rollout' AND metadata->>'event'='rollout_policy_changed'
 AND metadata->>'new_revision'=(:'after_snapshot'::jsonb->>'revision')
ORDER BY created_at DESC LIMIT 1;
```

Verify committed canonical content, old/new fingerprint and revision, actor,
approval reference and `path=cas`. Actor/reference are asserted, nonblank
strings of at most 200 characters, not proof of release approval. UUID order
and spelling are canonicalized; duplicates/unknown keys/invalid IDs are
refused. Only getters/setters are service-role APIs; anon/authenticated,
including admin JWTs, cannot execute them. Raw service-role policy writes,
deletes, upserts and renames are denied even with forged context. Validated
authenticated-admin UPDATE and audited database-owner maintenance are retained
for the same compatibility reasons as Instagram; admin deletes/renames and
v2 writes are denied. Normal rollout always uses CAS. A `55P03` maintenance
conflict means stop and reread, never bypass the restriction.

Pause affected workers before rollback. In the same session, use a fresh
expected fingerprint/revision to restore the previously reviewed full Page
list, then test the original stale edit:

```sql
SET ROLE service_role;
\prompt 'Concrete rollback authorization reference: ' rollback_ref
SELECT public.get_facebook_analytics_collection_policy() AS snapshot \gset live_
SELECT public.set_facebook_analytics_collection_policy(
 :'live_snapshot'::jsonb->>'fingerprint',(:'live_snapshot'::jsonb->>'revision')::bigint,
 :'before_snapshot'::jsonb->'policy',:'actor',:'rollback_ref') AS result \gset rollback_
SELECT (:'rollback_result'::jsonb->>'ok')::boolean AS ok \gset
\if :ok
\else
 \echo :rollback_result
 \quit
\endif
SELECT public.get_facebook_analytics_collection_policy();
SELECT public.set_facebook_analytics_collection_policy(
 :'before_snapshot'::jsonb->>'fingerprint',(:'before_snapshot'::jsonb->>'revision')::bigint,
 :'candidate_policy'::jsonb,:'actor',:'rollback_ref');
```

Require the last result to be `ok=false, reason_code=policy_conflict`: A → B → A
restores content identity but never its old revision. Every successful write,
including same-content writes and rollback, increments revision. Recheck the
rollback audit/readback as above. On a stale refusal, reread and review; on a
lost reply, reconcile readback/audit before retrying. No blind full-list upsert.
Keep the controls and saved measurements on rollback. Once Phase 6 admits v2,
keep a v2-aware last-good runtime; a pre-v2 binary cannot safely read stored v2.

Missing/malformed rows return no usable policy and their raw identity in
`fingerprint`/`raw_fingerprint`. A revision tombstone survives deletion. Restore
only an empty legacy list, verify audit/readback, and review a fresh snapshot
before any separately authorized enrollment. Open a new private psql session
as above, then:

```sql
SET statement_timeout='10s';
SET lock_timeout='3s';
SET ROLE service_role;
\prompt 'Operator identity: ' actor
\prompt 'Concrete closed-recovery approval reference: ' approval_ref
SELECT public.get_facebook_analytics_collection_policy() AS snapshot \gset recovery_
SELECT public.set_facebook_analytics_collection_policy(
 :'recovery_snapshot'::jsonb->>'fingerprint',(:'recovery_snapshot'::jsonb->>'revision')::bigint,
 '{"account_ids":[]}'::jsonb,:'actor',:'approval_ref');
SELECT public.get_facebook_analytics_collection_policy();
```

Enabling recovery returns `recovery_requires_closed_policy`. Audit failure
aborts the whole transaction, including policy/revision/context; no confirmed
result exists until commit. The harness's `analytics_policy_operator_controls`
and `analytics_policy_operator_races` suites verify these boundaries for both
platforms, including real blocked writers, stale edits after rollback and
service/anon/authenticated ACLs. No provider calls are made by policy operators.
