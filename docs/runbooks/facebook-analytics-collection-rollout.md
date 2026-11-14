# Facebook analytics collection policy operators

Phases 2 and 6, 2026-11-15. No activation or production application is implied.
Use only after `20261114210000_analytics_policy_operator_controls.sql`,
`20261115100000_facebook_analytics_all.sql` and their
catalog/grants/triggers have been verified. Follow the shared
[pause-first installation procedure](instagram-collection-rollout.md#101-pause-first-install-and-verify)
before applying the restriction. It covers both Instagram and Facebook policy
keys. Preserve current masters, raw policies, schedule activity and private
authorization receipts; this migration changes none of those values.

Facebook accepts legacy exact `{"account_ids":[...]}` as allowlist and exact
`{"version":2,"mode":"off|allowlist|all","account_ids":[]}` (the mode is one
of the three words). Allowlist has at most 100 unique UUIDs; empty admits
nobody. All requires an empty array and selects active Facebook Pages from the
database, including future connections. Missing/malformed settings fail closed.
Ownership, credentials and permissions are checked separately on each operation.
Only use v2 after the Phase 6 catalog **and compatible runtime** are verified;
the Phase 2-only setter refuses it with `facebook_v2_evaluator_not_installed`.
There is no client-editable readiness flag. Threads and retention keep
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
 \quit 1
\endif
-- Supply the reviewed COMPLETE staging allowlist, preserving existing members.
\prompt 'Reviewed account_ids JSON array: ' account_ids
SELECT jsonb_build_object('version',2,'mode','allowlist','account_ids',:'account_ids'::jsonb)::text AS policy \gset candidate_
SELECT public.set_facebook_analytics_collection_policy(
 :'before_snapshot'::jsonb->>'fingerprint',(:'before_snapshot'::jsonb->>'revision')::bigint,
 :'candidate_policy'::jsonb,:'actor',:'approval_ref') AS result \gset applied_
SELECT (:'applied_result'::jsonb->>'ok')::boolean AS ok \gset
\if :ok
\else
 \echo :applied_result
 \quit 1
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
for the same compatibility reasons as Instagram; admin deletes/renames are
denied. Normal rollout always uses CAS. A `55P03` maintenance
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
 \quit 1
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
Keep the controls and saved measurements on rollback. While v2 is stored,
keep a v2-aware last-good runtime; a pre-v2 binary cannot safely read stored v2.

Missing/malformed rows return no usable policy and their raw identity in
`fingerprint`/`raw_fingerprint`. A revision tombstone survives deletion. Restore
only `{"version":2,"mode":"off","account_ids":[]}` (or an empty legacy list), verify audit/readback, and review a fresh snapshot
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
 '{"version":2,"mode":"off","account_ids":[]}'::jsonb,:'actor',:'approval_ref');
SELECT public.get_facebook_analytics_collection_policy();
```

Enabling recovery returns `recovery_requires_closed_policy`. Audit failure
aborts the whole transaction, including policy/revision/context; no confirmed
result exists until commit. The harness's `analytics_policy_operator_controls`
and `analytics_policy_operator_races` suites verify these boundaries for both
platforms, including real blocked writers, stale edits after rollback and
service/anon/authenticated ACLs. No provider calls are made by policy operators.

## Phase 6 installation and runtime order

Record the immutable candidate, existing raw policy/master, getter snapshot,
schedule identities/activity, operator and concrete release authorization in a
private receipt. The main edge reconciler does not apply migrations. Hold its
automatic deployment before merging dependent runtime, or finish schema
installation and catalog verification before that merge.

Pause Facebook enqueue/drain and bootstrap scheduling, and prevent manual
invocations while installing. Existing bootstrap and collection masters/policies
stay unchanged. This block must abort on any failed pause:

```bash
set -euo pipefail
psql "$DB_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL statement_timeout='10s';
DO $pause$ DECLARE j record; BEGIN
 FOR j IN SELECT jobid FROM cron.job WHERE jobname IN
  ('facebook-analytics-enqueue-daily','facebook-analytics-drain','analytics-legacy-bootstrap-drain') LOOP
  PERFORM cron.alter_job(j.jobid,active:=false);
 END LOOP;
 ASSERT NOT EXISTS(SELECT 1 FROM cron.job WHERE active AND jobname IN
  ('facebook-analytics-enqueue-daily','facebook-analytics-drain','analytics-legacy-bootstrap-drain'));
END;$pause$;
COMMIT;
SQL
# Before continuing, reconcile all already-sent requests and wait for the
# existing collection leases (120 seconds) and bootstrap leases to settle.
# Inactive cron rows alone do not prove quiescence. Prevent manual callers too.
psql "$DB_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN READ ONLY;
SET LOCAL statement_timeout='10s';
DO $settled$ BEGIN
 ASSERT NOT EXISTS(SELECT 1 FROM public.fb_analytics_collection_jobs WHERE lease_until>clock_timestamp());
 ASSERT NOT EXISTS(SELECT 1 FROM public.analytics_legacy_bootstrap_jobs WHERE lease_until>clock_timestamp());
 ASSERT NOT EXISTS(SELECT 1 FROM public.analytics_legacy_bootstrap_run WHERE lease_until>clock_timestamp());
END;$settled$;
ROLLBACK;
SQL
psql "$DB_URL" -X -v ON_ERROR_STOP=1 \
 -f supabase/migrations/20261115100000_facebook_analytics_all.sql
```

Apply as the existing `app_settings` owner, from the reviewed immutable source.
Verify the Facebook decoder, collection evaluator, same keyset selector in both
next/commit functions, v2-aware claim, usable-credential checks, bootstrap proof
completion, readiness base reader and CAS/audit/write-guard definitions. Verify
the new three-argument `read_fb_analytics_admission_credential(uuid,jsonb,uuid)`
overload and preserved two-argument API; only service may call either. Confirm
private outcome RLS/ACLs, the five-column primary key, composite cascading sweep
FK, keyset/retry indexes, and that every Facebook sweep has `outcomes={}`.
Verify policy revisions and cleared pending operator context. Readback of all
original masters/policies must match the saved receipt. Verify PostgREST reload.

Deploy the candidate's complete `meta-owned-analytics-sync` import closure using
[the self-hosted procedure](deploy-edge-function.md): extract reviewed commit
blobs, copy to the functions volume, compare SHA256 source/volume hashes, run
`docker compose up -d --no-deps functions` from the stack directory, then verify
boot/OPTIONS. The existing report/API/MCP closures consume the additive SQL
readiness contract without a Phase 6 source change; verify their deployed versions
remain the phase-1/3 compatible versions. Do not deploy a pre-v2 collector.
Only after compatible SQL/runtime verification, canonicalize the current legacy
list to v2 allowlist through fresh CAS, preserving **every** current ID. Resume
only schedules that were active in the saved receipt; never activate bootstrap
merely because it was paused here. Resume manual work only after verification.

## Authorized later all transition

Complete the whole-population bootstrap/admission and short verification/cohort
gates in design §§6–7 first. The separate bootstrap boundary can verify an
excluded Page without prepare/enqueue or measurement calls. Current authority,
app/User/Page identity and today's Los Angeles permission observation are required.
Do not label unresolved repairable accounts as customer exceptions.

In the private psql session above, with the actual release actor/reference:

```sql
SET ROLE service_role;
SELECT public.get_facebook_analytics_collection_policy() AS snapshot \gset all_before_
SELECT public.set_facebook_analytics_collection_policy(
 :'all_before_snapshot'::jsonb->>'fingerprint',
 (:'all_before_snapshot'::jsonb->>'revision')::bigint,
 '{"version":2,"mode":"all","account_ids":[]}'::jsonb,
 :'actor',:'approval_ref') AS result \gset all_applied_
SELECT (:'all_applied_result'::jsonb->>'ok')::boolean AS ok \gset
\if :ok
\else
 \echo :all_applied_result
 \quit 1
\endif
SELECT public.get_facebook_analytics_collection_policy();
RESET ROLE;
SELECT created_at,metadata FROM public.system_logs
WHERE source='facebook-collection-rollout' AND metadata->>'event'='rollout_policy_changed'
 AND metadata->>'new_revision'=(:'all_applied_result'::jsonb->>'revision')
ORDER BY created_at DESC LIMIT 1;
```

Then invoke the existing authenticated `meta-owned-analytics-sync` action
`{"action":"enqueue-daily","platform":"facebook"}` and normal drains. Explicit
daily dispatch starts/reopens rounds. A drain only resumes pending work with
`p_start=false`, at most five target visits and 15 seconds, retaining at least
25 seconds of its 40-second budget for measurements. Completed rounds stay
complete on drains. The next hourly dispatcher opens a new bounded round for a
newly ready Page behind the cursor, without a settings ID edit. Count actual
captures and metrics independently of sweep completion. Use the current-round
normalized outcome query in [design Q4](../superpowers/specs/2026-11-14-owner-analytics-for-all-customers-design.md#62-exact-read-only-query-pack-future-authorized-operator).

Rollback pauses affected Facebook work first, then uses a **fresh** getter
fingerprint/revision to restore the reviewed last-good v2 allowlist or v2 off.
For uncertain security, turn only the Facebook master off under the incident
procedure. Keep a v2-aware runtime, additive schema, bindings and saved history;
do not reverse schema, purge jobs or restore a legacy-only binary. Reconcile
bounded requests/leases before declaring quiescence. Instagram/Threads/retention
are unchanged unless a shared incident independently requires stopping them.
