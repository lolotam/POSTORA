// Isolated PostgreSQL WASM rehearsal; no network, production DB or npm install.
// Usage: node scripts/test-partner-assignment-sql.mjs /path/to/pglite/dist/index.js
// Uses an already-installed @electric-sql/pglite; no project dependency added.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
let checks = 0;
function equal(actual, expected) { assert.deepEqual(actual, expected); checks++; }
const sql = await readFile(new URL('../supabase/migrations/20260910170000_partner_assignment_events.sql', import.meta.url), 'utf8');
const prior = await readFile(new URL('../supabase/migrations/20260910130000_partner_connection_events.sql', import.meta.url), 'utf8');
const ws = '11111111-1111-4111-8111-111111111111', foreign = '22222222-2222-4222-8222-222222222222';
const conv = '33333333-3333-4333-8333-333333333333', account = '44444444-4444-4444-8444-444444444444';
const agent = '55555555-5555-4555-8555-555555555555', key = '66666666-6666-4666-8666-666666666666';
// Minimal production-shaped prerequisite schema: retain nullable legacy fields,
// the real unique index and composite FK, and direct default API-role grants.
await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
CREATE TABLE partner_webhooks (events text[], CONSTRAINT partner_webhooks_events_certified CHECK(cardinality(events)>0 AND events <@ ARRAY['webhook.test']));
CREATE TABLE messaging_cache (id uuid PRIMARY KEY, workspace_id uuid, social_account_id uuid, platform text, conversation_id text, user_id uuid, last_message_at timestamptz, UNIQUE(id,workspace_id));
CREATE TABLE partner_api_key_accounts (key_id uuid, workspace_id uuid, social_account_id uuid);
CREATE TABLE whatsapp_agents (id uuid PRIMARY KEY, workspace_id uuid);
CREATE TABLE whatsapp_conversation_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid, conversation_cache_id uuid, conversation_id text NOT NULL, agent_id uuid REFERENCES whatsapp_agents(id) ON DELETE SET NULL, notes text, assigned_at timestamptz DEFAULT now(), unassigned_at timestamptz,
FOREIGN KEY(conversation_cache_id,workspace_id) REFERENCES messaging_cache(id,workspace_id));
CREATE UNIQUE INDEX idx_active_assignment ON whatsapp_conversation_assignments(workspace_id,conversation_id) WHERE unassigned_at IS NULL;
CREATE TABLE whatsapp_assignment_history (id uuid DEFAULT gen_random_uuid(), workspace_id uuid, conversation_id text NOT NULL, action text CHECK(action IN ('assigned','unassigned','transferred')), from_agent_id uuid, to_agent_id uuid, reason text, created_at timestamptz DEFAULT now());
CREATE TABLE emitted (workspace uuid, type text, occurrence text UNIQUE, payload jsonb, platform text, account uuid, occurred_at timestamptz);
CREATE FUNCTION partner_emit_webhook_event(uuid,text,text,jsonb,text,uuid,timestamptz) RETURNS void LANGUAGE sql AS 'INSERT INTO emitted VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING';
INSERT INTO messaging_cache VALUES ('${conv}','${ws}','${account}','whatsapp','wa_123_96555555555','${ws}',now());
INSERT INTO partner_api_key_accounts VALUES ('${key}','${ws}','${account}');
INSERT INTO whatsapp_agents VALUES ('${agent}','${ws}');
`);
await db.exec(prior);
await db.exec(sql);
await db.exec(sql); // CHECK and trigger installation are re-runnable.
const query = async (statement, params = []) => (await db.query(statement, params)).rows;
const scalar = async (statement, params = []) => Object.values((await query(statement, params))[0])[0];
const write = async (remove = false, tenant = ws, agentId = agent) => scalar('SELECT partner_write_conversation_assignment($1,$2,$3,$4,$5,$6)', [tenant,key,conv,agentId,'Test note',remove]);
try {
  equal(await scalar("SELECT has_function_privilege('anon','partner_assignment_events_emit()','EXECUTE')"), false);
  equal(await scalar("SELECT has_function_privilege('authenticated','partner_assignment_events_emit()','EXECUTE')"), false);
  for (const role of ['anon','authenticated','service_role']) equal(await scalar(`SELECT has_function_privilege('${role}','partner_write_conversation_assignment(uuid,uuid,uuid,uuid,text,boolean)','EXECUTE')`), role === 'service_role');
  const first = await write();
  equal((await query('SELECT workspace_id, conversation_cache_id FROM whatsapp_conversation_assignments'))[0], {workspace_id:ws,conversation_cache_id:conv});
  const second = await write();
  assert.notEqual(second.id, first.id); checks++;
  equal(await scalar('SELECT count(*)::int FROM whatsapp_conversation_assignments WHERE unassigned_at IS NULL'), 1);
  equal(await scalar('SELECT count(*)::int FROM whatsapp_conversation_assignments'), 2);
  equal((await query('SELECT type FROM emitted ORDER BY occurred_at,type DESC')).map(r=>r.type), ['conversation.assigned','conversation.unassigned','conversation.assigned']);
  equal(await scalar('SELECT count(DISTINCT occurrence)::int FROM emitted'), 3);
  equal((await query('SELECT action FROM whatsapp_assignment_history ORDER BY created_at')).map(r=>r.action), ['assigned','transferred']);
  equal(await scalar('SELECT bool_and(workspace_id=$1) FROM whatsapp_assignment_history',[ws]), true);
  const events = await query('SELECT * FROM emitted');
  equal(events.every(e => e.payload.conversation === `conv_${conv}` && e.payload.agent_id === `agent_${agent}` && !JSON.stringify(e.payload).includes('wa_') && !('conversation_id' in e.payload)), true);
  equal(events.every(e => e.occurrence.startsWith(`${e.type}:${e.payload.id.slice(11)}:`) && /\.\d{6}Z$/.test(e.occurrence)), true);
  await db.exec('UPDATE whatsapp_conversation_assignments SET notes=\'unrelated\'; UPDATE whatsapp_conversation_assignments SET unassigned_at=unassigned_at;');
  equal(await scalar('SELECT count(*)::int FROM emitted'), 3);
  await write(true);
  equal(await scalar('SELECT count(*)::int FROM whatsapp_conversation_assignments'), 2);
  equal(await scalar('SELECT count(*)::int FROM whatsapp_conversation_assignments WHERE unassigned_at IS NULL'), 0);
  equal(await write(true), {error:'resource_not_found'});
  equal(await scalar('SELECT count(*)::int FROM whatsapp_assignment_history'), 3);
  equal(await write(false, foreign), {error:'resource_not_found'});
  equal(await write(false, ws, foreign), {error:'resource_not_found'});
  await db.exec('DELETE FROM partner_api_key_accounts');
  equal(await write(), {error:'resource_not_found'});
  await db.query('INSERT INTO partner_api_key_accounts VALUES ($1,$2,$3)',[key,ws,account]);
  // Browser-shaped legacy rows cannot be safely attributed or named.
  await db.query(`INSERT INTO whatsapp_conversation_assignments(workspace_id,conversation_cache_id,conversation_id,agent_id) VALUES (NULL,$1,'legacy-null-ws',$2),($3,NULL,'legacy-null-cache',$2)`,[conv,agent,ws]);
  equal(await scalar('SELECT count(*)::int FROM emitted'), 4);
  await db.exec("UPDATE whatsapp_conversation_assignments SET unassigned_at=now() WHERE conversation_id LIKE 'legacy-%'");
  equal(await scalar('SELECT count(*)::int FROM emitted'), 4);
  await db.query(`INSERT INTO whatsapp_conversation_assignments(workspace_id,conversation_cache_id,conversation_id,agent_id,unassigned_at) VALUES ($1,$2,'already-closed',$3,now())`,[ws,conv,agent]);
  await db.exec("UPDATE whatsapp_conversation_assignments SET unassigned_at=unassigned_at + interval '1 second' WHERE unassigned_at IS NOT NULL");
  equal(await scalar('SELECT count(*)::int FROM emitted'), 4);
  // Failure in history must roll back the preceding close AND open.
  const beforeFailure = await write();
  await db.exec("CREATE FUNCTION fail_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected history failure'; END $$; CREATE TRIGGER fail_history BEFORE INSERT ON whatsapp_assignment_history FOR EACH ROW EXECUTE FUNCTION fail_history();");
  await assert.rejects(write(), /injected history failure/); checks++;
  equal(await scalar('SELECT id FROM whatsapp_conversation_assignments WHERE workspace_id=$1 AND unassigned_at IS NULL',[ws]), beforeFailure.id);
  equal(await scalar('SELECT count(*)::int FROM emitted'), 5);
  await db.exec('DROP TRIGGER fail_history ON whatsapp_assignment_history');
  // An ordinary emitter failure rolls back only the emission, never the
  // assignment: the observation must not destroy what it observes.
  const inject = (code) => db.exec(`CREATE OR REPLACE FUNCTION partner_emit_webhook_event(uuid,text,text,jsonb,text,uuid,timestamptz) RETURNS void LANGUAGE plpgsql AS $$ BEGIN INSERT INTO emitted VALUES ($1,$2,$3,$4,$5,$6,$7); RAISE EXCEPTION 'injected' USING ERRCODE='${code}'; END $$;`);
  await inject('P0001');
  await write();
  equal(await scalar('SELECT count(*)::int FROM whatsapp_conversation_assignments WHERE workspace_id=$1 AND unassigned_at IS NULL',[ws]), 1);
  equal(await scalar('SELECT count(*)::int FROM emitted'), 5);
  // Cancellation and a broken assertion must NOT be swallowed. Catching 57014
  // would make the write ignore statement_timeout and an operator's cancel, so
  // the whole statement is expected to fail here rather than continue.
  for (const code of ['57014','P0004']) {
    await inject(code);
    await assert.rejects(write(), /injected/); checks++;
    equal(await scalar('SELECT count(*)::int FROM whatsapp_conversation_assignments WHERE workspace_id=$1 AND unassigned_at IS NULL',[ws]), 1);
    equal(await scalar('SELECT count(*)::int FROM emitted'), 5);
  }
  // A real browser role can reach the trigger without execute rights on it or
  // any rights on the outbox. This proves the SECURITY DEFINER boundary.
  await db.exec(`CREATE OR REPLACE FUNCTION partner_emit_webhook_event(uuid,text,text,jsonb,text,uuid,timestamptz) RETURNS void LANGUAGE sql AS 'INSERT INTO emitted VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING';
    GRANT INSERT ON whatsapp_conversation_assignments TO authenticated;
    SET ROLE authenticated;
    INSERT INTO whatsapp_conversation_assignments(workspace_id,conversation_cache_id,conversation_id,agent_id) VALUES ('${ws}','${conv}','browser-write','${agent}');
    RESET ROLE;`);
  equal(await scalar('SELECT count(*)::int FROM emitted'), 6);
  // The new CHECK still forbids empty subscriptions and unproduced events.
  await assert.rejects(db.exec("INSERT INTO partner_webhooks VALUES ('{}')"), /partner_webhooks_events_certified/); checks++;
  await assert.rejects(db.exec("INSERT INTO partner_webhooks VALUES (ARRAY['conversation.mode_changed'])"), /partner_webhooks_events_certified/); checks++;
  console.log(`assignment SQL rehearsal: ${checks} assertions passed; migration re-run, ACLs, transitions, legacy nulls, atomic rollback, and emitter failures verified`);
} finally { await db.close(); }
