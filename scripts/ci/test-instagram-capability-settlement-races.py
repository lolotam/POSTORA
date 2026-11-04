#!/usr/bin/env python3
"""Observe the Instagram capability-missing settlement racing a capability write.

Two real sessions in a labelled disposable Postgres (the 2026-11-04 design,
section 5.2):

  resolved_capability_wins
      Session A records an 'ok' permission read with
      write_instagram_account_capability and holds its transaction open.
      Session B calls complete_instagram_collection_job_capability_unavailable
      for the same account. B must be observed waiting on A's lock; when A
      commits, B is refused with IG_COLLECTION_CAPABILITY_RESOLVED (40001) and
      the job is exactly as it was, still leased.

  settlement_wins
      Session B settles the job inside an open transaction. Session A then
      writes the 'ok' read and must be observed waiting on B. When B commits
      the job is unavailable / capability_missing; A's write then lands (its
      generation still matches and its evidence is newer than the generation),
      and the job stays settled: a later claim does not re-open it.

The fixture is synthetic, owned through an advisory lock, admitted by an
owners allowlist that names only its own accounts, and removed at the end.
"""

from __future__ import annotations

import argparse
import json
import queue
import re
import subprocess
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path

ADVISORY_KEY = "hashtextextended('instagram_capability_settlement_races',0)"
SETTINGS_KEYS = ("collection_instagram_insights_enabled", "collection_instagram_rollout_policy")
DISPOSABLE_LABELS = {"postora-db-harness-ci", "postora-db-harness-local"}
SCRIPT_IN_CONTAINER = "/repo/scripts/ci/test-instagram-capability-settlement-races.py"
GRANTED_SCOPES = ["instagram_business_basic", "instagram_business_manage_insights"]


def quoted(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def json_sql(value: object) -> str:
    return quoted(json.dumps(value, separators=(",", ":"))) + "::jsonb"


class SqlFailure(RuntimeError):
    """A refused statement, with its SQLSTATE and its IG_COLLECTION_* name."""

    def __init__(self, lines: list[str]):
        self.lines = lines
        text = "\n".join(lines)
        coded = re.search(r"ERROR:\s+([A-Z0-9]{5}):\s*(.*)", text)
        self.code = coded.group(1) if coded else "unknown"
        named = re.match(r"(IG_COLLECTION_[A-Z_]+):", coded.group(2)) if coded else None
        self.name = named.group(1) if named else "unknown"
        super().__init__(f"SQL statement failed ({self.code} {self.name})")


class Session:
    def __init__(self, harness: "Harness", name: str, service: bool = False):
        self.name = harness.prefix + name
        self.output: queue.Queue[str | None] = queue.Queue()
        self.process = subprocess.Popen(
            harness.psql_argv(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, encoding="utf-8", bufsize=1,
        )
        threading.Thread(target=self._read_lines, daemon=True).start()
        self.command(
            f"SET application_name={quoted(self.name)}; "
            "SET statement_timeout='12s'; SET lock_timeout='10s'; "
            "SET request.jwt.claim.role='service_role'; "
            "SET request.jwt.claims='{\"role\":\"service_role\"}'; "
            + ("SET ROLE service_role;" if service else "")
        )
        self.pid = int(self.command("SELECT pg_backend_pid();")[-1])

    def _read_lines(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            self.output.put(line.rstrip("\r\n"))
        self.output.put(None)

    def start(self, sql: str) -> str:
        marker = "ig_settle_race_" + uuid.uuid4().hex
        assert self.process.stdin is not None
        self.process.stdin.write(sql + f"\nSELECT {quoted(marker)};\n")
        self.process.stdin.flush()
        return marker

    def finish(self, marker: str, timeout: float = 15) -> list[str]:
        deadline = time.monotonic() + timeout
        lines: list[str] = []
        while time.monotonic() < deadline:
            try:
                line = self.output.get(timeout=max(0.01, deadline - time.monotonic()))
            except queue.Empty as error:
                raise TimeoutError(f"SQL session {self.name} exceeded its observation deadline") from error
            if line is None:
                raise SqlFailure(lines)
            if line == marker:
                return [entry for entry in lines if entry]
            lines.append(line)
        raise TimeoutError(f"SQL session {self.name} exceeded its observation deadline")

    def command(self, sql: str) -> list[str]:
        return self.finish(self.start(sql))

    def value(self, sql: str) -> object:
        return json.loads(self.command(sql)[-1])

    def close(self) -> None:
        if self.process.poll() is None:
            assert self.process.stdin is not None
            try:
                self.process.stdin.write("ROLLBACK;\n\\q\n")
                self.process.stdin.flush()
                self.process.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                if self.process.poll() is None:
                    self.process.kill()
                self.process.wait(timeout=3)
        for pipe in (self.process.stdin, self.process.stdout):
            if pipe:
                try:
                    pipe.close()
                except BrokenPipeError:
                    # An expected refusal ends psql (ON_ERROR_STOP); disposing
                    # its buffered input must not hide the verified result.
                    pass


class Harness:
    def __init__(self, database: str):
        require_database(database)
        self.database = database
        self.prefix = "ig_settle_race_" + uuid.uuid4().hex[:10] + "_"
        self.sessions: list[Session] = []
        self.owner = str(uuid.uuid4())
        # One account per scenario, so each scenario starts from its own
        # unknown capability and its own freshly claimed job.
        self.accounts = {"resolved_capability_wins": str(uuid.uuid4()),
                         "settlement_wins": str(uuid.uuid4())}
        self.claims: dict[str, dict[str, object]] = {}
        self.results: list[dict[str, object]] = []
        self.settings: dict[str, object] | None = None
        self.fixture_written = False
        self.admin = self.session("observer")
        if self.admin.command(f"SELECT pg_try_advisory_lock({ADVISORY_KEY});")[-1] != "t":
            raise RuntimeError("Another settlement race runner owns the disposable fixture")

    def psql_argv(self) -> list[str]:
        return ["psql", "-h", "/var/run/postgresql", "-X", "-qAt", "-U", "supabase_admin", "-d", self.database,
                "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-f", "-"]

    def session(self, name: str, service: bool = False) -> Session:
        opened = Session(self, name, service)
        self.sessions.append(opened)
        return opened

    def observe_wait(self, blocked: Session, blocker: Session) -> dict[str, object]:
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            observed = self.admin.value(
                "SELECT COALESCE((SELECT jsonb_build_object('pid',pid,'state',state,"
                "'wait_event_type',wait_event_type,'blockers',pg_blocking_pids(pid)) "
                f"FROM pg_stat_activity WHERE pid={blocked.pid} AND datname=current_database()),'null'::jsonb);"
            )
            if observed and observed["wait_event_type"] == "Lock" and blocker.pid in observed["blockers"]:
                return observed
            if blocked.process.poll() is not None:
                raise RuntimeError("Contender exited before an actual lock wait was observed")
            time.sleep(0.025)
        raise AssertionError("Expected database lock wait was not observed")

    # -- the fixture ---------------------------------------------------------

    def setup(self) -> None:
        keys = ",".join(map(quoted, SETTINGS_KEYS))
        captured = self.admin.value(
            "SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb) "
            f"FROM public.app_settings WHERE key IN ({keys});")
        if not isinstance(captured, dict):
            raise RuntimeError("The rollout settings could not be captured")
        # An absent key is restored as absent.
        self.settings = {key: captured.get(key) for key in SETTINGS_KEYS}

        policy = {"version": 1,
                  "owners": {"mode": "allowlist", "account_ids": sorted(self.accounts.values())},
                  "competitors": {"mode": "off", "targets": []}}
        accounts = ",".join(
            f"({quoted(account)},{quoted(self.owner)},'instagram',{quoted('ig-settle-race-' + account[:8])},"
            f"{quoted('igsettlerace_' + account[:8])},'synthetic-settle-race-token',true,false,'business_login')"
            for account in self.accounts.values())
        bumps = " ".join(
            f"SELECT public.meta_oauth_attempt_bump_instagram_capability({quoted(self.owner)},{quoted(account)},'direct','created');"
            for account in self.accounts.values())
        jobs = ",".join(
            f"({quoted(self.owner)},'owner',{quoted(account)},{quoted(account)},current_date)"
            for account in self.accounts.values())
        self.fixture_written = True
        self.admin.command(
            "BEGIN; "
            f"INSERT INTO auth.users(id,email) VALUES({quoted(self.owner)},{quoted('igsettle-race-' + self.owner + '@example.invalid')}); "
            "INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,platform_username,"
            f"access_token,is_active,needs_reauth,ig_auth_type) VALUES {accounts}; "
            f"{bumps} "
            f"INSERT INTO public.instagram_collection_jobs(user_id,target_kind,target_id,social_account_id,captured_on) VALUES {jobs}; "
            "INSERT INTO public.app_settings(key,value,description) VALUES "
            "('collection_instagram_insights_enabled','true'::jsonb,'Synthetic settlement race master switch.'),"
            f"('collection_instagram_rollout_policy',{json_sql(policy)},'Synthetic settlement race policy.') "
            "ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value; "
            "COMMIT;"
        )

        claimer = self.session("claimer", service=True)
        claimed = claimer.value("SELECT COALESCE(jsonb_agg(c),'[]'::jsonb) "
                                "FROM public.claim_instagram_collection_jobs('owner',25) AS c;")
        claimer.close()
        by_account = {claim["social_account_id"]: claim for claim in claimed}
        if set(by_account) != set(self.accounts.values()):
            raise AssertionError("The claim must lease exactly the synthetic jobs, got " + json.dumps(sorted(by_account)))
        for scenario, account in self.accounts.items():
            self.claims[scenario] = by_account[account]
            job = self.job(account)
            if (job["status"] != "leased" or job["context_viewer_social_account_id"] != account
                    or job["context_credential_generation"] != 1 or job["context_login_kind"] != "direct"):
                raise AssertionError("A synthetic job is not leased with a bound direct context")
            capability = self.capability(account)
            if capability["permission_read_state"] != "unknown" or capability["credential_generation"] != 1:
                raise AssertionError("A synthetic capability is not unknown on generation 1")

    def job(self, account: str) -> dict[str, object]:
        return self.admin.value(f"SELECT to_jsonb(j) FROM public.instagram_collection_jobs AS j WHERE j.social_account_id={quoted(account)};")

    def capability(self, account: str) -> dict[str, object]:
        return self.admin.value(f"SELECT to_jsonb(c) FROM public.instagram_account_capabilities AS c WHERE c.social_account_id={quoted(account)};")

    @staticmethod
    def claim_args(claim: dict[str, object]) -> str:
        return ",".join([quoted(claim["job_id"]), quoted(claim["claim_token"]), str(claim["job_generation"])])

    def settle_sql(self, scenario: str) -> str:
        return f"SELECT public.complete_instagram_collection_job_capability_unavailable({self.claim_args(self.claims[scenario])});"

    def write_ok_sql(self, account: str) -> str:
        # The evidence is read now, after the fixture committed the
        # generation, so it is newer than credential_updated_at (no ICG02).
        payload = ("jsonb_build_object('login_kind','direct','permission_read_state','ok',"
                   f"'granted_scopes',{json_sql(GRANTED_SCOPES)},"
                   "'scopes_read_at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),"
                   "'expected_credential_generation',1)")
        return f"SELECT public.write_instagram_account_capability({quoted(account)},{quoted(self.owner)},{payload});"

    def record(self, scenario: str, wait: dict[str, object]) -> None:
        self.results.append({"scenario": scenario, "ok": True, "observed_wait": wait})
        print(f"PASS {scenario}", flush=True)

    # -- the scenarios -------------------------------------------------------

    def resolved_capability_wins(self) -> None:
        scenario = "resolved_capability_wins"
        account = self.accounts[scenario]
        job_before = self.job(account)
        writer = self.session("capability_writer", service=True)
        settler = self.session("settler", service=True)
        written = json.loads(writer.command("BEGIN; " + self.write_ok_sql(account))[-1])
        if written["permission_read_state"] != "ok":
            raise AssertionError("The held capability write did not record an ok read")
        marker = settler.start(self.settle_sql(scenario))
        observed = self.observe_wait(settler, writer)
        writer.command("COMMIT;")
        try:
            settler.finish(marker)
        except SqlFailure as error:
            if error.code != "40001" or error.name != "IG_COLLECTION_CAPABILITY_RESOLVED":
                raise AssertionError(f"Expected 40001 IG_COLLECTION_CAPABILITY_RESOLVED, got {error.code} {error.name}") from error
        else:
            raise AssertionError("The settlement settled a job whose evidence landed first")
        if self.job(account) != job_before:
            raise AssertionError("The refused settlement changed the job")
        capability = self.capability(account)
        if (capability["permission_read_state"] != "ok" or capability["credential_generation"] != 1
                or capability["granted_scopes"] != GRANTED_SCOPES):
            raise AssertionError("The capability is not the one the committed writer recorded")
        writer.close()
        settler.close()
        self.record(scenario, observed)

    def settlement_wins(self) -> None:
        scenario = "settlement_wins"
        account = self.accounts[scenario]
        claim = self.claims[scenario]
        job_before = self.job(account)
        settler = self.session("settler", service=True)
        writer = self.session("capability_writer", service=True)
        settled = json.loads(settler.command("BEGIN; " + self.settle_sql(scenario))[-1])
        if settled != {"job_id": claim["job_id"], "job_generation": claim["job_generation"],
                       "status": "unavailable", "outcome": "unavailable", "reason_code": "capability_missing"}:
            raise AssertionError("Unexpected settlement answer: " + json.dumps(settled))
        marker = writer.start(self.write_ok_sql(account))
        observed = self.observe_wait(writer, settler)
        settler.command("COMMIT;")
        written = json.loads(writer.finish(marker)[-1])
        if written["permission_read_state"] != "ok" or int(written["credential_generation"]) != 1:
            raise AssertionError("The capability write behind the settlement did not land: " + json.dumps(written))
        job_after = self.job(account)
        if (job_after["status"] != "unavailable" or job_after["last_reason_code"] != "capability_missing"
                or job_after["lease_token"] is not None or job_after["lease_expires_at"] is not None
                or job_after["retry_at"] is not None):
            raise AssertionError("The settled job is not unavailable / capability_missing: " + json.dumps(job_after))
        for column in ("job_generation", "attempts", "due_at", "last_success_at", "last_partial_at"):
            if job_after[column] != job_before[column]:
                raise AssertionError(f"The settlement changed {column}")
        capability = self.capability(account)
        if capability["permission_read_state"] != "ok" or capability["credential_generation"] != 1:
            raise AssertionError("The capability is not the one the writer recorded")
        # Recorded evidence does not re-open a settled job.
        claimer = self.session("reclaimer", service=True)
        reclaimed = claimer.value("SELECT COALESCE(jsonb_agg(c),'[]'::jsonb) "
                                  "FROM public.claim_instagram_collection_jobs('owner',25) AS c;")
        claimer.close()
        if any(entry["job_id"] == claim["job_id"] for entry in reclaimed):
            raise AssertionError("A later claim re-opened the settled job")
        if self.job(account) != job_after:
            raise AssertionError("The settled job changed after the capability write")
        settler.close()
        writer.close()
        self.record(scenario, observed)

    # -- cleanup -------------------------------------------------------------

    def cleanup(self) -> None:
        for session in reversed(self.sessions[1:]):
            session.close()
        if self.admin.process.poll() is not None:
            self.admin = self.session("cleanup_recovery")
            if self.admin.command(f"SELECT pg_try_advisory_lock({ADVISORY_KEY});")[-1] != "t":
                raise RuntimeError("Cleanup refused while another settlement race runner owns the fixture")
        parts = ["BEGIN;"]
        if self.fixture_written:
            accounts = ",".join(map(quoted, self.accounts.values()))
            parts += [
                "DELETE FROM public.instagram_collection_job_operations WHERE job_id IN "
                f"(SELECT id FROM public.instagram_collection_jobs WHERE social_account_id IN ({accounts}));",
                "DELETE FROM public.instagram_collection_job_checkpoints WHERE job_id IN "
                f"(SELECT id FROM public.instagram_collection_jobs WHERE social_account_id IN ({accounts}));",
                f"DELETE FROM public.instagram_collection_jobs WHERE social_account_id IN ({accounts});",
                f"DELETE FROM public.instagram_account_capabilities WHERE social_account_id IN ({accounts});",
                f"DELETE FROM public.social_accounts WHERE id IN ({accounts});",
                f"DELETE FROM auth.users WHERE id={quoted(self.owner)};",
            ]
        if self.settings is not None:
            for key, value in self.settings.items():
                if value is None:
                    parts.append(f"DELETE FROM public.app_settings WHERE key={quoted(key)};")
                else:
                    parts.append(f"UPDATE public.app_settings SET value={json_sql(value)} WHERE key={quoted(key)};")
        parts.append("COMMIT;")
        self.admin.command(" ".join(parts))
        left = self.admin.command(
            f"SELECT count(*) FROM public.social_accounts WHERE user_id={quoted(self.owner)};")[-1]
        if left != "0":
            raise AssertionError("The synthetic accounts survived the cleanup")
        self.admin.close()

    def run(self) -> list[dict[str, object]]:
        try:
            self.setup()
            self.resolved_capability_wins()
            self.settlement_wins()
            return self.results
        finally:
            self.cleanup()


def require_database(database: str) -> None:
    if not re.fullmatch(r"[a-z][a-z0-9_]*_harness", database):
        raise ValueError("A disposable database name ending in _harness is required")


def inspected_container(args: argparse.Namespace) -> str:
    require_database(args.database)
    inspected = subprocess.run(
        [args.docker, "container", "inspect", args.container],
        check=True, capture_output=True, text=True, timeout=10,
    )
    container = json.loads(inspected.stdout)[0]
    label = (container.get("Config", {}).get("Labels") or {}).get("postora.task")
    if label not in DISPOSABLE_LABELS or not container.get("State", {}).get("Running"):
        raise ValueError("Container lacks the explicit disposable Postora harness label")
    if label == "postora-db-harness-ci" and args.container != "pg-harness":
        raise ValueError("CI disposable label requires the pg-harness container")
    return container["Id"]


def run_local(database: str) -> int:
    # Only the validated outer driver invokes this in the container's local
    # socket namespace. All SQL sessions share one Docker exec process.
    report: dict[str, object] = {"ok": False, "cases": []}
    try:
        launcher = subprocess.run(
            ["psql", "-h", "/var/run/postgresql", "-X", "-At", "-U", "supabase_admin", "-d", database,
             "-v", "ON_ERROR_STOP=1", "-c", "SHOW cron.launch_active_jobs"],
            check=True, capture_output=True, text=True, timeout=10,
        )
        if launcher.stdout.strip() != "off":
            raise ValueError("Disposable PostgreSQL must disable cron.launch_active_jobs before race setup")
        harness = Harness(database)
        report["cases"] = harness.results
        harness.run()
        report["ok"] = True
    except (AssertionError, RuntimeError, ValueError, OSError, subprocess.SubprocessError) as error:
        report["error"] = f"{type(error).__name__}: {error}"
        traceback.print_exception(error, file=sys.stderr)
    print(json.dumps(report, separators=(",", ":")), flush=True)
    return 0 if report["ok"] else 1


def run_container(args: argparse.Namespace) -> dict[str, object]:
    container_id = inspected_container(args)
    driver = (
        "import runpy,sys; "
        f"module=runpy.run_path({SCRIPT_IN_CONTAINER!r},run_name='ig_settlement_races'); "
        "raise SystemExit(module['run_local'](sys.argv[1]))"
    )
    completed = subprocess.run(
        [args.docker, "container", "exec", container_id, "python3", "-c", driver, args.database],
        capture_output=True, text=True, timeout=120,
    )
    lines = completed.stdout.splitlines()
    if completed.stderr:
        print(completed.stderr, end="", file=sys.stderr)
    if not lines:
        raise RuntimeError("Container race runner returned no report; Python3 must be installed in the disposable image")
    for line in lines[:-1]:
        print(line, flush=True)
    report = json.loads(lines[-1])
    if not isinstance(report, dict) or report.get("ok") is not (completed.returncode == 0):
        raise RuntimeError("Container exit and race report disagree")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--container", required=True)
    parser.add_argument("--database", required=True)
    parser.add_argument("--docker", default="docker")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    report: dict[str, object] = {"ok": False, "cases": []}
    try:
        report = run_container(args)
    except (AssertionError, RuntimeError, ValueError, OSError, subprocess.SubprocessError) as error:
        report["error"] = f"{type(error).__name__}: {error}"
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, separators=(",", ":")), flush=True)
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
