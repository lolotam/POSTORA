/** Disposable owner-release identities. Never use these fixtures against a shared stack. */
import { OWNER_RELEASE, syntheticOwnerReleaseKey } from "./instagramOwnerReleaseSettings.mjs";
import { assertLocalDockerSocket } from "./instagramOwnerReleaseSafety.mjs";
import { seedMetaOwnedRelease } from "./metaOwnedRelease.ts";
export { OWNER_RELEASE, syntheticOwnerReleaseKey } from "./instagramOwnerReleaseSettings.mjs";

export function assertOwnerReleaseUrl(url: string): void {
  if (![OWNER_RELEASE.apiUrl, OWNER_RELEASE.authUrl, OWNER_RELEASE.restUrl].some((allowed) => allowed === url)) {
    throw new Error("Owner-release fixtures require their exact loopback endpoints");
  }
}

export async function ownerReleaseSql(sql: string): Promise<string> {
  const hostOverride = Deno.env.get("DOCKER_HOST");
  if (hostOverride) assertLocalDockerSocket(hostOverride);
  const context = await new Deno.Command("docker", { args: ["context", "inspect"], stdout: "piped", stderr: "piped" }).output();
  if (!context.success) throw new Error("Local Docker context is unavailable");
  assertLocalDockerSocket(JSON.parse(new TextDecoder().decode(context.stdout))[0].Endpoints?.docker?.Host);
  const inspect = await new Deno.Command("docker", { args: ["inspect", OWNER_RELEASE.container], stdout: "piped", stderr: "piped" }).output();
  if (!inspect.success) throw new Error("Disposable owner-release database is unavailable");
  const [container] = JSON.parse(new TextDecoder().decode(inspect.stdout));
  if (container.Name !== `/${OWNER_RELEASE.container}` || container.Config.Labels?.project !== "postora"
    || container.Config.Labels?.purpose !== "owner-release-test"
    || Object.keys(container.NetworkSettings.Networks).some((name) => name !== "postora-owner-release-isolated")) {
    throw new Error("Refusing SQL outside the isolated owner-release container");
  }
  const command = new Deno.Command("docker", { args: ["exec", "-i", OWNER_RELEASE.container, "psql", "-U", "supabase_admin", "-d", OWNER_RELEASE.database, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=sqlstate"], stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
  const writer = command.stdin.getWriter();
  await writer.write(new TextEncoder().encode(sql));
  await writer.close();
  const output = await command.output();
  if (!output.success) {
    const sqlstate = /ERROR:\s+([A-Z0-9]{5})/.exec(new TextDecoder().decode(output.stderr))?.[1] ?? "unknown";
    throw new Error(`Owner-release SQL fixture failed (SQLSTATE ${sqlstate})`);
  }
  return new TextDecoder().decode(output.stdout).trim();
}

export async function seedOwnerRelease(): Promise<void> {
  assertOwnerReleaseUrl(OWNER_RELEASE.authUrl);
  // Check the disposable database before creating even synthetic Auth users.
  await ownerReleaseSql("SELECT current_database();");
  const serviceKey = await syntheticOwnerReleaseKey("service_role");
  for (const [id, email] of [[OWNER_RELEASE.ownerId, OWNER_RELEASE.email], [OWNER_RELEASE.otherOwnerId, "instagram-owner-release-other@example.test"]]) {
    const response = await fetch(`${OWNER_RELEASE.authUrl}/admin/users`, {
      method: "POST", headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id, email, password: OWNER_RELEASE.password, email_confirm: true, role: "authenticated" }),
    });
    if (!response.ok && response.status !== 422) throw new Error(`Synthetic Auth user creation failed (${response.status})`);
    const identity = response.ok ? await response.json() : await (await fetch(`${OWNER_RELEASE.authUrl}/admin/users/${id}`, {
      headers: { Authorization: `Bearer ${serviceKey}` },
    })).json();
    if (identity.id !== id || identity.email !== email) throw new Error("Synthetic Auth identity mismatch");
    if (identity.role !== "authenticated") {
      const roleUpdate = await fetch(`${OWNER_RELEASE.authUrl}/admin/users/${id}`, {
        method: "PUT", headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ role: "authenticated" }),
      });
      if (!roleUpdate.ok || (await roleUpdate.json()).role !== "authenticated") throw new Error("Synthetic Auth role assignment failed");
    }
  }
  await ownerReleaseSql(`
BEGIN;
DO $lease$ BEGIN
IF EXISTS(SELECT 1 FROM public.instagram_collection_jobs WHERE user_id='${OWNER_RELEASE.ownerId}' AND target_kind='owner' AND target_id='${OWNER_RELEASE.accountId}' AND lease_token IS NOT NULL AND lease_expires_at>clock_timestamp()) THEN
  RAISE EXCEPTION 'Owner-release fixture has an active worker';
END IF;
END $lease$;
DELETE FROM public.instagram_collection_job_operations WHERE user_id='${OWNER_RELEASE.ownerId}' AND job_id IN (SELECT id FROM public.instagram_collection_jobs WHERE user_id='${OWNER_RELEASE.ownerId}' AND target_kind='owner' AND target_id='${OWNER_RELEASE.accountId}');
DELETE FROM public.instagram_collection_job_checkpoints WHERE user_id='${OWNER_RELEASE.ownerId}' AND job_id IN (SELECT id FROM public.instagram_collection_jobs WHERE user_id='${OWNER_RELEASE.ownerId}' AND target_kind='owner' AND target_id='${OWNER_RELEASE.accountId}');
DELETE FROM public.instagram_collection_jobs WHERE user_id='${OWNER_RELEASE.ownerId}' AND target_kind='owner' AND target_id='${OWNER_RELEASE.accountId}';
DELETE FROM public.instagram_collection_request_throttles WHERE user_id='${OWNER_RELEASE.ownerId}' AND target_kind='owner' AND target_id='${OWNER_RELEASE.accountId}';
DELETE FROM public.ig_media_insight_snapshots WHERE user_id='${OWNER_RELEASE.ownerId}' AND social_account_id='${OWNER_RELEASE.accountId}';
DELETE FROM public.ig_account_insight_daily WHERE user_id='${OWNER_RELEASE.ownerId}' AND social_account_id='${OWNER_RELEASE.accountId}';
DELETE FROM public.ig_account_profile_observations WHERE user_id='${OWNER_RELEASE.ownerId}' AND social_account_id='${OWNER_RELEASE.accountId}';
INSERT INTO public.user_roles(user_id, role) VALUES ('${OWNER_RELEASE.ownerId}', 'admin') ON CONFLICT DO NOTHING;
UPDATE public.profiles SET api_key='${OWNER_RELEASE.apiKey}' WHERE id='${OWNER_RELEASE.ownerId}';
INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,platform_username,access_token,ig_auth_type,is_active,needs_reauth)
VALUES ('${OWNER_RELEASE.accountId}','${OWNER_RELEASE.ownerId}','instagram','ig-owner-release','owner_release','synthetic-browser-token','facebook_page',true,false),
('${OWNER_RELEASE.otherAccountId}','${OWNER_RELEASE.otherOwnerId}','instagram','ig-owner-release-other','other_owner_release','synthetic-other-token','facebook_page',true,false) ON CONFLICT DO NOTHING;
INSERT INTO public.instagram_account_capabilities(social_account_id,user_id,platform,login_kind,permission_read_state,granted_scopes,scopes_read_at,credential_generation)
VALUES ('${OWNER_RELEASE.accountId}','${OWNER_RELEASE.ownerId}','instagram','page_linked','ok',ARRAY['instagram_manage_insights'],now(),1) ON CONFLICT (social_account_id) DO UPDATE SET credential_generation=1;
INSERT INTO public.facebook_user_credentials(id,user_id,token,revision,lifecycle,token_expires_at,provenance_source)
VALUES ('${OWNER_RELEASE.credentialId}','${OWNER_RELEASE.ownerId}','synthetic-owner-release-provider-token',1,'active',now()+interval '30 days','migrated_instagram_account_credential') ON CONFLICT DO NOTHING;
INSERT INTO public.facebook_user_credential_bindings(social_account_id,user_id,platform,credential_id,evidence_source)
VALUES ('${OWNER_RELEASE.accountId}','${OWNER_RELEASE.ownerId}','instagram','${OWNER_RELEASE.credentialId}','migrated_instagram_account_credential') ON CONFLICT DO NOTHING;
INSERT INTO public.ig_media_insight_snapshots(user_id,social_account_id,ig_media_id,published_at,captured_at,captured_on,capture_timezone,media_product_type,media_type,status,views,reach,likes,comments,saved,shares,total_interactions)
SELECT '${OWNER_RELEASE.ownerId}','${OWNER_RELEASE.accountId}','owner-release-media-'||sequence,
now()-interval '3 days'-sequence*interval '1 day',now(),current_date,'UTC','REELS','VIDEO','ok',1000+sequence,500,20,3,2,1,26 FROM generate_series(0,20) sequence ON CONFLICT DO NOTHING;
INSERT INTO public.ig_account_profile_observations(user_id,social_account_id,observed_at,observed_on,capture_timezone,status,followers_count,media_count)
VALUES ('${OWNER_RELEASE.ownerId}','${OWNER_RELEASE.accountId}',now(),current_date,'UTC','ok',14200,21);
INSERT INTO public.ig_account_insight_daily(user_id,social_account_id,metric_date,provider_date,period_start,period_end,provider_timezone,status,captured_at,reach,views,total_interactions)
SELECT '${OWNER_RELEASE.ownerId}','${OWNER_RELEASE.accountId}',current_date-sequence,current_date-sequence,
(current_date-sequence)::timestamptz,(current_date-sequence+1)::timestamptz,'UTC','ok',now(),100,200,20 FROM unnest(ARRAY[3,5]) sequence ON CONFLICT DO NOTHING;
INSERT INTO public.app_settings(key,value,description) VALUES
('collection_instagram_insights_enabled','true'::jsonb,'Disposable local owner-release fixture'),
('credential_facebook_user_mode','"legacy"'::jsonb,'Disposable local owner-release fixture'),
('collection_instagram_rollout_policy','${JSON.stringify({ version: 1, owners: { mode: "allowlist", account_ids: [OWNER_RELEASE.accountId] }, competitors: { mode: "off", targets: [] } })}'::jsonb,'Disposable local owner-release fixture')
ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value;
COMMIT;
`);
  await seedMetaOwnedRelease(ownerReleaseSql);
}

if (import.meta.main) {
  await seedOwnerRelease();
  console.log("Seeded isolated owner-release Auth users and analytics fixtures. No production access.");
}
