#!/usr/bin/env python3
"""Race legacy direct writes against CAS in a labelled disposable Postgres only."""
from __future__ import annotations

import argparse
import json
import queue
import subprocess
import threading
import time
import uuid


class Session:
    def __init__(self, container: str, database: str):
        self.lines: queue.Queue[str | None] = queue.Queue()
        self.process = subprocess.Popen(
            ['docker', 'exec', '-i', container, 'psql', '-XqAt', '-U', 'supabase_admin',
             '-d', database, '-v', 'ON_ERROR_STOP=1', '-f', '-'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding='utf-8', bufsize=1,
        )
        threading.Thread(target=self.read, daemon=True).start()
        self.command("SET statement_timeout='8s'; SET lock_timeout='6s'; SET request.jwt.claim.role='service_role';")
        self.pid = int(self.command('SELECT pg_backend_pid();')[-1])

    def read(self):
        for line in self.process.stdout:
            self.lines.put(line.rstrip())
        self.lines.put(None)

    def start(self, sql: str) -> str:
        marker = uuid.uuid4().hex
        self.process.stdin.write(sql + f"\nSELECT '{marker}';\n")
        self.process.stdin.flush()
        return marker

    def finish(self, marker: str) -> list[str]:
        deadline = time.monotonic() + 10
        output: list[str] = []
        while time.monotonic() < deadline:
            line = self.lines.get(timeout=max(.01, deadline - time.monotonic()))
            if line is None:
                raise RuntimeError('SQL session failed: ' + '\n'.join(output))
            if line == marker:
                return output
            output.append(line)
        raise TimeoutError('SQL session exceeded observation deadline')

    def command(self, sql: str) -> list[str]:
        return self.finish(self.start(sql))

    def close(self):
        if self.process.poll() is None:
            try:
                self.process.stdin.write('ROLLBACK;\n\\q\n')
                self.process.stdin.flush()
                self.process.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                self.process.kill()
                self.process.wait(timeout=3)
        for pipe in (self.process.stdin, self.process.stdout):
            try:
                pipe.close()
            except OSError:
                pass


def literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--container', required=True)
    parser.add_argument('--database', default='partner_api_harness')
    args = parser.parse_args()
    labels = json.loads(subprocess.check_output(
        ['docker', 'inspect', args.container, '--format', '{{json .Config.Labels}}'], text=True))
    if labels.get('postora.task') not in {'postora-db-harness-local', 'postora-db-harness-ci'}:
        raise RuntimeError('Only a labelled disposable database is allowed')
    if not args.database.endswith('_harness'):
        raise RuntimeError('Only an explicit harness database is allowed')
    sessions: list[Session] = []

    def session():
        opened = Session(args.container, args.database)
        sessions.append(opened)
        return opened

    observer = session()
    actor, user = str(uuid.uuid4()), str(uuid.uuid4())
    provider = 'override_race_' + uuid.uuid4().hex
    where = f'user_id={literal(user)}'
    selection = literal(json.dumps({'provider_code': provider, 'model_id': 'api-model', 'reason': 'cas'})) + '::jsonb'

    def snapshot():
        return observer.command(f"SELECT COALESCE((SELECT to_jsonb(o) FROM public.user_ai_model_overrides o WHERE {where}),'null'::jsonb);")[-1]

    def rpc(expected: str, delete: bool):
        observed = 'NULL' if expected == 'null' else literal(expected) + '::jsonb'
        return f"SELECT public.write_ai_model_override({literal(user)},{'NULL' if delete else selection},{observed},{literal(actor)});"

    def wait_for_lock(blocked: Session, blocker: Session):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            waiting = observer.command(f"SELECT {blocker.pid}=ANY(pg_blocking_pids({blocked.pid}));")[-1]
            if waiting == 't':
                return
            if blocked.process.poll() is not None:
                raise AssertionError('Contender exited before serialization was observed')
            time.sleep(.02)
        raise AssertionError('No actual lock wait observed between legacy and CAS sessions')

    try:
        observer.command(f"""
INSERT INTO auth.users(id,email) VALUES({literal(actor)},{literal(actor + '@example.invalid')}),({literal(user)},{literal(user + '@example.invalid')});
INSERT INTO public.user_roles(user_id,role) VALUES({literal(actor)},'admin') ON CONFLICT DO NOTHING;
INSERT INTO public.ai_providers(provider_code,name,api_endpoint,api_key_env_var,api_type,is_active)
VALUES({literal(provider)},'Override race','https://fixture.invalid','TEST_FIXTURE','openai',true);
INSERT INTO public.ai_models(provider_id,model_id,name,capabilities,is_active,auth_method)
SELECT id,'api-model','Race',ARRAY['chat'],true,'api_key' FROM public.ai_providers WHERE provider_code={literal(provider)};
""")
        # Pause at the real CAS writer's advisory-lock boundary, before it
        # touches the existing tuple. A row trigger would take the reverse
        # order: legacy tuple first, then advisory, deadlocking the next RPC.
        advisory = observer.command("SELECT substring(pg_get_functiondef('public.write_ai_model_override(uuid,jsonb,jsonb,uuid)'::regprocedure), 'PERFORM (pg_advisory_xact_lock[^;]+);');")[-1]
        assert advisory.startswith('pg_advisory_xact_lock('), 'CAS serialization boundary must exist'
        advisory = advisory.replace('p_user_id', literal(user) + '::uuid')
        for operation in ['update', 'delete']:
            for delete in [False, True]:
                observer.command(f'DELETE FROM public.user_ai_model_overrides WHERE {where};')
                assert observer.command(rpc('null', False))[-1] == 't'
                expected = snapshot()
                cas, legacy = session(), session()
                cas.command('BEGIN; SELECT ' + advisory + ';')
                sql = (f"UPDATE public.user_ai_model_overrides SET reason='legacy' WHERE {where};" if operation == 'update'
                       else f'DELETE FROM public.user_ai_model_overrides WHERE {where};')
                pending = legacy.start(sql)
                wait_for_lock(legacy, cas)
                assert cas.command(rpc(expected, delete))[-1] == 't', 'CAS must complete without a tuple/advisory deadlock'
                cas.command('COMMIT;')
                legacy.finish(pending)
                final = json.loads(snapshot())
                assert final is None if delete or operation == 'delete' else final['reason'] == 'legacy'
                cas.close()
                legacy.close()
                print(f'PASS CAS {"delete" if delete else "save"} locks first; legacy {operation} completes without deadlock')

        for operation in ['insert', 'update', 'delete']:
            for delete in [False, True]:
                observer.command(f'DELETE FROM public.user_ai_model_overrides WHERE {where};')
                if operation != 'insert':
                    assert observer.command(rpc('null', False))[-1] == 't'
                expected = snapshot()
                legacy, cas = session(), session()
                sql = (f"INSERT INTO public.user_ai_model_overrides(user_id,provider,model,reason) VALUES({literal(user)},{literal(provider)},'api-model','legacy');" if operation == 'insert'
                       else f"UPDATE public.user_ai_model_overrides SET reason='legacy' WHERE {where};" if operation == 'update'
                       else f'DELETE FROM public.user_ai_model_overrides WHERE {where};')
                legacy.command('BEGIN; ' + sql)
                pending = cas.start(rpc(expected, delete))
                wait_for_lock(cas, legacy)
                legacy.command('COMMIT;')
                assert cas.finish(pending)[-1] == 'f', 'CAS must refuse the stale snapshot'
                final = json.loads(snapshot())
                assert final is None if operation == 'delete' else final['reason'] == 'legacy'
                legacy.close()
                cas.close()
                print(f'PASS legacy {operation} wins over CAS {"delete" if delete else "save"}; stale CAS refused')

        # The inverse order must also serialize, including a legacy upsert's
        # BEFORE INSERT path when the CAS row already exists.
        observer.command(f'DELETE FROM public.user_ai_model_overrides WHERE {where};')
        cas, legacy = session(), session()
        cas.command('BEGIN; ' + rpc('null', False))
        pending = legacy.start(f"INSERT INTO public.user_ai_model_overrides(user_id,provider,model,reason) VALUES({literal(user)},{literal(provider)},'api-model','legacy') ON CONFLICT(user_id) DO UPDATE SET reason=EXCLUDED.reason;")
        wait_for_lock(legacy, cas)
        cas.command('COMMIT;')
        legacy.finish(pending)
        final = json.loads(snapshot())
        assert final['reason'] == 'legacy' and final['auth_method'] == 'api_key'
        print('PASS CAS wins first; later legacy upsert remains API')
    finally:
        for opened in reversed(sessions[1:]):
            opened.close()
        observer.close()
        cleanup = Session(args.container, args.database)
        try:
            cleanup.command(f"DELETE FROM public.user_ai_model_overrides WHERE {where}; DELETE FROM auth.users WHERE id IN ({literal(actor)},{literal(user)}); DELETE FROM public.ai_providers WHERE provider_code={literal(provider)};")
        finally:
            cleanup.close()
    print('ai_text_override_races: ALL CHECKS PASSED')


if __name__ == '__main__':
    main()
