import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runLegacyBootstrap, type BootstrapRpc } from "./worker.ts";

const container = Deno.env.get("ROLLOUT_IT_CONTAINER");
const database = Deno.env.get("ROLLOUT_IT_DB") ?? "partner_api_harness";
async function sql(statement: string): Promise<string> {
  if (!container || !/^[a-zA-Z0-9_-]+$/.test(container) || !/^[a-z_]+_harness$/.test(database)
    || /prod|live|primary/i.test(container + database)) throw new Error("Explicit disposable bootstrap harness required");
  const output = await new Deno.Command("docker", { args: ["exec", container!, "psql", "-U", "supabase_admin", "-d", database,
    "-XAt", "-v", "ON_ERROR_STOP=1", "-c", statement], stdout: "piped", stderr: "piped" }).output();
  if (!output.success) throw new Error("Bootstrap integration SQL failed");
  return new TextDecoder().decode(output.stdout).trim();
}
const quote = (argument: unknown) => argument === null ? "NULL" : typeof argument === "number" ? String(argument)
  : typeof argument === "object" ? `'${JSON.stringify(argument).replaceAll("'", "''")}'::jsonb`
  : `'${String(argument).replaceAll("'", "''")}'`;

Deno.test({ name: "registered worker reaches real capture/install/permission SQL and reconciles a lost install response", ignore: !container, fn: async () => {
  const owner = crypto.randomUUID();
  const page = crypto.randomUUID();
  const instagram = crypto.randomUUID();
  let oldSettings = "";
  let installs = 0;
  let providerCalls = 0;
  try {
    oldSettings = await sql("SELECT jsonb_object_agg(key,value) FROM public.app_settings WHERE key LIKE 'analytics_legacy_bootstrap_%'");
    await sql(`BEGIN;
      INSERT INTO auth.users(id,email) VALUES('${owner}','${owner}@example.invalid');
      INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,platform_username,access_token,account_metadata,ig_auth_type)
      VALUES('${page}','${owner}','facebook','100701','fixture_page',gen_random_uuid()::text,jsonb_build_object('user_token',gen_random_uuid()::text),NULL),
        ('${instagram}','${owner}','instagram','178701','fixture_ig',gen_random_uuid()::text,'{"facebook_page_id":"100701"}','facebook_page');
      UPDATE public.app_settings SET value='true' WHERE key='analytics_legacy_bootstrap_enabled';
      UPDATE public.app_settings SET value=jsonb_build_object('version',1,'account_ids',jsonb_build_array('${instagram}'),
        'max_accounts_per_run',5,'max_attempts_per_account_per_day',3) WHERE key='analytics_legacy_bootstrap_policy';
      UPDATE public.analytics_legacy_bootstrap_run SET lease_until=NULL,pause_until=NULL; COMMIT;`);
    const rpc: BootstrapRpc = async (name, args) => {
      if (!/^[a-z_]+$/.test(name) || Object.keys(args).some((key) => !/^p_[a-z_]+$/.test(key))) throw new Error("Invalid fixture RPC");
      const result = await sql(`BEGIN; SET LOCAL request.jwt.claim.role='service_role';
        SET LOCAL request.jwt.claims='{"role":"service_role"}'; SELECT to_json(public.${name}(${Object.entries(args).map(([key, argument]) => `${key}=>${quote(argument)}`).join(",")})); COMMIT;`);
      const payload = JSON.parse(result.split("\n").find((line) => line.startsWith("{") || line === "true" || line === "null") ?? "null");
      if (name === "commit_analytics_legacy_bootstrap" && ++installs === 1) throw new Error("Synthetic response lost after durable install");
      return { data: payload, error: null };
    };
    const replies = [
      { data: { is_valid: true, type: "USER", app_id: "200701", user_id: "300701", expires_at: 0, data_access_expires_at: 0 } },
      { id: "300701" }, { data: [{ id: "100701" }] }, { id: "100701", instagram_business_account: { id: "178701" } },
      { data: [{ permission: "instagram_manage_insights", status: "granted" }] },
    ];
    const outcome = await runLegacyBootstrap({ rpc, apps: { facebook: { id: "200701", secret: crypto.randomUUID() }, instagram: { id: "200702", secret: crypto.randomUUID() } },
      fetcher: async () => { providerCalls++; return Response.json(replies.shift()); } });
    assertEquals(outcome.accounts[0].state, "ready");
    assertEquals(installs, 1);
    assertEquals(providerCalls, 5);
    assertEquals(await sql(`SELECT count(*) FROM public.instagram_collection_jobs WHERE social_account_id='${instagram}'`), "0");
    assertEquals(await sql(`SELECT credential_generation>=1 AND permission_read_state='ok' FROM public.instagram_account_capabilities WHERE social_account_id='${instagram}'`), "t");
  } finally {
    await sql(`BEGIN; DELETE FROM auth.users WHERE id='${owner}';
      UPDATE public.analytics_legacy_bootstrap_run SET holder=NULL,lease_until=NULL,pause_until=NULL,calls=0;
      ${oldSettings ? `UPDATE public.app_settings a SET value=e.value FROM jsonb_each(${quote(JSON.parse(oldSettings))}) e WHERE a.key=e.key;` : ""} COMMIT;`);
  }
} });
