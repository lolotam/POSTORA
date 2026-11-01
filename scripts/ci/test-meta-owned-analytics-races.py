#!/usr/bin/env python3
"""Observe real Meta-history transaction races in a labelled disposable Postgres."""

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
from dataclasses import dataclass
from pathlib import Path


def quoted(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def json_sql(value: object) -> str:
    return quoted(json.dumps(value, separators=(",", ":"))) + "::jsonb"


class SqlFailure(RuntimeError):
    def __init__(self, lines: list[str]):
        self.lines = lines
        matched = re.search(r"ERROR:\s+([A-Z0-9]{5}):", "\n".join(lines))
        self.code = matched.group(1) if matched else "unknown"
        super().__init__(f"SQL statement failed ({self.code})")


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
        marker = "meta_race_" + uuid.uuid4().hex
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
                    # Expected SQL refusals terminate psql; disposing its
                    # buffered input must not hide the verified result.
                    pass


@dataclass(frozen=True)
class Platform:
    name: str
    family: str
    account: str
    provider: str
    metric: str
    daily_table: str


class Harness:
    def __init__(self, database: str):
        require_database(database)
        self.database = database
        self.prefix = "meta_history_race_" + uuid.uuid4().hex[:10] + "_"
        self.sessions: list[Session] = []
        self.owner = str(uuid.uuid4())
        self.credential = str(uuid.uuid4())
        self.platforms = [
            Platform("facebook", "fb", str(uuid.uuid4()), "97" + str(uuid.uuid4().int)[:12], "views", "fb_page_insight_daily"),
            Platform("threads", "threads", str(uuid.uuid4()), "98" + str(uuid.uuid4().int)[:12], "profile_views", "threads_account_insight_daily"),
        ]
        self.results: list[dict[str, object]] = []
        self.settings: dict[str, object] = {}
        self.admin = self.session("observer")
        if self.admin.command("SELECT pg_try_advisory_lock(hashtextextended('meta_owned_analytics_races',0));")[-1] != "t":
            raise RuntimeError("Another Meta-history race runner owns the disposable fixture")

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

    def settings_key(self, platform: Platform, suffix: str, kind: str = "collection") -> str:
        return f"{kind}_{platform.name}_analytics_{suffix}"

    def enable(self, platform: Platform) -> None:
        for kind in ("collection", "retention"):
            for suffix, value in (("enabled", True), ("policy", {"account_ids": [platform.account]})):
                self.admin.command(f"UPDATE public.app_settings SET value={json_sql(value)} WHERE key={quoted(self.settings_key(platform,suffix,kind))};")

    def setup(self) -> None:
        keys = [self.settings_key(p, suffix, kind) for p in self.platforms
                for kind in ("collection", "retention") for suffix in ("enabled", "policy")]
        self.settings = self.admin.value("SELECT jsonb_object_agg(key,value) FROM public.app_settings WHERE key IN (" + ",".join(map(quoted, keys)) + ");")
        if not isinstance(self.settings, dict) or set(self.settings) != set(keys):
            raise RuntimeError("Candidate settings are missing; apply the complete migration first")
        accounts = ",".join(
            f"({quoted(p.account)},{quoted(self.owner)},{quoted(p.name)},{quoted(p.provider)},'meta-race','synthetic-race-token',true,false)"
            for p in self.platforms
        )
        fb = self.platforms[0]
        self.admin.command(
            "BEGIN; INSERT INTO auth.users(id,email) VALUES(" + quoted(self.owner) + ","
            + quoted("meta-race-" + self.owner + "@example.invalid") + "); "
            "INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,platform_username,access_token,is_active,needs_reauth) VALUES " + accounts + "; "
            "INSERT INTO public.facebook_user_credentials(id,user_id,token,provider_user_id,provenance_source,provenance_captured_at) VALUES("
            + ",".join([quoted(self.credential), quoted(self.owner), "'synthetic-race-user-token'", "'96000001'", "'oauth_exchange'", "clock_timestamp()"]) + "); "
            f"INSERT INTO public.facebook_user_credential_connection_fences(social_account_id,user_id,platform) VALUES({quoted(fb.account)},{quoted(self.owner)},'facebook'); "
            "INSERT INTO public.facebook_user_credential_bindings(social_account_id,user_id,platform,credential_id,verified_facebook_user_id,evidence_source) VALUES("
            + ",".join([quoted(fb.account), quoted(self.owner), "'facebook'", quoted(self.credential), "'96000001'", "'oauth_exchange'"]) + "); COMMIT;"
        )
        self.calendar = self.admin.value(
            "SELECT jsonb_build_object('due_on',(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date,"
            "'metric_date',(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date-1,"
            "'since',((clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date-7)::timestamp AT TIME ZONE 'America/Los_Angeles',"
            "'until',(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date::timestamp AT TIME ZONE 'America/Los_Angeles',"
            "'floor',((clock_timestamp() AT TIME ZONE 'UTC')::date-365)::timestamp AT TIME ZONE 'UTC',"
            "'old_date',(clock_timestamp() AT TIME ZONE 'UTC')::date-367);"
        )
        for platform in self.platforms:
            self.enable(platform)
            self.refresh_permissions(platform)

    def refresh_permissions(self, platform: Platform) -> None:
        self.admin.command(f"UPDATE public.social_accounts SET needs_reauth=false WHERE id={quoted(platform.account)};")
        authority = self.admin.value(f"SELECT public.prepare_{platform.family}_analytics_account({quoted(self.owner)},{quoted(platform.account)});")["authority"]
        scopes = ["read_insights", "pages_read_engagement"] if platform.name == "facebook" else ["threads_basic", "threads_manage_insights"]
        self.admin.command(f"SELECT public.observe_{platform.family}_analytics_permissions({quoted(self.owner)},{quoted(platform.account)},{json_sql(authority)},"
                           f"ARRAY[{','.join(map(quoted,scopes))}],{quoted(platform.provider)},clock_timestamp(),'verified');")

    def claim(self, platform: Platform) -> dict[str, object]:
        self.enable(platform)
        self.refresh_permissions(platform)
        self.admin.command(f"SELECT public.enqueue_{platform.family}_analytics_collection_job({quoted(self.owner)},{quoted(platform.account)},{quoted(self.calendar['due_on'])},true);")
        claimed = self.admin.value(f"SELECT public.claim_{platform.family}_analytics_collection_jobs(1);")
        if len(claimed) != 1 or claimed[0]["account_id"] != platform.account:
            raise AssertionError("Exactly the synthetic eligible target must be claimed")
        return claimed[0]

    def capture(self, platform: Platform, claim: dict[str, object]) -> dict[str, object]:
        request = {"kind": "account_day", "subject_id": platform.provider,
                   "metric_date": self.calendar["metric_date"], "metrics": [platform.metric]}
        return self.admin.value(f"SELECT public.reserve_{platform.family}_analytics_capture({self.claim_args(claim)},'race:day',{json_sql(request)});")

    @staticmethod
    def claim_args(claim: dict[str, object]) -> str:
        return ",".join([quoted(claim["job_id"]), quoted(claim["claim_token"]), str(claim["job_generation"])])

    def persist_sql(self, platform: Platform, claim: dict[str, object], capture: dict[str, object], value: int) -> str:
        metrics = {platform.metric: {"status": "available", "value": value}}
        return ("WITH observed AS MATERIALIZED (SELECT clock_timestamp() AS at) "
                f"SELECT public.persist_{platform.family}_analytics_capture({self.claim_args(claim)},{quoted(capture['capture_id'])},"
                f"jsonb_build_object('metrics',{json_sql(metrics)},'received_at',at,'observed_at',at)) FROM observed;")

    def revision(self, platform: Platform) -> int:
        return int(self.admin.command(f"SELECT report_revision FROM public.{platform.family}_analytics_report_state WHERE social_account_id={quoted(platform.account)};")[-1])

    def report(self, platform: Platform, expected: int | None = None) -> dict[str, object]:
        request = {"since": self.calendar["since"], "until": self.calendar["until"]}
        if expected is not None:
            request.update(expected_revision=expected, after_published_at=self.calendar["until"], after_id="race_cursor")
        return self.admin.value(f"SELECT public.read_{platform.family}_analytics_history({quoted(self.owner)},{quoted(platform.account)},{json_sql(request)});")

    def record(self, platform: Platform, scenario: str, wait: dict[str, object] | None = None) -> None:
        self.results.append({"platform": platform.name, "scenario": scenario, "ok": True, "observed_wait": wait})
        print(f"PASS {platform.name}: {scenario}", flush=True)

    def expect_refusal(self, session: Session, marker: str, codes: set[str]) -> None:
        try:
            session.finish(marker)
        except SqlFailure as error:
            if error.code in codes:
                return
            raise
        raise AssertionError("Stale/excluded operation unexpectedly succeeded")

    def exclusion_race(self, platform: Platform, suffix: str, exclusion_first: bool) -> None:
        claim = self.claim(platform)
        capture = self.capture(platform, claim)
        before = self.revision(platform)
        holder = self.session("exclude_holder")
        contender = self.session("exclude_contender", service=exclusion_first)
        excluded = False if suffix == "enabled" else {"account_ids": []}
        update = f"UPDATE public.app_settings SET value={json_sql(excluded)} WHERE key={quoted(self.settings_key(platform,suffix))};"
        holder.command("BEGIN; " + (update if exclusion_first else self.persist_sql(platform, claim, capture, 101)))
        marker = contender.start(self.persist_sql(platform, claim, capture, 101) if exclusion_first else update)
        observed = self.observe_wait(contender, holder)
        holder.command("COMMIT;")
        if exclusion_first:
            self.expect_refusal(contender, marker, {"MAH03"})
            if self.revision(platform) != before:
                raise AssertionError("Excluded write changed report revision")
        else:
            contender.finish(marker)
            if self.revision(platform) <= before:
                raise AssertionError("Accepted pre-exclusion write was lost")
            refused = self.session("post_exclusion", service=True)
            self.expect_refusal(refused, refused.start(self.persist_sql(platform, claim, capture, 101)), {"MAH03"})
            refused.close()
        holder.close()
        contender.close()
        self.enable(platform)
        self.record(platform, f"{suffix}:" + ("exclusion_before_write" if exclusion_first else "write_before_exclusion"), observed)

    def rotate_sql(self, platform: Platform) -> str:
        locking = f"SELECT id FROM public.social_accounts WHERE id={quoted(platform.account)} FOR UPDATE;"
        if platform.name == "facebook":
            locking += f"SELECT pg_advisory_xact_lock(hashtext('social_account_guard:'||{quoted(platform.account)}));"
            locking += f"SELECT pg_advisory_xact_lock(hashtext('instagram_capability:'||{quoted(platform.account)}));"
            locking += f"SELECT public.facebook_user_credential_commit_connection_version({quoted(self.owner)},{quoted(platform.account)},"
            locking += f"(SELECT connection_version FROM public.facebook_user_credential_connection_fences WHERE social_account_id={quoted(platform.account)}));"
        return locking + f"UPDATE public.social_accounts SET access_token={quoted('synthetic-rotation-'+uuid.uuid4().hex)} WHERE id={quoted(platform.account)};"

    def credential_race(self, platform: Platform, rotation_first: bool) -> None:
        claim = self.claim(platform)
        capture = self.capture(platform, claim)
        before = self.revision(platform)
        holder = self.session("credential_holder")
        contender = self.session("credential_contender", service=rotation_first)
        write = self.persist_sql(platform, claim, capture, 202)
        rotation = self.rotate_sql(platform)
        holder.command("BEGIN; " + (rotation if rotation_first else write))
        marker = contender.start(write if rotation_first else rotation)
        observed = self.observe_wait(contender, holder)
        holder.command("COMMIT;")
        if rotation_first:
            self.expect_refusal(contender, marker, {"MAH03", "MAH04"})
            if self.revision(platform) != before:
                raise AssertionError("Credential-stale result changed history")
        else:
            contender.finish(marker)
            if self.revision(platform) <= before or not self.report(platform)["ok"]:
                raise AssertionError("A later reconnect invalidated accepted historical data")
        holder.close()
        contender.close()
        self.refresh_permissions(platform)
        self.record(platform, "credential_before_write" if rotation_first else "write_before_credential", observed)

    def old_envelope(self, platform: Platform) -> str:
        row_id = str(uuid.uuid4())
        date = quoted(self.calendar["old_date"])
        self.admin.command(f"INSERT INTO public.{platform.daily_table}(id,user_id,social_account_id,metric_date,period_start,period_end,provider_timezone) "
                           f"VALUES({quoted(row_id)},{quoted(self.owner)},{quoted(platform.account)},{date},{date}::date::timestamp AT TIME ZONE 'America/Los_Angeles',"
                           f"({date}::date+1)::timestamp AT TIME ZONE 'America/Los_Angeles','America/Los_Angeles');")
        return row_id

    def cleanup_sql(self, platform: Platform) -> str:
        return f"SELECT public.cleanup_{platform.family}_analytics_history({quoted(self.owner)},{quoted(platform.account)},{quoted(self.calendar['floor'])},500,false);"

    def retention_races(self, platform: Platform) -> None:
        claim = self.claim(platform)
        self.admin.command(f"SELECT public.complete_{platform.family}_analytics_collection_job({self.claim_args(claim)},'partial');")
        old_id = self.old_envelope(platform)
        holder = self.session("claim_holder", service=True)
        contender = self.session("retention_contender", service=True)
        held = json.loads(holder.command(f"BEGIN; SELECT public.claim_{platform.family}_analytics_collection_jobs(1);")[-1])
        if len(held) != 1:
            raise AssertionError("Synthetic target was not claimed")
        marker = contender.start(self.cleanup_sql(platform))
        observed = self.observe_wait(contender, holder)
        holder.command("COMMIT;")
        cleanup = json.loads(contender.finish(marker)[-1])
        remains = self.admin.command(f"SELECT EXISTS(SELECT 1 FROM public.{platform.daily_table} WHERE id={quoted(old_id)});")[-1]
        if not cleanup["skipped"] or cleanup["deleted"] != 0 or remains != "t":
            raise AssertionError("Retention deleted data while a collection lease was live")
        holder.close()
        contender.close()
        self.record(platform, "claim_before_retention_skips_live_lease", observed)

        self.admin.command(f"SELECT public.complete_{platform.family}_analytics_collection_job({self.claim_args(held[0])},'partial');")
        before = self.report(platform)
        holder = self.session("cleanup_holder", service=True)
        holder.command("BEGIN; " + self.cleanup_sql(platform))
        contender = self.session("busy_claim", service=True)
        if contender.value(f"SELECT public.claim_{platform.family}_analytics_collection_jobs(1);") != []:
            raise AssertionError("Claim entered a target whose cleanup transaction holds its parent")
        during = self.report(platform)
        if during["revision"] != before["revision"]:
            raise AssertionError("Uncommitted cleanup leaked a new report revision")
        holder.command("COMMIT;")
        after = self.report(platform, before["revision"])
        if after.get("reason") != "history_revision_changed":
            raise AssertionError("Cleanup did not explicitly invalidate the previous revision cursor")
        holder.close()
        contender.close()
        self.record(platform, "cleanup_excludes_claim_and_invalidates_report_revision")

    def report_write_race(self, platform: Platform) -> None:
        claim = self.claim(platform)
        capture = self.capture(platform, claim)
        before = self.report(platform)
        holder = self.session("report_writer", service=True)
        holder.command("BEGIN; " + self.persist_sql(platform, claim, capture, 303))
        during = self.report(platform)
        if during["revision"] != before["revision"] or during["daily"] != before["daily"]:
            raise AssertionError("Report mixed committed revision with uncommitted measurements")
        holder.command("COMMIT;")
        after = self.report(platform, before["revision"])
        if after.get("reason") != "history_revision_changed":
            raise AssertionError("Accepted write did not invalidate the previous revision cursor")
        holder.close()
        self.record(platform, "report_snapshot_and_write_cursor_invalidation")

    def cleanup(self) -> None:
        for session in reversed(self.sessions[1:]):
            session.close()
        if self.admin.process.poll() is not None:
            self.admin = self.session("cleanup_recovery")
            if self.admin.command("SELECT pg_try_advisory_lock(hashtextextended('meta_owned_analytics_races',0));")[-1] != "t":
                raise RuntimeError("Cleanup refused while another race runner owns the fixture")
        if self.settings:
            restore = " ".join(f"UPDATE public.app_settings SET value={json_sql(value)} WHERE key={quoted(key)};" for key, value in self.settings.items())
            self.admin.command("BEGIN; " + restore + f"DELETE FROM auth.users WHERE id={quoted(self.owner)}; COMMIT;")
        self.admin.close()

    def run(self) -> list[dict[str, object]]:
        try:
            self.setup()
            for platform in self.platforms:
                for suffix in ("enabled", "policy"):
                    for exclusion_first in (True, False):
                        self.exclusion_race(platform, suffix, exclusion_first)
                for rotation_first in (True, False):
                    self.credential_race(platform, rotation_first)
                self.retention_races(platform)
                self.report_write_race(platform)
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
    if label not in {"meta-analytics-history-c2", "postora-db-harness-ci"} or not container.get("State", {}).get("Running"):
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
        "module=runpy.run_path('/repo/scripts/ci/test-meta-owned-analytics-races.py',run_name='meta_history_races'); "
        "raise SystemExit(module['run_local'](sys.argv[1]))"
    )
    completed = subprocess.run(
        [args.docker, "container", "exec", container_id, "python3", "-c", driver, args.database],
        capture_output=True, text=True, timeout=180,
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
    parser = argparse.ArgumentParser(description=__doc__)
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
