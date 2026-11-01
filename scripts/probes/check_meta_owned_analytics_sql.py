#!/usr/bin/env python3
"""Exercise the probe's actual SQL lookup against a disposable migrated local database."""
import argparse
import json
import os
import subprocess
import urllib.parse

import meta_owned_analytics as probe

OWNER = "9f010000-0000-4000-8000-000000000001"
FOREIGN_OWNER = "9f010000-0000-4000-8000-000000000002"
ACCOUNTS = [f"9f020000-0000-4000-8000-{number:012d}" for number in range(1, 6)]


def sql(container, database, statement):
    completed = subprocess.run(["docker", "exec", "-i", container, "psql", "-U", "postgres", "-d", database,
                                "-X", "-qAt", "-v", "ON_ERROR_STOP=1"], input=statement,
                               capture_output=True, text=True, timeout=20, check=True)
    return completed.stdout.strip()


def verify_disposable(container):
    override = os.environ.get("DOCKER_HOST")
    if override and urllib.parse.urlsplit(override).scheme not in ("unix", "npipe"):
        raise RuntimeError("SQL probe regression refuses a remote Docker override")
    context = json.loads(subprocess.check_output(["docker", "context", "inspect"], text=True))
    endpoint = context[0]["Endpoints"]["docker"]["Host"]
    if urllib.parse.urlsplit(endpoint).scheme not in ("unix", "npipe"):
        raise RuntimeError("SQL probe regression requires a local Docker socket")
    inspected = json.loads(subprocess.check_output(["docker", "inspect", container], text=True))[0]
    if not inspected["Config"]["Image"].startswith("supabase/postgres:"):
        raise RuntimeError("SQL probe regression requires the migrated harness image")
    if container == "postora-owner-release-pg":
        labels = inspected["Config"].get("Labels") or {}
        if labels.get("project") != "postora" or labels.get("purpose") != "owner-release-test":
            raise RuntimeError("Disposable owner fixture labels do not match")
    elif container != "pg-harness":
        raise RuntimeError("SQL probe regression refuses a shared container")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container", required=True, choices=["postora-owner-release-pg", "pg-harness"])
    parser.add_argument("--database", required=True, choices=["postora_owner_release_harness", "partner_api_harness"])
    args = parser.parse_args()
    verify_disposable(args.container)
    existing = sql(args.container, args.database, f"""SELECT
        (SELECT count(*) FROM auth.users WHERE id IN ('{OWNER}', '{FOREIGN_OWNER}')) +
        (SELECT count(*) FROM public.social_accounts WHERE id IN ({','.join(repr(account) for account in ACCOUNTS)}));""")
    if existing != "0":
        raise RuntimeError("Refusing to overwrite existing SQL regression fixtures")
    sql(args.container, args.database, f"""BEGIN;
        INSERT INTO auth.users(id,email) VALUES ('{OWNER}','probe-sql-owner@example.test'), ('{FOREIGN_OWNER}','probe-sql-other@example.test');
        INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,access_token,is_active) VALUES
          ('{ACCOUNTS[0]}','{OWNER}','threads','probe_owner','synthetic-probe-token',true),
          ('{ACCOUNTS[1]}','{FOREIGN_OWNER}','threads','probe_foreign','synthetic-foreign-token',true),
          ('{ACCOUNTS[2]}','{OWNER}','threads','probe_inactive','synthetic-inactive-token',false),
          ('{ACCOUNTS[3]}','{OWNER}','facebook','probe_facebook','synthetic-facebook-token',true);
        COMMIT;""")
    try:
        probe.DB_CONTAINER, probe.DB_DATABASE = args.container, args.database
        owned = probe.read_account(OWNER, ACCOUNTS[0], "threads")
        if owned != {"platform_user_id": "probe_owner", "access_token": "synthetic-probe-token"}:
            raise AssertionError("Owned lookup did not return its exact synthetic account")
        for account in ACCOUNTS[1:]:
            try:
                probe.read_account(OWNER, account, "threads")
            except RuntimeError as refused:
                if str(refused) != "Approved account not found":
                    raise
            else:
                raise AssertionError("Foreign/inactive/wrong-platform/nonexistent account was substituted")
        print("Actual probe SQL: owned lookup and four non-enumerating refusals passed. No provider calls.")
    finally:
        sql(args.container, args.database, f"""BEGIN;
            DELETE FROM public.social_accounts WHERE user_id IN ('{OWNER}', '{FOREIGN_OWNER}');
            DELETE FROM auth.users WHERE id IN ('{OWNER}', '{FOREIGN_OWNER}'); COMMIT;""")


if __name__ == "__main__":
    main()
